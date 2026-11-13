import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { saveTlsPin } from "../src/providers/tls-pin.ts";
import { generations, holds, providers as providersTable } from "../src/db/schema.ts";
import { attestationRefOf, parseCouncilSpec } from "../src/router/council.ts";

// Attested council and attested dual verification. The providers here are development-attested mocks (tee "dev"), which
// the harness accepts because it runs outside production; a production router refuses dev evidence, so none of these
// would be attested there. Providers that are not declared attested play the vendor.

const LLAMA = MODELS.llama.slug;
const QWEN = MODELS.qwen.slug;
const model = (n: string) => ({ id: `${n}-upstream`, slug: `acme/${n}`, prompt: "0.0000001", completion: "0.0000004" });
const TEXT: Record<string, string> = { "m1-upstream": "answer one", "m2-upstream": "answer two", "m3-upstream": "answer three" };
const reply = (prompt: string, body: any) => (prompt.includes("Valid winners") ? '{"winner":"A","reason":"clearest"}' : TEXT[body.model]);
const PIN = { certPem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----", spkiSha256: "ab".repeat(32), attestationRef: "cd".repeat(32), pinnedAt: "2026-01-01T00:00:00.000Z" };

describe("attested council helpers", () => {
  const defaults = { models: [], judge: null, mode: "judge" as const };
  const base = { models: ["a/x", "b/y"], judge: "c/z" };

  test("council.attested is a boolean; it is reported on the spec only when true", () => {
    expect(parseCouncilSpec({ ...base, attested: true }, defaults)).toMatchObject({ attested: true });
    expect("attested" in parseCouncilSpec({ ...base, attested: false }, defaults)).toBe(false);
    expect("attested" in parseCouncilSpec(base, defaults)).toBe(false);
    for (const attested of ["yes", 1, "true", []]) {
      try {
        parseCouncilSpec({ ...base, attested }, defaults);
        throw new Error("expected a 400");
      } catch (e: any) {
        expect(e.status).toBe(400);
        expect(e.type).toBe("invalid_council");
      }
    }
  });

  test("attestationRefOf names only what the router holds: nothing without a report hash, a pin only when there is one, dev marked simulated", () => {
    const at = new Date("2026-05-01T00:00:00Z");
    expect(attestationRefOf({ id: "p", teeKind: "tdx", attestationHash: null, attestedAt: at })).toBeNull();
    expect(attestationRefOf({ id: "p", teeKind: "tdx", attestationHash: "h1", attestedAt: at })).toEqual({ provider: "p", tee: "tdx", report_hash: "h1", attested_at: at.toISOString(), tls_pin: null });
    expect(attestationRefOf({ id: "p", teeKind: "tdx", attestationHash: "h1", attestedAt: at, tlsPin: { spkiSha256: "s", attestationRef: "r" } })?.tls_pin).toEqual({ spki_sha256: "s", attestation_ref: "r" });
    expect(attestationRefOf({ id: "p", teeKind: "dev", attestationHash: "h1", attestedAt: null })).toMatchObject({ simulated: true, attested_at: null });
    expect(attestationRefOf({ id: "p", teeKind: "tdx", attestationHash: "h1", attestedAt: at })).not.toHaveProperty("simulated");
  });
});

describe("attested dual verification over HTTP", () => {
  let h: Harness;
  let auth: Record<string, string>;
  const admin = { "x-admin-token": ADMIN };
  const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
  const declareAttested = (id: string) => h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: admin, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  beforeAll(async () => {
    h = await startRouter({
      env: { ANONYMO_FEATURE_COUNCIL: "true" },
      providers: [
        { id: "enc1", name: "Enc1", models: [model("m1"), model("judge"), MODELS.llama], tee: "dev", reply },
        { id: "enc2", name: "Enc2", models: [model("m2"), MODELS.llamaPricey], tee: "dev", reply },
        { id: "solo", name: "Solo", models: [MODELS.qwen], tee: "dev", reply },
        { id: "ven", name: "Ven", models: [model("m3"), model("vjudge"), MODELS.llama, MODELS.qwen], reply },
      ],
    });
    auth = (await h.fundedKey(20n)).auth;
    for (const id of ["enc1", "enc2", "solo"]) expect((await declareAttested(id)).status).toBe(200);
    expect(((await runAttestor(h.ctx)).results as any[]).every((x) => x.ok)).toBe(true);
    // enc1 attested through a self-signed certificate, so the router pinned it (enc2 did not). The mock listens on plain
    // http, so the pin is only recorded in receipts here, not used for a handshake.
    await saveTlsPin(h.ctx.db, "enc1", PIN);
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => h.close());

  const dual = (provider: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: LLAMA, messages: [{ role: "user", content: "What is 17 * 23?" }], max_tokens: 30, verify: "dual", provider, ...extra } });
  const requests = async () => Object.fromEntries(await Promise.all(Object.entries(h.mocks).map(async ([id, m]) => [id, (await (await fetch(m.url + "/_stats")).json()).requests as number])));
  const generationCount = async () => (await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(generations))[0].n;
  const openHolds = async () => (await h.ctx.db.select().from(holds).where(eq(holds.status, "held"))).length;
  const hashOf = async (id: string) => (await h.ctx.db.select().from(providersTable).where(eq(providersTable.id, id)))[0].attestationHash;
  const verifySig = async (receipt: any, payload = receipt.payload) =>
    (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload, sig: receipt.sig, key_id: receipt.key_id } })).json()).data.signature_valid;
  /** The refs in a response's list, without the fields that say which call they belong to. */
  const bare = ({ role: _r, label: _l, receipt_id: _i, ...ref }: any) => ref;

  // ---- Dual verification on the attested lane -----------------------------------------------------------------------

  test("verify dual on lane attested: two different attested providers, the agreement bit and both references in both receipts", async () => {
    const r = await dual({ lane: "attested" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(r.headers.get("x-anonymo-lane")).toBe("attested");
    expect(r.headers.get("x-anonymo-disclosure")).toBe("attested");
    expect([...j.verification.providers].sort()).toEqual(["enc1", "enc2"]);
    expect(j.verification).toMatchObject({ agree: true, attested: true });
    const refs = j.verification.attestation_refs;
    expect(refs.map((x: any) => x.provider).sort()).toEqual(["enc1", "enc2"]);
    expect(refs.map((x: any) => x.receipt_id)).toEqual(j.verification.receipts);
    for (const x of refs) expect(x.report_hash).toBe(await hashOf(x.provider));
    expect(refs.find((x: any) => x.provider === "enc1").tls_pin).toEqual({ spki_sha256: PIN.spkiSha256, attestation_ref: PIN.attestationRef });
    expect(refs.find((x: any) => x.provider === "enc2").tls_pin).toBeNull();

    const rows = await h.ctx.db.select().from(generations).where(inArray(generations.id, j.verification.receipts));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const own = refs.find((x: any) => x.receipt_id === row.id);
      expect(row.providerId).toBe(own.provider);
      expect(row.receipt).toMatchObject({ lane: "attested", disclosure: "attested", attestation_ref: bare(own), verification: { mode: "dual", agree: true, attested: true, attestation_refs: refs } });
    }
    expect(j.receipt.payload.attestation_ref).toEqual(bare(refs[0]));
    expect(await verifySig(j.receipt)).toBe(true);
    const forged = structuredClone(j.receipt.payload);
    forged.verification.attestation_refs[1].report_hash = "0".repeat(64);
    expect(await verifySig(j.receipt, forged)).toBe(false);
  });

  test("a disagreement is still reported as one on the attested lane", async () => {
    const j = await (await dual({ lane: "attested" }, { messages: [{ role: "user", content: "say something" }] })).json();
    expect(j.verification).toMatchObject({ agree: false, match: "none", attested: true });
    expect(j.receipt.payload.verification.agree).toBe(false);
  });

  test("dual on lane attested with one attested provider of the model is a 409: nothing sent or charged", async () => {
    const before = await requests();
    const count = await generationCount();
    for (const [model, provider] of [
      [QWEN, { lane: "attested" }], // solo is attested, the vendor is not
      [LLAMA, { lane: "attested", only: ["enc1", "ven"] }],
    ] as const) {
      const r = await dual(provider, { model });
      expect(r.status).toBe(409);
      const e = (await r.json()).error;
      expect(e.type).toBe("verification_unavailable");
      expect(e.message).toMatch(/two different attested providers/);
      expect(e.metadata.eligible.length).toBe(1);
      expect(e.metadata.requested).toEqual({ lane: "attested", disclosure: "none" });
    }
    // None at all: refused by the lane itself.
    const none = await dual({ lane: "attested", only: ["ven"] });
    expect(none.status).toBe(503);
    expect((await none.json()).error.type).toBe("no_attested_endpoint");
    expect(await requests()).toEqual(before);
    expect(await generationCount()).toBe(count);
    expect(await openHolds()).toBe(0);
  });

  test("dual without the lane carries no attested block, even when both providers happen to be attested", async () => {
    const j = await (await dual({ only: ["enc1", "enc2"] })).json();
    expect(j.verification).not.toHaveProperty("attested");
    expect(j.verification).not.toHaveProperty("attestation_refs");
    expect(j.receipt.payload).not.toHaveProperty("attestation_ref");
  });
});

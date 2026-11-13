import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { keccak256 } from "viem";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";
import { providers as providersTable } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runAnonymoRoots } from "../src/services/anchor.ts";
import { parseReceiptHeader } from "../src/receipts/anonymo.ts";
import { canonicalBytes } from "../src/receipts/signer.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";
import { sealedEligible, type SealedRouteState } from "../src/anonymo/trust/sealed.ts";

// WS09 hooks in the single-call path (api/chat.ts): sealed requests on attested, fresh routes only (409
// sealed_unavailable otherwise, before any hold or provider call), and an Anonymo receipt on every single call, JSON and
// streamed, that verifies and gets an inclusion proof once its hour is rooted. "enc1" and "enc2" are development-attested
// mocks (accepted outside production only); "ven" is a plain vendor and the cheapest, so routing would prefer it.

const X = { id: "x-up", slug: "deepseek/deepseek-v4-flash" };
const priced = (m: { id: string; slug: string }, p: string) => ({ ...m, prompt: p, completion: p });
const Y = { id: "y-up", slug: "qwen/qwen3-32b" };

let h: Harness;
let auth: Record<string, string>;
const issued: string[] = [];
const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };

const counts = async () => Object.fromEntries(await Promise.all(Object.entries(h.mocks).map(async ([id, m]) => [id, ((await (await fetch(m.url + "/_stats")).json()) as any).requests as number])));
const holds = async () => Number(((((await h.ctx.db.execute(sql`SELECT count(*)::int AS n FROM holds`)) as any).rows ?? []) as any[])[0]?.n ?? 0);
const chat = (model: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  h.request("/v1/chat/completions", { method: "POST", headers: { ...auth, ...headers }, json: { model, messages: [{ role: "user", content: "What is 17 * 23?" }], max_tokens: 20, ...extra } });
const SEALED = { "x-anonymo-sealed": "required" };

beforeAll(async () => {
  h = await startRouter({
    providers: [
      { id: "enc1", name: "Enc1", models: [priced(X, "0.000004")], tee: "dev" },
      { id: "enc2", name: "Enc2", models: [priced(X, "0.000003")], tee: "dev" },
      { id: "ven", name: "Ven", models: [priced(X, "0.0000001"), priced(Y, "0.0000001")] },
    ],
  });
  auth = (await h.fundedKey(20n)).auth;
  for (const id of ["enc1", "enc2"]) await h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  expect(((await runAttestor(h.ctx)).results as any[]).every((x) => x.ok)).toBe(true);
  await h.ctx.catalog.refresh();
});
afterAll(async () => h.close());

describe("sealed single calls", () => {
  test("no attested route: 409 sealed_unavailable before any hold or provider call", async () => {
    const [c0, h0] = [await counts(), await holds()];
    const r = await chat(Y.slug, SEALED);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.type).toBe("sealed_unavailable");
    expect(await counts()).toEqual(c0);
    expect(await holds()).toBe(h0);
    // The same through a streamed request.
    const s = await chat(Y.slug, SEALED, { stream: true });
    expect(s.status).toBe(409);
    expect(await counts()).toEqual(c0);
    expect(await holds()).toBe(h0);
  });

  test("an unknown header value is refused, not ignored", async () => {
    const r = await chat(X.slug, { "x-anonymo-sealed": "yes" });
    expect(r.status).toBe(400);
  });

  test("a sealed call runs only on attested routes, and its receipt carries the quote hash", async () => {
    const before = await counts();
    for (let i = 0; i < 6; i++) {
      const r = await chat(X.slug, SEALED);
      expect(r.status).toBe(200);
      const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
      expect(rc.sealed).toBe(true);
      expect(["enc1", "enc2"]).toContain(rc.routes[0].provider!);
      expect(rc.attestation_quote_hash).toBeTruthy();
      issued.push(rc.request_id);
    }
    expect((await counts()).ven).toBe(before.ven);
  });

  test("random attestation states: a sealed call never reaches a route that is not attested and fresh", async () => {
    let seed = 0x5ea1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const maxAge = h.ctx.cfg.attestation.intervalMs * 3;
    let ok = 0;
    let refused = 0;
    for (let run = 0; run < 30; run++) {
      const now = Date.now();
      const states = new Map<string, SealedRouteState>();
      for (const id of ["enc1", "enc2", "ven"]) {
        const s: SealedRouteState = {
          attested: rand() < 0.6,
          attestationHash: rand() < 0.9 ? "ab".repeat(32) : null,
          attestedAt: new Date(now - (rand() < 0.7 ? 1_000 : maxAge + 60_000)),
          teeKind: id === "ven" ? (rand() < 0.5 ? "dev" : null) : "dev",
          live: true,
        };
        states.set(id, s);
        await h.ctx.db.update(providersTable).set({ attested: s.attested, attestationHash: s.attestationHash, attestedAt: s.attestedAt, teeKind: s.teeKind }).where(eq(providersTable.id, id));
      }
      await h.ctx.catalog.refresh();
      const clock = { now: Date.now(), maxAgeMs: maxAge, production: false };
      const before = await counts();
      const r = await chat(X.slug, SEALED);
      const after = await counts();
      const touched = Object.keys(after).filter((id) => after[id] > before[id]);
      for (const id of touched) if (!sealedEligible(states.get(id)!, clock)) throw new Error(`run ${run}: sealed call reached ${id} (${JSON.stringify([...states])})`);
      if (r.status === 200) ok++;
      else {
        refused++;
        expect(r.status).toBe(409);
        expect(touched).toEqual([]);
      }
    }
    expect(ok).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    await runAttestor(h.ctx); // back to verified
    for (const id of ["enc1", "enc2"]) await h.ctx.db.update(providersTable).set({ attested: true }).where(eq(providersTable.id, id));
    await h.ctx.db.update(providersTable).set({ attested: false, teeKind: null, attestationHash: null }).where(eq(providersTable.id, "ven"));
    await h.ctx.catalog.refresh();
  });
});

describe("single-call receipts", () => {
  test("a JSON call returns x-anonymo-receipt and anonymo_receipt, which verify", async () => {
    const r = await chat(Y.slug);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    const header = r.headers.get("x-anonymo-receipt")!;
    const rc = parseReceiptHeader(header).payload;
    expect(rc).toMatchObject({ request_id: body.id, model_id: Y.slug, refused: false, sealed: false });
    expect(r.headers.get("x-receipt-id")).toBe(body.id);
    expect(rc.routes).toHaveLength(1);
    expect(rc.routes[0]).toMatchObject({ role: "single", provider: "ven", model: Y.slug, family: "qwen", status: "ok", call_receipt_id: body.id });
    expect(rc.routes[0].cost).toBe(rc.cost);
    expect(body.anonymo_receipt.payload).toEqual(rc);
    expect(body.anonymo_receipt.leaf).toBe(keccak256(canonicalBytes(rc)));
    const g = (await (await h.request(`/v1/receipts/${body.id}`)).json()) as any;
    expect(g.data.signature_valid).toBe(true);
    expect(g.data.header).toBe(header);
    issued.push(body.id);
  });

  test("a streamed call carries its Anonymo receipt in the final event", async () => {
    const r = await chat(Y.slug, {}, { stream: true });
    expect(r.status).toBe(200);
    const events = (await r.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    const last = events.find((e) => e.anonymo_receipt);
    expect(last).toBeTruthy();
    const rc = last.anonymo_receipt.payload;
    expect(parseReceiptHeader(last.anonymo_receipt.header).payload).toEqual(rc);
    expect(rc.routes[0]).toMatchObject({ provider: "ven", status: "ok" });
    const g = (await (await h.request(`/v1/receipts/${rc.request_id}`)).json()) as any;
    expect(g.data.signature_valid).toBe(true);
    issued.push(rc.request_id);
  });

  test("every single-call receipt gets an inclusion proof against its hourly root after anchoring", async () => {
    expect(issued.length).toBeGreaterThan(5);
    const rooted = await runAnonymoRoots(h.ctx, Date.now() + 3_600_000);
    expect(rooted.rooted).toBeGreaterThanOrEqual(issued.length);
    for (const id of issued) {
      const p = (await (await h.request(`/v1/receipts/${id}/proof`)).json()) as any;
      expect(p.data).toMatchObject({ rooted: true, valid: true, hour: rooted.hour });
      expect(MerkleTree.verify(p.data.leaf, p.data.proof, p.data.root)).toBe(true);
    }
  });
});

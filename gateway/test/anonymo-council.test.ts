import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accounts, keys } from "../src/db/schema.ts";
import { picoToUsdString } from "../src/lib/money.ts";
import type { Hex } from "viem";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runAnonymoRoots } from "../src/services/anchor.ts";
import { configureTrust } from "../src/anonymo/trust/config.ts";
import { parseReceiptHeader, type AnonymoReceipt } from "../src/receipts/anonymo.ts";
import { setReceiptRootsPoster } from "../src/receipts/roots.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";
import { canonicalBytes } from "../src/receipts/signer.ts";
import { keccak256 } from "viem";

// anonymo-council over HTTP, against mock providers (Backend §6, §8). Providers "ds", "zp", "km" and "gm" are
// development-attested enclaves (accepted outside production only); "qw" is a plain vendor.

const m = (id: string, slug: string) => ({ id, slug, prompt: "0.000001", completion: "0.000004" });
const DS = m("ds-up", "deepseek/deepseek-v4-flash");
const GLM = m("glm-up", "zai/glm-5");
const QWEN = m("qwen-up", "qwen/qwen3-32b");
const KIMI = m("kimi-up", "moonshot/kimi-k2");
const GEMMA = m("gemma-up", "google/gemma-4-26b");
const TEXT: Record<string, string> = { "ds-up": "Answer from DeepSeek.", "glm-up": "Answer from GLM.", "qwen-up": "Answer from Qwen.", "gemma-up": "Answer from Gemma.", "kimi-up": "Answer from Kimi." };
const reply = (prompt: string, body: any) => {
  if (prompt.includes("Valid winners")) return '{"winner":"B","reason":"clearest"}';
  if (prompt.includes("aggregator-refuses") && body.model === "kimi-up") return "I can't help with that.";
  if (prompt.includes("Write the final answer now.")) return "MERGED ANSWER";
  if (prompt.includes("refuse-ds") && body.model === "ds-up") return "I can't help with that request.";
  return TEXT[body.model];
};

let h: Harness;
let auth: Record<string, string>;
let keyHash: string;
const balance = async () => {
  const [k] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, keyHash));
  const [a] = await h.ctx.db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, k.accountId));
  return a.balance;
};
const issued: string[] = [];

const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
const declareAttested = (id: string) =>
  h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
const stats = async () => Object.fromEntries(await Promise.all(Object.entries(h.mocks).map(async ([id, mk]) => [id, (await (await fetch(mk.url + "/_stats")).json()) as { requests: number; lastBody: any }])));
const counts = async () => Object.fromEntries(Object.entries(await stats()).map(([id, s]) => [id, s.requests]));
const control = (id: string, cfg: Record<string, unknown>) => fetch(h.mocks[id].url + "/_control", { method: "POST", body: JSON.stringify(cfg) });

const ask = async (council: Record<string, unknown> = {}, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
  const r = await h.request("/v1/chat/completions", { method: "POST", headers: { ...auth, ...headers }, json: { model: "anonymo-council", messages: [{ role: "user", content: (extra.prompt as string) ?? "what is the capital of france?" }], max_tokens: 200, council, ...extra, prompt: undefined } });
  const body = (await r.json()) as any;
  if (r.status === 200) issued.push(body.id);
  return { r, body };
};
const POOL = [DS.slug, GLM.slug, QWEN.slug];

beforeAll(async () => {
  h = await startRouter({
    env: { ANONYMO_FEATURE_COUNCIL: "true" },
    providers: [
      { id: "ds", name: "DS", models: [DS], tee: "dev", reply },
      { id: "zp", name: "ZP", models: [GLM], tee: "dev", reply },
      { id: "qw", name: "QW", models: [QWEN], reply },
      { id: "km", name: "KM", models: [KIMI], tee: "dev", reply },
      { id: "gm", name: "GM", models: [GEMMA], tee: "dev", reply },
    ],
  });
  const k = await h.fundedKey(50n);
  auth = k.auth;
  keyHash = k.hash;
  for (const id of ["ds", "zp", "km", "gm"]) expect((await declareAttested(id)).status).toBe(200);
  expect(((await runAttestor(h.ctx)).results as any[]).every((x) => x.ok)).toBe(true);
  await h.ctx.catalog.refresh();
  configureTrust(h.ctx, { graceMs: 2000, councilMultiplier: 4.5 });
});
afterAll(async () => {
  setReceiptRootsPoster(h.ctx, null);
  await h.close();
});

describe("anonymo-council", () => {
  test("three proposers from three families answer, an aggregator merges, and the receipt lists every one with its cost", async () => {
    const balanceBefore = await balance();
    const { r, body } = await ask({ models: POOL, aggregator: KIMI.slug }, {}, { max_tokens: 5000 });
    expect(r.status).toBe(200);
    expect(body.model).toBe("anonymo-council");
    expect(body.choices[0].message.content).toBe("MERGED ANSWER");
    expect(r.headers.get("x-anonymo-council-mode")).toBe("merge");
    expect(body.council).toMatchObject({ mode: "merge", outcome: "merged", sealed: false });
    expect(body.council.proposers.map((p: any) => p.family).sort()).toEqual(["deepseek", "glm", "qwen"]);

    // The receipt: in the header and in the body, signed, listing every proposer and the aggregator with costs.
    const header = r.headers.get("x-anonymo-receipt")!;
    expect(header).toBeTruthy();
    const parsed = parseReceiptHeader(header);
    const rc = parsed.payload as AnonymoReceipt;
    expect(rc.request_id).toBe(body.id);
    expect(r.headers.get("x-receipt-id")).toBe(body.id);
    expect(rc.routes.map((x) => [x.role, x.model, x.status])).toEqual([
      ["proposer", DS.slug, "ok"],
      ["proposer", GLM.slug, "ok"],
      ["proposer", QWEN.slug, "ok"],
      ["aggregator", KIMI.slug, "ok"],
    ]);
    expect(rc.routes.map((x) => x.route)).toEqual([`ds:${DS.slug}`, `zp:${GLM.slug}`, `qw:${QWEN.slug}`, `km:${KIMI.slug}`]);
    for (const x of rc.routes) expect(Number(x.cost)).toBeGreaterThan(0);
    expect(rc.weights_hash).toEqual([null, null, null, null]);
    expect(rc.refused).toBe(false);
    expect("attestation_quote_hash" in rc).toBe(false);

    // Price: 4.5 x the dearest proposer, never below the compute; the receipt, the usage and the ledger agree.
    const routeCost = rc.routes.reduce((s, x) => s + Number(x.cost), 0);
    const dearest = Math.max(...rc.routes.filter((x) => x.role === "proposer").map((x) => Number(x.cost)));
    expect(Number(rc.cost)).toBeCloseTo(Math.max(routeCost, 4.5 * dearest), 9);
    expect(Number(rc.cost_details!.premium)).toBeCloseTo(Number(rc.cost) - routeCost, 9);
    expect(body.usage.cost).toBeCloseTo(Number(rc.cost), 9);
    expect(picoToUsdString(balanceBefore - (await balance()))).toBe(rc.cost);

    // Proposers were capped at 900 output tokens, whatever the caller asked for.
    const s = await stats();
    for (const id of ["ds", "zp", "qw"]) expect(s[id].lastBody.max_tokens).toBe(900);

    // GET /v1/receipts/{id} serves the same receipt, and its signature verifies.
    const g = (await (await h.request(`/v1/receipts/${body.id}`)).json()) as any;
    expect(g.data.receipt).toEqual(rc);
    expect(g.data.signature_valid).toBe(true);
    expect(g.data.header).toBe(header);
    expect(g.data.leaf).toBe(keccak256(canonicalBytes(rc)));
    expect(body.anonymo_receipt.leaf).toBe(g.data.leaf);
  });

  test("select mode: a small judge picks one proposer's reply, chosen by the header", async () => {
    const { r, body } = await ask({ models: POOL, judge: KIMI.slug }, { "x-anonymo-council-mode": "select" });
    expect(r.status).toBe(200);
    expect(body.council).toMatchObject({ mode: "select", outcome: "selected", selected: "B", reason: "clearest" });
    expect(body.choices[0].message.content).toBe("Answer from GLM.");
    const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
    expect(rc.routes.map((x) => x.role)).toEqual(["proposer", "proposer", "proposer", "judge"]);
    expect((rc.council as any).mode).toBe("select");
  });

  test("a bad mode header is refused before anything is sent", async () => {
    const before = await counts();
    const { r, body } = await ask({ models: POOL }, { "x-anonymo-council-mode": "vote" });
    expect(r.status).toBe(400);
    expect(body.error.type).toBe("invalid_council");
    expect(await counts()).toEqual(before);
  });

  test("continue once two are done: a third outside the +grace window is cut off and billed nothing", async () => {
    configureTrust(h.ctx, { graceMs: 300 });
    await control("gm", { delayMs: 3000 });
    try {
      const t0 = Date.now();
      const { r, body } = await ask({ models: [DS.slug, GLM.slug, GEMMA.slug], aggregator: KIMI.slug });
      expect(r.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2500);
      const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
      const late = rc.routes.find((x) => x.model === GEMMA.slug)!;
      expect(late).toMatchObject({ role: "proposer", status: "late", cost: "0", refused: false });
      expect(body.council.proposers).toHaveLength(3);
      expect((rc.council as any).answered).toBe(2);
    } finally {
      await control("gm", { delayMs: 0 });
      configureTrust(h.ctx, { graceMs: 2000 });
    }
  });

  test("a third that lands inside the grace window is used", async () => {
    configureTrust(h.ctx, { graceMs: 1500 });
    await control("gm", { delayMs: 200 });
    try {
      const { r } = await ask({ models: [DS.slug, GLM.slug, GEMMA.slug], aggregator: KIMI.slug });
      expect(r.status).toBe(200);
      const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
      expect(rc.routes.filter((x) => x.role === "proposer").every((x) => x.status === "ok")).toBe(true);
      expect((rc.council as any).answered).toBe(3);
    } finally {
      await control("gm", { delayMs: 0 });
      configureTrust(h.ctx, { graceMs: 2000 });
    }
  });

  test("a proposer that refuses is billed 0, marked refused, and left out of the merge", async () => {
    const { r } = await ask({ models: POOL, aggregator: KIMI.slug }, {}, { prompt: "please refuse-ds now" });
    expect(r.status).toBe(200);
    const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
    expect(rc.routes[0]).toMatchObject({ model: DS.slug, status: "refused", refused: true, cost: "0", call_receipt_id: null });
    expect(rc.routes.slice(1, 3).every((x) => x.status === "ok")).toBe(true);
  });

  test("an aggregator that refuses is billed 0 and the caller gets proposer A's reply instead", async () => {
    const { r, body } = await ask({ models: POOL, aggregator: KIMI.slug }, {}, { prompt: "aggregator-refuses please" });
    expect(r.status).toBe(200);
    expect(body.council.outcome).toBe("aggregator_refused");
    expect(body.choices[0].message.content).toBe("Answer from DeepSeek.");
    const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
    expect(rc.routes[3]).toMatchObject({ role: "aggregator", status: "refused", cost: "0" });
  });

  test("fewer than three families: 503 council_unavailable, nothing sent", async () => {
    const before = await counts();
    // A pool of two models is a 400 (three are needed); a pool of three with two families is a 503.
    const { r, body } = await ask({ models: [DS.slug, GLM.slug] });
    expect(r.status).toBe(400);
    expect(body.error.type).toBe("invalid_council");
    const same = await ask({ models: [DS.slug, GLM.slug, "deepseek/deepseek-v4-flash:nitro"] });
    expect(same.r.status).toBe(503);
    expect(same.body.error.type).toBe("council_unavailable");
    expect(await counts()).toEqual(before);
  });

  test("the floor gate runs first: a blocked prompt reaches no proposer and is not charged", async () => {
    const floor = h.ctx.anonymo.floor;
    h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "cbrn" }) };
    try {
      const before = await counts();
      const { r, body } = await ask({ models: POOL });
      expect(r.status).toBe(451);
      expect(body.error.type).toBe("floor_blocked");
      expect(await counts()).toEqual(before);
    } finally {
      h.ctx.anonymo.floor = floor;
    }
  });
});

describe("sealed council", () => {
  test("x-anonymo-sealed: required uses only attested routes, skipping the vendor's family", async () => {
    const before = await counts();
    const { r, body } = await ask({ models: [DS.slug, GLM.slug, QWEN.slug, GEMMA.slug], aggregator: KIMI.slug }, { "x-anonymo-sealed": "required" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anonymo-sealed")).toBe("true");
    expect((await counts()).qw).toBe(before.qw);
    const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
    expect(rc.sealed).toBe(true);
    expect(rc.routes.map((x) => x.provider)).toEqual(["ds", "zp", "gm", "km"]);
    for (const x of rc.routes) {
      expect(x.attested).toBe(true);
      expect(x.attestation_quote_hash).toMatch(/^(0x)?[0-9a-f]{64}$/);
    }
    expect(rc.attestation_quote_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.council.sealed).toBe(true);
  });

  test("without three attested families it fails with 409 sealed_unavailable and sends nothing", async () => {
    const before = await counts();
    const { r, body } = await ask({ models: POOL, aggregator: KIMI.slug }, { "x-anonymo-sealed": "required" });
    expect(r.status).toBe(409);
    expect(body.error.type).toBe("sealed_unavailable");
    expect(await counts()).toEqual(before);
  });

  test("a non-attested aggregator fails a sealed council with 409, before anything is sent", async () => {
    const before = await counts();
    const { r, body } = await ask({ models: [DS.slug, GLM.slug, GEMMA.slug], aggregator: QWEN.slug, sealed: true });
    expect(r.status).toBe(409);
    expect(body.error.type).toBe("sealed_unavailable");
    expect(body.error.metadata.seat).toBe("aggregator");
    expect(await counts()).toEqual(before);
  });
});

describe("receipt roots", () => {
  test("every receipt verifies against its hour's root, which is posted through the ReceiptRoots poster", async () => {
    expect(issued.length).toBeGreaterThan(5);
    // Before the hour closes there is no root yet.
    const pending = (await (await h.request(`/v1/receipts/${issued[0]}/proof`)).json()) as any;
    expect(pending.data).toMatchObject({ rooted: false, status: "pending" });

    const posted: { hour: bigint; root: Hex }[] = [];
    let fail = true;
    setReceiptRootsPoster(h.ctx, {
      post: async (hour, root) => {
        if (fail) throw new Error("rpc down");
        posted.push({ hour, root });
        return { txHash: "0x" + "ab".repeat(32) };
      },
    });
    const next = Date.now() + 3_600_000;
    const first = await runAnonymoRoots(h.ctx, next);
    expect(first.rooted).toBe(issued.length);
    expect(first.posted).toBe(0); // the poster failed: the root waits, proofs already work
    fail = false;
    const second = await runAnonymoRoots(h.ctx, next);
    expect(second).toMatchObject({ rooted: 0, posted: 1 });
    expect(posted).toHaveLength(1);
    expect(posted[0].hour).toBe(BigInt(first.hour));

    const leaves: Hex[] = [];
    for (const id of issued) {
      const p = (await (await h.request(`/v1/receipts/${id}/proof`)).json()) as any;
      expect(p.data).toMatchObject({ rooted: true, posted: true, valid: true, hour: first.hour, root: posted[0].root, leaf_count: issued.length });
      expect(MerkleTree.verify(p.data.leaf, p.data.proof, posted[0].root)).toBe(true);
      // The leaf is the receipt's own hash: recompute it from the served receipt.
      const g = (await (await h.request(`/v1/receipts/${id}`)).json()) as any;
      expect(keccak256(canonicalBytes(g.data.receipt))).toBe(p.data.leaf);
      expect(g.data.anchor.valid).toBe(true);
      leaves.push(p.data.leaf);
    }
    expect(new Set(leaves).size).toBe(issued.length);
    // The hourly anchor job runs the same step.
    const again = await runAnonymoRoots(h.ctx, next);
    expect(again).toMatchObject({ rooted: 0, posted: 0 });
  });

  test("an unknown receipt is a 404", async () => {
    expect((await h.request("/v1/receipts/gen-nope")).status).toBe(404);
    expect((await h.request("/v1/receipts/gen-nope/proof")).status).toBe(404);
  });
});

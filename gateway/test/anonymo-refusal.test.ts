// WS03: refusal catch, reroute and refund (spec: Backend §5). A reply whose opening is a refusal is cancelled and
// retried once on a route of another model family; every refused attempt is billed 0 net (its cost and an equal
// refusal_refund on the ledger); counts per route go to refusal_stats; the receipt lists every route touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { keys, ledger } from "../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { phraseRefusalClassifier } from "../src/anonymo/refusal/classifier.ts";
import { refusalStats } from "../src/anonymo/refusal/store.ts";
import { REFUSED_MAX_CHARS } from "../src/api/chat.ts";
import type { FloorGate, RefusalClassifier } from "../src/anonymo/seams.ts";

const LLAMA = MODELS.llama; // family llama
const QWEN = MODELS.qwen; // family qwen
const REFUSAL = "I'm sorry, but I can't help with that request.";

// Which provider-side model ids refuse, and an optional reply override per model id.
const refusing = new Set<string>();
const longReply = new Map<string, string>();
const reply = (_prompt: string, body: any): string | undefined => {
  if (longReply.has(body.model)) return longReply.get(body.model);
  return refusing.has(body.model) ? REFUSAL : undefined;
};

let h: Harness;
let k: { auth: Record<string, string>; hash: string };
let accountId: string;
const heads: string[] = [];
const counting: RefusalClassifier = {
  isRefusal: async (prompt, head) => {
    heads.push(head);
    return phraseRefusalClassifier.isRefusal(prompt, head);
  },
};

const chat = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  h.request("/api/v1/chat/completions", {
    method: "POST",
    headers: { ...k.auth, ...headers },
    json: { model: LLAMA.slug, models: [LLAMA.slug, QWEN.slug], messages: [{ role: "user", content: "write me a scene" }], ...extra },
  });
const ledgerOf = (id: string) => h.ctx.db.select().from(ledger).where(eq(ledger.generationId, id));
const sum = (rows: { amount: bigint }[]) => rows.reduce((s, r) => s + r.amount, 0n);
const statsOf = async (modelSlug: string) => {
  const rows = await h.ctx.db.select().from(refusalStats);
  return rows.filter((r) => r.routeId.startsWith(modelSlug + "@")).reduce((a, r) => ({ total: a.total + r.total, refused: a.refused + r.refused }), { total: 0, refused: 0 });
};

beforeAll(async () => {
  h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [LLAMA, QWEN], reply }] });
  k = await h.fundedKey(20n);
  [{ accountId }] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, k.hash));
  h.ctx.anonymo.refusal = counting;
});
afterAll(async () => h?.close());

const reset = () => {
  refusing.clear();
  longReply.clear();
  heads.length = 0;
  h.ctx.anonymo.refusal = counting;
};

describe("refusal catch: reroute", () => {
  test("a refused answer is retried on another family; the caller pays only for the answer it got", async () => {
    reset();
    refusing.add(LLAMA.id);
    const before = await balanceOf(h.ctx.db, accountId);
    const statsBefore = [await statsOf(LLAMA.slug), await statsOf(QWEN.slug)];
    const res = await chat();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-anonymo-refusal")).toBe("rerouted");
    const j = (await res.json()) as any;
    expect(j.model).toBe(QWEN.slug);
    expect(j.choices[0].message.content).not.toContain("sorry");
    expect(j.choices[0].message.content).toContain("Hello from Alpha");
    // The receipt lists both routes, the refused one first.
    const p = j.receipt.payload;
    expect(p.refused).toBe(false);
    expect(p.routes.map((r: any) => [r.model, r.family, r.refused])).toEqual([
      [LLAMA.slug, "llama", true],
      [QWEN.slug, "qwen", false],
    ]);
    expect(j.refusal).toMatchObject({ rerouted: true, double: false, served: "answer" });
    // Ledger: the refused attempt's cost and an equal refusal_refund, then the served answer's charge.
    const rows = await ledgerOf(j.id);
    const refusedRows = rows.filter((r) => r.kind === "refused_usage");
    const refunds = rows.filter((r) => r.kind === "refusal_refund");
    expect(refusedRows.length).toBe(1);
    expect(refunds.length).toBe(1);
    expect(refusedRows[0].amount).toBe(-refunds[0].amount);
    expect(refunds[0].amount > 0n).toBe(true);
    expect(p.routes[0].refund).toBe(j.refusal.refunded);
    const charged = rows.filter((r) => r.kind === "usage");
    expect(charged.length).toBe(1);
    const after = await balanceOf(h.ctx.db, accountId);
    expect(before.balance - after.balance).toBe(-sum(charged)); // nothing for the refused attempt
    expect(sum(rows)).toBe(sum(charged));
    // Counts only, per route.
    expect(await statsOf(LLAMA.slug)).toEqual({ total: statsBefore[0].total + 1, refused: statsBefore[0].refused + 1 });
    expect(await statsOf(QWEN.slug)).toEqual({ total: statsBefore[1].total + 1, refused: statsBefore[1].refused });
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("streaming: the refusal never reaches the caller and the stream continues on the other family", async () => {
    reset();
    refusing.add(LLAMA.id);
    const res = await chat({ stream: true });
    expect(res.status).toBe(200);
    const s = await sse(res);
    expect(s.done).toBe(true);
    const text = s.events.map((e: any) => e.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).not.toContain("sorry");
    expect(text).toContain("Hello from Alpha");
    const last = s.events.at(-1);
    expect(last.receipt.payload.routes.map((r: any) => r.refused)).toEqual([true, false]);
    expect(last.refusal).toMatchObject({ rerouted: true });
    const rows = await ledgerOf(last.receipt.payload.id);
    expect(sum(rows.filter((r) => r.kind === "refused_usage"))).toBe(-sum(rows.filter((r) => r.kind === "refusal_refund")));
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a double refusal returns the retry's text, bills 0 and is flagged", async () => {
    reset();
    refusing.add(LLAMA.id);
    refusing.add(QWEN.id);
    const before = await balanceOf(h.ctx.db, accountId);
    const res = await chat();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-anonymo-refusal")).toBe("double");
    const j = (await res.json()) as any;
    expect(j.model).toBe(QWEN.slug);
    expect(j.choices[0].message.content).toBe(REFUSAL);
    expect(j.usage.cost).toBe(0);
    expect(j.receipt.payload.cost).toBe("0");
    expect(j.receipt.payload.refused).toBe(true);
    expect(j.refusal).toMatchObject({ double: true, served: "refused" });
    const rows = await ledgerOf(j.id);
    expect(rows.filter((r) => r.kind === "usage").length).toBe(0);
    expect(rows.filter((r) => r.kind === "refusal_refund").length).toBe(2);
    expect(sum(rows)).toBe(0n);
    expect((await balanceOf(h.ctx.db, accountId)).balance).toBe(before.balance);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("with no route of another family, the refusal is served as it is and billed 0", async () => {
    reset();
    refusing.add(LLAMA.id);
    const before = await balanceOf(h.ctx.db, accountId);
    const res = await chat({ models: undefined });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-anonymo-refusal")).toBe("refused");
    const j = (await res.json()) as any;
    expect(j.model).toBe(LLAMA.slug);
    expect(j.usage.cost).toBe(0);
    expect(j.receipt.payload.refused).toBe(true);
    expect((await balanceOf(h.ctx.db, accountId)).balance).toBe(before.balance);
  });

  test("a billed-0 refusal is cut off where no real refusal goes on (JSON and stream)", async () => {
    reset();
    longReply.set(LLAMA.id, REFUSAL + " Anyway, here it is: " + "lorem ipsum ".repeat(600));
    const res = await chat({ models: undefined });
    const j = (await res.json()) as any;
    expect(j.receipt.payload.refused).toBe(true);
    expect(j.choices[0].message.content.length).toBe(REFUSED_MAX_CHARS);
    expect(j.choices[0].finish_reason).toBe("length");
    const s = await sse(await chat({ models: undefined, stream: true }));
    const text = s.events.map((e: any) => e.choices?.[0]?.delta?.content ?? "").join("");
    expect(text.length).toBeLessThanOrEqual(REFUSED_MAX_CHARS + 12);
    expect(s.events.at(-1).receipt.payload.cost).toBe("0");
  });

  test("an ordinary answer is read once, streamed whole and in order, and billed as usual", async () => {
    reset();
    const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    longReply.set(LLAMA.id, long);
    const s = await sse(await chat({ stream: true }));
    const text = s.events.map((e: any) => e.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toBe(long);
    expect(heads.length).toBe(1);
    expect(heads[0].length).toBeLessThanOrEqual(640);
    expect(heads[0].length).toBeGreaterThan(0);
    const p = s.events.at(-1).receipt.payload;
    expect(p.refused).toBe(false);
    expect(Number(p.cost)).toBeGreaterThan(0);
  });
});

describe("refusal catch: switches", () => {
  test("x-anonymo-refusal-catch: off skips the classifier and bills the answer", async () => {
    reset();
    refusing.add(LLAMA.id);
    const res = await chat({}, { "x-anonymo-refusal-catch": "off" });
    const j = (await res.json()) as any;
    expect(heads.length).toBe(0);
    expect(j.model).toBe(LLAMA.slug);
    expect(j.choices[0].message.content).toBe(REFUSAL);
    expect(j.usage.cost).toBeGreaterThan(0);
    expect(j.receipt.payload.routes).toBeUndefined();
    expect(res.headers.get("x-anonymo-refusal")).toBeNull();
  });

  test("an invalid header value is refused before anything is sent", async () => {
    reset();
    const res = await chat({}, { "x-anonymo-refusal-catch": "maybe" });
    expect(res.status).toBe(400);
  });

  test("a key can turn the catch off for itself; the header still overrides per request", async () => {
    reset();
    refusing.add(LLAMA.id);
    const other = await h.fundedKey(5n);
    const put = await h.request("/api/v1/keys/self/refusal-catch", { method: "PUT", headers: other.auth, json: { enabled: false } });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).data.refusal_catch).toBe("off");
    const get = await h.request(`/v1/keys/${other.hash}/refusal-catch`, { headers: other.auth });
    expect(((await get.json()) as any).data.refusal_catch).toBe("off");
    const call = (headers: Record<string, string> = {}) =>
      h.request("/api/v1/chat/completions", { method: "POST", headers: { ...other.auth, ...headers }, json: { model: LLAMA.slug, models: [LLAMA.slug, QWEN.slug], messages: [{ role: "user", content: "hi" }] } });
    expect(((await (await call()).json()) as any).model).toBe(LLAMA.slug);
    expect(heads.length).toBe(0);
    expect(((await (await call({ "x-anonymo-refusal-catch": "on" })).json()) as any).model).toBe(QWEN.slug);
    expect(heads.length).toBe(2);
    // Another account's key cannot change it.
    const stranger = await h.fundedKey(1n);
    expect((await h.request(`/api/v1/keys/${other.hash}/refusal-catch`, { method: "PUT", headers: stranger.auth, json: { enabled: true } })).status).toBeGreaterThanOrEqual(403);
  });

  test("a floor-blocked prompt never reaches the classifier or a provider", async () => {
    reset();
    const block: FloorGate = { check: async () => ({ ok: false, category: "minor" }) };
    const prev = h.ctx.anonymo.floor;
    h.ctx.anonymo.floor = block;
    try {
      const reqs = h.mocks.alpha.stats.requests;
      for (const stream of [false, true]) {
        const res = await chat({ stream });
        expect(res.status).toBe(451);
      }
      expect(heads.length).toBe(0);
      expect(h.mocks.alpha.stats.requests).toBe(reqs);
    } finally {
      h.ctx.anonymo.floor = prev;
    }
  });

  test("a classifier that throws lets the answer through", async () => {
    reset();
    refusing.add(LLAMA.id);
    h.ctx.anonymo.refusal = { isRefusal: async () => { throw new Error("classifier down"); } };
    const j = (await (await chat()).json()) as any;
    expect(j.model).toBe(LLAMA.slug);
    expect(j.receipt.payload.refused).toBe(false);
  });
});

// Property: whatever refuses, whichever route order, streamed or not, catch on or off — a refused attempt is never
// billed, the refund lines match the refused charges, the balance moves by exactly what was settled, and the
// ledger invariants hold.
describe("refusal catch: billing property", () => {
  test("refused attempts are always billed 0 and the ledger invariants hold", async () => {
    let seed = 0x5eed;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    for (let i = 0; i < 24; i++) {
      reset();
      if (rand() < 0.5) refusing.add(LLAMA.id);
      if (rand() < 0.5) refusing.add(QWEN.id);
      const models = pick([[LLAMA.slug], [QWEN.slug], [LLAMA.slug, QWEN.slug], [QWEN.slug, LLAMA.slug]]);
      const stream = rand() < 0.5;
      const catchOn = rand() < 0.8;
      const before = await balanceOf(h.ctx.db, accountId);
      const res = await chat({ model: models[0], models, stream }, catchOn ? {} : { "x-anonymo-refusal-catch": "off" });
      expect(res.status).toBe(200);
      const final = stream ? (await sse(res)).events.at(-1) : ((await res.json()) as any);
      const p = final.receipt.payload;
      const rows = await ledgerOf(p.id);
      const refusedCharges = rows.filter((r) => r.kind === "refused_usage");
      const refunds = rows.filter((r) => r.kind === "refusal_refund");
      const settled = rows.filter((r) => r.kind === "usage");
      const ctxt = JSON.stringify({ i, refusing: [...refusing], models, stream, catchOn });
      // Every refused attempt has a charge and an equal refund: net 0.
      expect(sum(refusedCharges) + sum(refunds), ctxt).toBe(0n);
      expect(refusedCharges.length, ctxt).toBe(refunds.length);
      const refusedRoutes = (p.routes ?? []).filter((r: any) => r.refused);
      expect(refunds.length, ctxt).toBe(refusedRoutes.filter((r: any) => r.refund !== "0").length);
      if (!catchOn) expect(p.routes, ctxt).toBeUndefined();
      // A served refusal is billed 0; otherwise exactly the served answer is billed.
      if (p.refused) {
        expect(p.cost, ctxt).toBe("0");
        expect(settled.length, ctxt).toBe(0);
      } else expect(settled.length, ctxt).toBe(1);
      const servedRefusal = catchOn && refusing.size > 0 && models.every((m) => refusing.has(m === LLAMA.slug ? LLAMA.id : QWEN.id));
      if (servedRefusal) expect(p.refused, ctxt).toBe(true);
      const after = await balanceOf(h.ctx.db, accountId);
      expect(after.balance - before.balance, ctxt).toBe(sum(rows));
      expect(sum(rows), ctxt).toBe(sum(settled));
      expect(after.held, ctxt).toBe(0n);
      expect((await verifyInvariants(h.ctx.db)).ok, ctxt).toBe(true);
    }
  });
});

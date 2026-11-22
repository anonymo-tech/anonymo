// Auto Model (`anonymo-auto`, src/auto/plan.ts) end to end: the pick and its fallbacks, refusal-rate ranking, price
// limits and key caps, the refusal catch on the fallback list, sealed (attested routes only, else 409), the floor gate
// (451, never rerouted), the /v1/models entry, the response model / receipts / header, billing and determinism.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { usdToPico } from "../src/lib/money.ts";
import { ADMIN, MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { parseReceiptHeader } from "../src/receipts/anonymo.ts";
import { refusalStats } from "../src/anonymo/refusal/store.ts";
import { AUTO_HEADER, AUTO_MODEL, autoDecisionOf, parseAutoId, planAuto } from "../src/auto/plan.ts";
import type { FloorGate } from "../src/anonymo/seams.ts";
import type { KeyRow } from "../src/api/auth.ts";

const LLAMA = MODELS.llama; // llama family, the cheapest
const QWEN = MODELS.qwen; // qwen family
const DS = { id: "deepseek-v4", slug: "deepseek/deepseek-v4-flash", prompt: "0.0000003", completion: "0.0000009" };
const VIS = { id: "gemma-vis", slug: "google/gemma-4-vision", prompt: "0.0000005", completion: "0.000001", input: ["text", "image"] };
const ENC = { id: "glm-enc", slug: "z-ai/glm-5-enclave", prompt: "0.000004", completion: "0.000004" };

const CANDIDATES = {
  general: [QWEN.slug, LLAMA.slug, DS.slug, ENC.slug],
  code: [DS.slug, QWEN.slug],
  reasoning: [DS.slug, LLAMA.slug, ENC.slug],
  vision: [LLAMA.slug, VIS.slug],
  roleplay: [QWEN.slug, LLAMA.slug],
};

const refusing = new Set<string>();
const reply = (_prompt: string, body: any) => (refusing.has(body.model) ? "I'm sorry, but I can't help with that request." : undefined);

let h: Harness;
let auth: Record<string, string>;
const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };

const counts = async () => Object.fromEntries(await Promise.all(Object.entries(h.mocks).map(async ([id, m]) => [id, ((await (await fetch(m.url + "/_stats")).json()) as any).requests as number])));
const holds = async () => Number(((((await h.ctx.db.execute(sql`SELECT count(*)::int AS n FROM holds`)) as any).rows ?? []) as any[])[0]?.n ?? 0);
const post = (json: Record<string, unknown>, headers: Record<string, string> = {}) => h.request("/v1/chat/completions", { method: "POST", headers: { ...auth, ...headers }, json });
const ask = (content: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => post({ model: AUTO_MODEL, messages: [{ role: "user", content }], max_tokens: 40, ...extra }, headers);
const today = () => new Date().toISOString().slice(0, 10);
const setRefusals = async (rows: [string, string, number, number][]) => {
  await h.ctx.db.delete(refusalStats);
  for (const [model, provider, total, refused] of rows) await h.ctx.db.insert(refusalStats).values({ routeId: `${model}@${provider}`, day: today(), total, refused });
};
/** Plan one request directly (no HTTP), to read the whole ranked list. */
const plan = async (body: Record<string, unknown>, o: { key?: Partial<KeyRow> | null; prefs?: Record<string, unknown>; sealed?: boolean } = {}) => {
  const b = structuredClone(body);
  const p = await planAuto(h.ctx, new Request("http://test.invalid/"), { body: b, kind: "chat", key: (o.key ?? null) as KeyRow | null, prefs: (o.prefs ?? {}) as never, disc: { max: "any", lane: "public" } as never, sealed: o.sealed ?? false, character: false });
  return { plan: p, body: b };
};
const general = { model: AUTO_MODEL, messages: [{ role: "user", content: "Who painted the Mona Lisa?" }], max_tokens: 40 };

beforeAll(async () => {
  h = await startRouter({
    providers: [
      { id: "alpha", name: "Alpha", models: [LLAMA, QWEN], reply },
      { id: "beta", name: "Beta", models: [DS, VIS], reply },
      { id: "enc", name: "Enc", models: [ENC], tee: "dev", reply },
    ],
    env: { ANONYMO_AUTO_MODELS: JSON.stringify(CANDIDATES), ANONYMO_AUTO_MIN_SAMPLES: "1000", ANONYMO_AUTO_STATS_TTL_MS: "0" },
  });
  auth = (await h.fundedKey(20n)).auth;
  await h.request(`/api/v1/disclosure/enc`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  expect(((await runAttestor(h.ctx)).results as any[]).every((x) => x.ok)).toBe(true);
  await h.ctx.catalog.refresh();
});
afterAll(async () => h?.close());
beforeEach(async () => {
  refusing.clear();
  await h.ctx.db.delete(refusalStats);
});

describe("anonymo-auto: the pick", () => {
  test("a general request: answered by the cheapest live candidate (no refusal counts yet), header names the class", async () => {
    const r = await ask("Who painted the Mona Lisa?");
    expect(r.status).toBe(200);
    expect(r.headers.get(AUTO_HEADER)).toBe("general");
    const j = (await r.json()) as any;
    expect(j.model).toBe(LLAMA.slug); // the model that answered, never "anonymo-auto"
    expect(j.receipt.payload.model).toBe(LLAMA.slug);
    expect(j.anonymo_receipt.payload.model_id).toBe(LLAMA.slug);
    const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
    expect(rc.model_id).toBe(LLAMA.slug);
    expect(rc.routes.at(-1)).toMatchObject({ model: LLAMA.slug, status: "ok" });
  });

  test("billing: the picked model's normal price, no Auto fee", async () => {
    const q = { messages: [{ role: "user", content: "What is 17 * 23?" }], max_tokens: 20 };
    const a = await post({ model: AUTO_MODEL, ...q });
    const d = await post({ model: LLAMA.slug, ...q });
    expect(a.status).toBe(200);
    expect(a.headers.get(AUTO_HEADER)).toBe("reasoning");
    const [ja, jd] = [(await a.json()) as any, (await d.json()) as any];
    expect(ja.model).toBe(LLAMA.slug);
    expect(ja.usage.prompt_tokens).toBe(jd.usage.prompt_tokens);
    expect(ja.usage.completion_tokens).toBe(jd.usage.completion_tokens);
    expect(ja.usage.cost).toBe(jd.usage.cost);
    expect(ja.receipt.payload.cost).toBe(jd.receipt.payload.cost);
    expect(ja.usage.cost).toBeGreaterThan(0);
  });

  test("code (tools) goes to the code list; a request with an image only to an image-capable model", async () => {
    const c = await ask("Look up the weather", { tools: [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: {} } } }] });
    expect(c.status).toBe(200);
    expect(c.headers.get(AUTO_HEADER)).toBe("code");
    expect(((await c.json()) as any).model).toBe(QWEN.slug); // cheaper than DeepSeek
    const v = await ask([{ type: "text", text: "What is in this picture?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
    expect(v.status).toBe(200);
    expect(v.headers.get(AUTO_HEADER)).toBe("vision");
    expect(((await v.json()) as any).model).toBe(VIS.slug); // Llama is listed first and cheaper, but reads no images
    const { body } = await plan({ model: AUTO_MODEL, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] });
    expect(body.models).toEqual([VIS.slug]);
  });

  test("the fallback list is every other eligible candidate, ranked", async () => {
    const { plan: p, body } = await plan(general);
    expect(p!.class).toBe("general");
    expect(body.model).toBe(LLAMA.slug);
    expect(body.models).toEqual([LLAMA.slug, QWEN.slug, DS.slug, ENC.slug]); // price order: none has refusal counts
  });

  test("deterministic: the same request with the same counts picks the same model, every time", async () => {
    await setRefusals([[QWEN.slug, "alpha", 2000, 40]]);
    const first = (await plan(general)).body.models;
    for (let i = 0; i < 10; i++) expect((await plan(general)).body.models).toEqual(first);
    const models = new Set<string>();
    for (let i = 0; i < 4; i++) models.add(((await (await ask("Who painted the Mona Lisa?")).json()) as any).model);
    expect([...models]).toEqual([QWEN.slug]);
  });

  test("ranking: lower 30-day refusal rate first (the leaderboard's counts), then price", async () => {
    // Qwen 1%, DeepSeek 1% (dearer), Llama 30%; the enclave model has too few readings and goes last.
    await setRefusals([
      [QWEN.slug, "alpha", 2000, 20],
      [DS.slug, "beta", 1000, 10],
      [LLAMA.slug, "alpha", 3000, 900],
      [ENC.slug, "enc", 5, 0],
    ]);
    expect((await plan(general)).body.models).toEqual([QWEN.slug, DS.slug, LLAMA.slug, ENC.slug]);
    const board = (await (await h.request("/leaderboard")).json()) as any;
    expect(board.routes.find((x: any) => x.model === LLAMA.slug).refusal_rate_30d).toBe(0.3);
    const r = await ask("Who painted the Mona Lisa?");
    expect(((await r.json()) as any).model).toBe(QWEN.slug);
  });
});

describe("anonymo-auto: limits", () => {
  test("provider.max_price: candidates above it are not eligible", async () => {
    const { body } = await plan(general, { prefs: { max_price: { prompt: 0.15 } } }); // USD per 1M prompt tokens
    expect(body.models).toEqual([LLAMA.slug]);
    const { body: b2 } = await plan(general, { prefs: { max_price: { prompt: 0.35, completion: 1 } } });
    expect(b2.models).toEqual([LLAMA.slug, QWEN.slug, DS.slug]);
    const r = await ask("Who painted the Mona Lisa?", { provider: { max_price: { prompt: 0.25 } } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).model).toBe(LLAMA.slug);
  });

  test("nothing within max_price: refused like any model, nothing sent", async () => {
    const before = await counts();
    const r = await ask("Who painted the Mona Lisa?", { provider: { max_price: { prompt: 0.01 } } });
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.type).toBe("no_providers");
    expect(await counts()).toEqual(before);
  });

  test("a key spend cap: candidates whose worst case would not fit are dropped while one does", async () => {
    await setRefusals([[ENC.slug, "enc", 2000, 0]]); // the enclave model would rank first on refusal rate
    expect((await plan(general)).body.model).toBe(ENC.slug);
    const capped = await plan({ ...general, max_tokens: 1000 }, { key: { budget: usdToPico("0.001"), spent: 0n, budgetReset: null, allowedModels: null } }); // Llama fits (~$0.0003), the enclave model (~$0.004) does not
    expect(capped.body.model).not.toBe(ENC.slug);
    expect(capped.body.models).not.toContain(ENC.slug);
  });

  test("a key allowlist: Auto picks only from the allowed models, unless the list allows anonymo-auto", async () => {
    const only = await plan(general, { key: { budget: null, spent: 0n, allowedModels: [QWEN.slug, DS.slug] } });
    expect(only.body.models).toEqual([QWEN.slug, DS.slug]);
    expect(only.plan!.allow).toEqual([]);
    const auto = await plan(general, { key: { budget: null, spent: 0n, allowedModels: [AUTO_MODEL] } });
    expect(auto.body.models).toEqual([LLAMA.slug, QWEN.slug, DS.slug, ENC.slug]);
    expect(auto.plan!.allow).toEqual([LLAMA.slug, QWEN.slug, DS.slug, ENC.slug]);
  });

  test("routing suffixes carry over to every candidate; other ids are untouched", async () => {
    expect(parseAutoId("anonymo-auto:floor")).toEqual(["floor"]);
    expect(parseAutoId("anonymo-auto:bogus")).toBeNull();
    expect(parseAutoId(LLAMA.slug)).toBeNull();
    const { body } = await plan({ ...general, model: "anonymo-auto:floor" });
    expect(body.models).toEqual([LLAMA.slug, QWEN.slug, DS.slug, ENC.slug].map((m) => m + ":floor"));
    // `:private` and provider.private: the same attested-route filter as for any model.
    expect((await plan({ ...general, model: "anonymo-auto:private" })).body.models).toEqual([ENC.slug + ":private"]);
    expect((await plan(general, { prefs: { private: true } })).body.models).toEqual([ENC.slug]);
    const priv = await ask("Who painted the Mona Lisa?", { model: "anonymo-auto:private" });
    expect(priv.status).toBe(200);
    expect(((await priv.json()) as any).model).toBe(ENC.slug);
    const none = await plan({ ...general, model: LLAMA.slug });
    expect(none.plan).toBeNull();
    expect(none.body.model).toBe(LLAMA.slug);
  });
});

describe("anonymo-auto: refusal catch on the fallback list", () => {
  test("the pick refuses: the reroute goes to the next candidate of another family, the refusal is billed 0", async () => {
    refusing.add(LLAMA.id);
    const r = await ask("Who painted the Mona Lisa?");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anonymo-refusal")).toBe("rerouted");
    expect(r.headers.get(AUTO_HEADER)).toBe("general");
    const j = (await r.json()) as any;
    expect(j.model).toBe(QWEN.slug);
    expect(j.refusal.rerouted).toBe(true);
    const routes = j.receipt.payload.routes as any[];
    expect(routes.map((x) => [x.model, x.refused])).toEqual([[LLAMA.slug, true], [QWEN.slug, false]]);
    expect(routes[0].refund).toBeDefined();
    const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
    expect(rc.model_id).toBe(QWEN.slug); // the model that answered
    expect(rc.routes.map((x: any) => [x.model, x.status])).toEqual([[LLAMA.slug, "refused"], [QWEN.slug, "ok"]]);
    expect(rc.routes[0].cost).toBe("0");
  });

  test("a stream carries the header up front and names the model that answered", async () => {
    const r = await ask("Who painted the Mona Lisa?", { stream: true });
    expect(r.status).toBe(200);
    expect(r.headers.get(AUTO_HEADER)).toBe("general");
    const { events, done } = await sse(r);
    expect(done).toBe(true);
    expect(events.filter((e) => e.choices?.length).every((e) => e.model === LLAMA.slug)).toBe(true);
    const last = events.find((e) => e.anonymo_receipt);
    expect(last.anonymo_receipt.payload.model_id).toBe(LLAMA.slug);
    expect(last.receipt.payload.model).toBe(LLAMA.slug);
  });
});

describe("anonymo-auto: sealed and the floor", () => {
  const SEALED = { "x-anonymo-sealed": "required" };

  test("sealed: only candidates with an attested, fresh route are eligible", async () => {
    const before = await counts();
    const r = await ask("Who painted the Mona Lisa?", {}, SEALED);
    expect(r.status).toBe(200);
    expect(r.headers.get(AUTO_HEADER)).toBe("general");
    expect(((await r.json()) as any).model).toBe(ENC.slug);
    const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
    expect(rc.sealed).toBe(true);
    expect(rc.routes.every((x: any) => x.provider === "enc")).toBe(true);
    const after = await counts();
    expect([after.alpha - before.alpha, after.beta - before.beta]).toEqual([0, 0]);
    expect((await plan(general, { sealed: true })).body.models).toEqual([ENC.slug]);
  });

  test("sealed with no attested candidate for the class: 409 sealed_unavailable, nothing held or sent", async () => {
    const [c0, h0] = [await counts(), await holds()];
    const r = await ask("Write a python script that renames files", {}, SEALED); // code: DeepSeek and Qwen, neither attested
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.type).toBe("sealed_unavailable");
    const s = await ask("Write a python script that renames files", { stream: true }, SEALED);
    expect(s.status).toBe(409);
    expect(await counts()).toEqual(c0);
    expect(await holds()).toBe(h0);
  });

  test("a floor block: 451 before Auto runs, never rerouted, nothing sent or held", async () => {
    const floor = h.ctx.anonymo.floor;
    const block: FloorGate = { check: async () => ({ ok: false, category: "cbrn" }) };
    h.ctx.anonymo.floor = block;
    try {
      const [c0, h0] = [await counts(), await holds()];
      for (const stream of [false, true]) {
        const r = await ask("Who painted the Mona Lisa?", { stream });
        expect(r.status).toBe(451);
        expect(((await r.json()) as any).error.type).toBe("floor_blocked");
        expect(r.headers.get(AUTO_HEADER)).toBeNull();
        expect(r.headers.get("x-anonymo-refusal")).toBeNull();
      }
      expect(await counts()).toEqual(c0);
      expect(await holds()).toBe(h0);
    } finally {
      h.ctx.anonymo.floor = floor;
    }
  });

  test("the decision is kept per request only", async () => {
    const req = new Request("http://test.invalid/");
    expect(autoDecisionOf(req)).toBeUndefined();
  });
});

describe("anonymo-auto in /v1/models", () => {
  test("listed first, with a plain description of how it chooses and the live candidates per class", async () => {
    const j = (await (await h.request("/v1/models")).json()) as any;
    const auto = j.data[0];
    expect(auto.id).toBe(AUTO_MODEL);
    expect(auto.name).toBe("Anonymo Auto");
    expect(auto.description).toContain("refusal rate over the last 30 days, then by price");
    expect(auto.description).toContain("normal price");
    expect(auto.description).not.toMatch(/unfiltered|no rules|anything goes|\bbest\b/i);
    expect(auto.pricing.prompt).toBe("-1");
    expect(auto.architecture.input_modalities).toContain("image");
    expect(auto.auto.classes.vision).toEqual([VIS.slug]);
    expect(auto.auto.classes.general).toEqual([QWEN.slug, LLAMA.slug, DS.slug, ENC.slug]);
    expect(auto.lanes).toEqual(["public", "attested"]);
    expect(j.data.filter((m: any) => m.id === AUTO_MODEL)).toHaveLength(1);
  });

  test("the list filters apply to it, and it is gone when the feature is off", async () => {
    const emb = (await (await h.request("/v1/models?output_modalities=embeddings")).json()) as any;
    expect(emb.data.some((m: any) => m.id === AUTO_MODEL)).toBe(false);
    h.ctx.cfg.auto.enabled = false;
    try {
      const j = (await (await h.request("/v1/models")).json()) as any;
      expect(j.data.some((m: any) => m.id === AUTO_MODEL)).toBe(false);
      const r = await ask("Who painted the Mona Lisa?");
      expect(r.status).toBe(404);
      expect(r.headers.get(AUTO_HEADER)).toBeNull();
    } finally {
      h.ctx.cfg.auto.enabled = true;
    }
  });
});

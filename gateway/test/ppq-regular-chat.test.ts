import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issueFirstChat } from "../src/anonymo/keys/first-chat.ts";
import { keys, modelsLane, offers, providers } from "../src/db/schema.ts";
import * as network from "../src/providers/network.ts";
import { PPQ_CHAT_MODELS } from "../src/providers/ppq-chat.ts";
import { startRouter, type Harness } from "./helpers.ts";

const canonical = "https://api.ppq.ai/v1";
const heretic = "venice/olafangensan-glm-4.7-flash-heretic";
const pooled = "venice/venice-uncensored-1-2";
const anon = "venice/abliteration-abliterated-model-large-flash";
const unknown = "sample/unreviewed-uncensored";
const route = (id: string, slug = id) => ({ id, slug, prompt: "0.0000003", completion: "0.000001", ctx: 32_768 });
let h: Harness;
let calls: string[];
let fetchSpy: ReturnType<typeof spyOn>;
let auth: Record<string, string>;

beforeAll(async () => {
  h = await startRouter({ providers: [
    { id: "ppq-fixture", name: "PPQ fixture", policy: { zdr: true, training: false, retains_prompts: false }, models: [
      ...PPQ_CHAT_MODELS.map(m => route(m.id)), route(unknown), route(pooled, "anonymo-1"), route(pooled, "anonymo-council"),
    ] },
    { id: "ppq-deepseek", name: "DeepSeek fixture", models: [route("venice/deepseek-v4-1-flash-uncensored", "anonymo-council")] },
    { id: "ppq-gemma", name: "Gemma fixture", models: [route("venice/gemma-4-uncensored", "anonymo-council")] },
    { id: "lookalike", name: "Different provider", models: [route(heretic)] },
  ] });
  for (const [provider, family] of [["ppq-fixture", "mistral"], ["ppq-deepseek", "deepseek"], ["ppq-gemma", "gemma"]]) {
    await h.ctx.db.update(providers).set({ baseUrl: canonical }).where(eq(providers.id, provider));
    await h.ctx.db.update(offers).set({ upstream: "ppq", tier: 0, family }).where(eq(offers.providerId, provider));
  }
  await h.ctx.catalog.refresh();
  auth = (await h.fundedKey()).auth;
  calls = [];
  const mockOrigin = h.mocks["ppq-fixture"].url;
  const original = network.providerFetch;
  fetchSpy = spyOn(network, "providerFetch").mockImplementation(async (uri, init, policy) => {
    const url = new URL(uri);
    if (url.origin === "https://api.ppq.ai") {
      if (url.pathname !== "/v1/chat/completions") throw new Error("Unexpected fixture path");
      calls.push(JSON.parse(String(init.body)).model);
      return original(mockOrigin + "/chat/completions", init, policy);
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("External traffic disabled in fixture");
    return original(uri, init, policy);
  });
});
afterAll(async () => { fetchSpy?.mockRestore(); await h?.close(); });

const chat = (model: string, extra: Record<string, unknown> = {}, headers = auth) =>
  h.request("/v1/chat/completions", { method: "POST", headers, json: { model, messages: [{ role: "user", content: "Say hello." }], max_tokens: 32, ...extra } });

test("all reviewed PPQ weights are selectable by canonical ID with upstream disclosure and an actual eligible endpoint", async () => {
  const { data } = await (await h.request("/v1/models")).json();
  const visible = data.filter((m: { anonymo_chat?: unknown }) => m.anonymo_chat);
  expect(visible.map((m: { id: string }) => m.id).sort()).toEqual(PPQ_CHAT_MODELS.map(m => m.id).sort());
  for (const model of PPQ_CHAT_MODELS) {
    const row = visible.find((m: { id: string }) => m.id === model.id);
    expect(row.anonymo_chat).toEqual({ name: model.name, source: "ppq", category: "uncensored", standard_chat: true, privacy_level: model.privacyLevel });
    expect(row.attested_available).toBe(false);
    expect(row.lanes).toEqual(["public"]);
    const r = await chat(model.id);
    expect(r.status).toBe(200);
    expect(calls.at(-1)).toBe(model.id);
  }
  const endpoints = (await (await h.request("/api/v1/models/" + heretic + "/endpoints")).json()).data.endpoints;
  expect(endpoints.map((o: { provider_slug: string }) => o.provider_slug)).toEqual(["ppq-fixture"]);
  const manifest = await (await h.request("/manifest")).json();
  expect(manifest.models.some((m: { id: string }) => m.id === pooled)).toBe(true);
});

test("the existing group stays live while other providers, candidate holds and stronger lanes stay restricted", async () => {
  expect((await chat("anonymo-1")).status).toBe(200);
  expect(calls.at(-1)).toBe(pooled);
  const council = await chat("anonymo-council", { max_tokens: 128 });
  if (!council.ok) throw new Error((await council.json()).error.message);
  expect(council.status).toBe(200);
  const before = calls.length;
  for (const [model, prefs] of [
    [heretic, { only: ["lookalike"] }], [unknown, {}], [heretic, { lane: "attested" }],
    [heretic + ":private", {}], [heretic, { disclosure: { max: "none" } }], [anon, { zdr: true }], [anon, { data_collection: "deny" }],
  ] as const) {
    expect((await chat(model, { provider: prefs })).status).toBeGreaterThanOrEqual(400);
  }
  const completion = await h.request("/v1/completions", { method: "POST", headers: auth, json: { model: heretic, prompt: "Say hello.", max_tokens: 32 } });
  expect(completion.status).toBeGreaterThanOrEqual(400);
  expect(calls.length).toBe(before);
  await h.ctx.db.insert(modelsLane).values({ modelId: pooled, variant: "native_low_refusal", status: "candidate" });
  await h.ctx.catalog.refresh();
  try {
    expect((await chat(pooled)).status).toBeGreaterThanOrEqual(400);
    expect((await chat("anonymo-1")).status).toBeGreaterThanOrEqual(400);
    const rows = (await (await h.request("/v1/models")).json()).data;
    expect(rows.some((r: { id: string }) => r.id === pooled || r.id === "anonymo-1")).toBe(false);
    expect(calls.length).toBe(before);
  } finally {
    await h.ctx.db.delete(modelsLane).where(eq(modelsLane.modelId, pooled));
    await h.ctx.catalog.refresh();
  }
});

test("a fresh dashboard key sends the selected canonical model once, and floor blocks never send", async () => {
  const key = await h.newKey();
  const [record] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  expect(await issueFirstChat(h.ctx.db, record.accountId, randomUUID())).toBe(true);
  const before = calls.length;
  const floor = h.ctx.anonymo.floor;
  h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "minor" }) };
  try {
    expect((await chat(heretic, { dashboard_chat: true }, key.auth)).status).toBe(451);
    expect(calls.length).toBe(before);
  } finally {
    h.ctx.anonymo.floor = floor;
  }
  const first = await chat(heretic, { dashboard_chat: true }, key.auth);
  expect(first.status).toBe(200);
  expect(calls.slice(before)).toEqual([heretic]);
  expect((await chat(heretic, { dashboard_chat: true }, key.auth)).status).toBe(402);
  expect(calls.length).toBe(before + 1);
});

test("grouped Regular Chat keeps restricted content out of shared response caches", async () => {
  const before = calls.length;
  for (let i = 0; i < 2; i++) {
    expect((await chat("anonymo-1", { cache: { mode: "exact" }, messages: [{ role: "user", content: "Write one word about spring." }] })).status).toBe(200);
  }
  expect(calls.slice(before)).toEqual([pooled, pooled]);
});

test("ordinary PPQ never becomes an attested offer through provider-wide flags", async () => {
  await h.ctx.db.update(providers).set({ attested: true, attestedAt: new Date(), attestationHash: "sha256:fixture", teeKind: "tdx", classifierEnabled: true }).where(eq(providers.id, "ppq-fixture"));
  await h.ctx.catalog.refresh();
  try {
    const [row] = (await (await h.request("/v1/models")).json()).data.filter((r: {id: string}) => r.id === heretic);
    expect(row.attested_available).toBe(false);
    expect(row.lanes).toEqual(["public"]);
    const before = calls.length;
    expect((await chat(heretic + ":private")).status).toBeGreaterThanOrEqual(400);
    expect(calls.length).toBe(before);
  } finally {
    await h.ctx.db.update(providers).set({ attested: false, attestedAt: null, attestationHash: null, teeKind: null, classifierEnabled: false }).where(eq(providers.id, "ppq-fixture"));
    await h.ctx.catalog.refresh();
  }
});

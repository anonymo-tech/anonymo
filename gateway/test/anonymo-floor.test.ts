// WS00: the floor gate sits in front of everything. A blocked prompt is answered 451 and never reaches a provider,
// a hold, the cache or the refusal catch, so rerouting can never be used to get around it (spec: Backend §5, §10).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { holds } from "../src/db/schema.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { createAnonymoServices, floorInputOf } from "../src/anonymo/services.ts";
import type { FloorGate, FloorInput, RefusalClassifier } from "../src/anonymo/seams.ts";

const MODEL = MODELS.llama.slug;
const allow: FloorGate = { check: async () => ({ ok: true }) };
const block: FloorGate = { check: async () => ({ ok: false, category: "cbrn" }) };
const broken: FloorGate = { check: async () => { throw new Error("guard model down"); } };

let h: Harness;
let auth: Record<string, string>;
let seen: FloorInput[] = [];
let refusalCalls = 0;
const countingRefusal: RefusalClassifier = { isRefusal: async () => { refusalCalls++; return false; } };

const providerRequests = () => Object.values(h.mocks).reduce((n, m) => n + m.stats.requests, 0);
const holdCount = async () => (await h.ctx.db.select({ id: holds.id }).from(holds)).length;
const chat = (extra: Record<string, unknown> = {}) =>
  h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: MODEL, messages: [{ role: "user", content: "hello" }], ...extra } });
const recording = (gate: FloorGate): FloorGate => ({ check: async (input) => { seen.push(input); return gate.check(input); } });

beforeAll(async () => {
  h = await startRouter();
  auth = (await h.fundedKey(20n)).auth;
  h.ctx.anonymo.refusal = countingRefusal;
});
afterAll(async () => h?.close());

describe("floor gate", () => {
  test("a blocked prompt gets 451 with its category, and nothing is sent, held or classified", async () => {
    h.ctx.anonymo.floor = recording(block);
    const [reqs, held, refusals] = [providerRequests(), await holdCount(), refusalCalls];
    const res = await chat();
    expect(res.status).toBe(451);
    const j = (await res.json()) as { error: { type: string; metadata?: { category?: string }; message: string } };
    expect(j.error.type).toBe("floor_blocked");
    expect(j.error.metadata?.category).toBe("cbrn");
    expect(j.error.message).not.toContain("hello"); // the reply never echoes the prompt
    expect(providerRequests()).toBe(reqs);
    expect(await holdCount()).toBe(held);
    expect(refusalCalls).toBe(refusals);
  });

  test("a blocked streaming prompt is refused before any stream starts", async () => {
    h.ctx.anonymo.floor = block;
    const reqs = providerRequests();
    const res = await chat({ stream: true });
    expect(res.status).toBe(451);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(providerRequests()).toBe(reqs);
  });

  test("a blocked prompt is not rerouted when several providers could serve it", async () => {
    h.ctx.anonymo.floor = block;
    const reqs = providerRequests();
    const res = await chat({ models: [MODEL, MODELS.qwen.slug], provider: { allow_fallbacks: true } });
    expect(res.status).toBe(451);
    expect(providerRequests()).toBe(reqs);
  });

  test("a gate that cannot answer fails closed with 503, and nothing is sent", async () => {
    h.ctx.anonymo.floor = broken;
    const reqs = providerRequests();
    const res = await chat();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("floor_unavailable");
    expect(providerRequests()).toBe(reqs);
  });

  test("a passing gate lets the request through to a provider, and the gate saw the prompt", async () => {
    seen = [];
    h.ctx.anonymo.floor = recording(allow);
    const reqs = providerRequests();
    const res = await chat();
    expect(res.status).toBe(200);
    expect(providerRequests()).toBe(reqs + 1);
    expect(seen.at(-1)?.text).toContain("hello");
  });
});

describe("floor input and defaults", () => {
  test("reads every text part and flags uploads", () => {
    const input = floorInputOf({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "data:," } }] },
      ],
    });
    expect(input.text).toContain("be brief");
    expect(input.text).toContain("describe this");
    expect(input.hasUpload).toBe(true);
    expect(floorInputOf({ prompt: "complete me" })).toEqual({ text: "complete me", modality: "text", hasUpload: false });
  });

  test("the placeholder gate fails closed when ANONYMO_FLOOR_REQUIRED is set", async () => {
    await expect(createAnonymoServices({ ANONYMO_FLOOR_REQUIRED: "1" }).floor.check({ text: "x", modality: "text", hasUpload: false })).rejects.toThrow();
    expect(await createAnonymoServices({}).floor.check({ text: "x", modality: "text", hasUpload: false })).toEqual({ ok: true });
  });

  test("production implies a required floor: with no guard model URL every check fails closed", async () => {
    await expect(createAnonymoServices({ ANONYMO_ENV: "production" }).floor.check({ text: "x", modality: "text", hasUpload: false })).rejects.toThrow();
  });
});

describe("floor gate before council mode", () => {
  let hc: Harness;
  beforeAll(async () => {
    hc = await startRouter({ env: { ANONYMO_FEATURE_COUNCIL: "true" } });
  });
  afterAll(async () => hc?.close());

  test("a blocked council request gets 451 and no member or judge is called", async () => {
    const key = (await hc.fundedKey(20n)).auth;
    hc.ctx.anonymo.floor = block;
    const calls = () => Object.values(hc.mocks).reduce((n, m) => n + m.stats.requests, 0);
    const before = calls();
    const res = await hc.request("/api/v1/chat/completions", {
      method: "POST",
      headers: key,
      json: { model: "anonymo-council", messages: [{ role: "user", content: "hello" }], council: { models: [MODELS.llama.slug, MODELS.qwen.slug], judge: MODELS.llama.slug } },
    });
    expect(res.status).toBe(451);
    expect(calls()).toBe(before);
  });
});

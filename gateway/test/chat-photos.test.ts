// Photos in chat (floor/chat-photos.ts): image parts pass the upload rule before the floor, the refusal catch, any
// hold or any provider call. Every image here is a tiny synthetic solid-colour PNG generated in the test; classifier
// and hash-match results are doubles keyed to the colour, never real scores.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { holds, keys } from "../src/db/schema.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { blockHashes, dbHashBlocklist } from "../src/anonymo/abuse/store.ts";
import type { FloorGate, FloorInput } from "../src/anonymo/seams.ts";
import { createMediaGate, type FrameScore } from "../src/anonymo/media/gate.ts";
import { sha256Hex, type CsamHashClient, type HashBlocklist } from "../src/anonymo/floor/uploads.ts";
import { buildChatPhotoServices, chatPhotosOf, MAX_CHAT_PHOTO_BYTES, photoChecksLeaveProcess, setChatPhotoServices } from "../src/anonymo/floor/chat-photos.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { solidPng, type Rgb } from "./media/fixtures.ts";

const model = MODELS.llama.slug;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const png = (rgb: Rgb) => solidPng(8, 8, rgb);
const dataUrl = (bytes: Uint8Array, mime = "image/png") => `data:${mime};base64,${b64(bytes)}`;
const GREEN = png([30, 200, 30]);
const GREY = png([128, 128, 128]);
const AMBER = png([250, 200, 0]);
const BLUE = png([0, 0, 250]);
const PURPLE = png([120, 0, 120]);
const imagePart = (url: string) => ({ type: "image_url", image_url: { url } });
const ask = (...urls: string[]) => ({ model, max_tokens: 20, messages: [{ role: "user", content: [{ type: "text", text: "What colour is this?" }, ...urls.map(imagePart)] }] });

// ---- Doubles ---------------------------------------------------------------------------------------------------------
let csamCalls: string[] = [];
let lookups: string[] = [];
let floorSeen: FloorInput[] = [];
const matchedHashes = new Set<string>([sha256Hex(PURPLE)]);
const csam = (o: Partial<CsamHashClient> = {}): CsamHashClient => ({
  sendsOutside: true, // a real hash service is outside this process
  async match({ bytes }) {
    csamCalls.push(sha256Hex(bytes));
    return { matched: matchedHashes.has(sha256Hex(bytes)) };
  },
  ...o,
});
const recordingList = (inner: HashBlocklist): HashBlocklist => ({ lookup: async (h) => (lookups.push(h), inner.lookup(h)) });
const allow: FloorGate = { sendsTextOutside: false, check: async (i) => (floorSeen.push(i), { ok: true }) };
const SCORES: [Uint8Array, FrameScore | "down"][] = [
  [GREEN, { nsfw: 0.02, apparentAge: null }],
  [AMBER, { nsfw: 0.92, apparentAge: 15 }], // mock: explicit, apparent minor
  [BLUE, { nsfw: 0.92, apparentAge: 30, realPerson: 0.95 }], // mock: explicit, real person
  [GREY, "down"], // the classifier fails on this one
];
const classifierGate = createMediaGate({
  async score(bytes) {
    const hit = SCORES.find(([img]) => sha256Hex(img) === sha256Hex(bytes));
    const s = hit?.[1] ?? { nsfw: 0.02, apparentAge: null };
    if (s === "down") throw new Error("classifier down");
    return { frames: [s] };
  },
}, { timeoutMs: 2000 });

let h: Harness;
let auth: Record<string, string>;
let accountId: string;

beforeAll(async () => {
  h = await startRouter({
    providers: [
      { id: "alpha", name: "Alpha", models: [MODELS.llama] },
      { id: "beta", name: "Beta", models: [MODELS.llama, MODELS.qwen] },
    ],
  });
  const k = await h.fundedKey(20n);
  auth = k.auth;
  accountId = (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId;
  await blockHashes(h.ctx.db, [sha256Hex(GREY)], "real_person", "operator", null);
});
afterAll(async () => h?.close());
beforeEach(() => {
  csamCalls = [];
  lookups = [];
  floorSeen = [];
  h.ctx.anonymo.floor = allow;
  setChatPhotoServices(h.ctx, { blocklist: recordingList(dbHashBlocklist(h.ctx.db)), csam: csam({ sendsOutside: false }), classifier: null, required: false, classifierInEnclave: undefined });
});

const post = (json: unknown, headers: Record<string, string> = {}) => h.request("/v1/chat/completions", { method: "POST", headers: { ...auth, ...headers }, json });
const providerCalls = () => Object.values(h.mocks).reduce((n, m) => n + m.stats.requests, 0);
const effects = async () => ({
  providerCalls: providerCalls(),
  holds: (await h.ctx.db.select({ id: holds.id }).from(holds).where(eq(holds.accountId, accountId))).length,
  balance: (await balanceOf(h.ctx.db, accountId)).balance,
});
async function untouched(res: Promise<Response>, status: number) {
  const before = await effects();
  const r = await res;
  const j = (await r.json()) as any;
  expect(r.status).toBe(status);
  expect(r.headers.get("x-anonymo-refusal")).toBeNull();
  expect(await effects()).toEqual(before);
  return j.error as { type: string; message: string; metadata?: Record<string, unknown> };
}

describe("a passing photo", () => {
  test("reaches the provider exactly as sent, after the upload rule ran once for each image and before the floor", async () => {
    const body = ask(dataUrl(GREEN), dataUrl(png([10, 20, 200])));
    const before = Object.values(h.mocks).map((m) => m.stats.requests);
    const r = await post(body);
    expect(r.status).toBe(200);
    const served = Object.values(h.mocks).filter((m, i) => m.stats.requests > before[i]);
    expect(served.length).toBe(1);
    expect(served[0].stats.lastBody.messages).toEqual(body.messages);
    expect(lookups).toEqual([sha256Hex(GREEN), sha256Hex(png([10, 20, 200]))]);
    expect(csamCalls).toEqual(lookups);
    // The floor still reads the text, knows there was an upload, and never gets the image bytes as text.
    const prompts = floorSeen.filter((i) => i.stage !== "reply");
    expect(prompts.length).toBe(1);
    expect(prompts[0].hasUpload).toBe(true);
    expect(prompts[0].text).toContain("What colour is this?");
    expect(prompts[0].text).not.toContain(b64(GREEN).slice(0, 24));
  });

  test("a text-only chat never calls the upload rule", async () => {
    expect((await post({ model, max_tokens: 10, messages: [{ role: "user", content: "hello" }] })).status).toBe(200);
    expect(lookups.length + csamCalls.length).toBe(0);
  });
});

describe("a blocked photo is 451, never rerouted, and nothing is sent, held or charged", () => {
  test("a hash on our block list", async () => {
    const e = await untouched(post({ ...ask(dataUrl(GREEN), dataUrl(GREY)), models: [model, MODELS.qwen.slug] }), 451);
    expect(e.type).toBe("floor_blocked");
    expect(e.metadata).toEqual({ category: "real_person" });
    expect(floorSeen.length).toBe(0); // the upload rule runs before the floor and the refusal catch
  });

  test("a CSAM hash match", async () => {
    const e = await untouched(post({ ...ask(dataUrl(PURPLE)), models: [model, MODELS.qwen.slug] }), 451);
    expect(e.type).toBe("floor_blocked");
    expect(e.metadata).toEqual({ category: "minor" });
    expect(csamCalls).toEqual([sha256Hex(PURPLE)]);
  });

  test("the media classifier: an explicit image of an apparent minor or a real person", async () => {
    setChatPhotoServices(h.ctx, { classifier: classifierGate });
    expect((await untouched(post(ask(dataUrl(AMBER))), 451)).metadata).toEqual({ category: "minor" });
    expect((await untouched(post(ask(dataUrl(BLUE))), 451)).metadata).toEqual({ category: "real_person" });
    expect((await post(ask(dataUrl(GREEN)))).status).toBe(200);
  });

  test("a classifier that cannot score fails closed (503)", async () => {
    setChatPhotoServices(h.ctx, { classifier: classifierGate, blocklist: { lookup: async () => null } });
    expect((await untouched(post(ask(dataUrl(GREY))), 503)).type).toBe("uploads_unavailable");
  });
});

describe("production without a CSAM hash service", () => {
  test("until a hash client is wired in, images pass exactly as before: no checks, links allowed", async () => {
    const prod = buildChatPhotoServices(h.ctx, { ANONYMO_ENV: "production" });
    expect(prod.required).toBe(true);
    expect(prod.ready).toBe(false);
    setChatPhotoServices(h.ctx, prod);
    expect((await post(ask(dataUrl(GREEN)))).status).toBe(200);
    expect((await post(ask("https://images.example/cat.jpg"))).status).toBe(200);
    expect(lookups.length + csamCalls.length).toBe(0);
  });

  test("once ready in production, a check that cannot run refuses the photo with a clear 503, nothing charged", async () => {
    setChatPhotoServices(h.ctx, { ...buildChatPhotoServices(h.ctx, { ANONYMO_ENV: "production" }), ready: true });
    const e = await untouched(post(ask(dataUrl(GREEN))), 503);
    expect(e.type).toBe("uploads_unavailable");
    expect(e.message).toContain("Photos in chat open once image checks are available");
    expect(floorSeen.length).toBe(0);
    expect((await post({ model, max_tokens: 10, messages: [{ role: "user", content: "hello" }] })).status).toBe(200);
  });

  test("ANONYMO_FLOOR_REQUIRED and ANONYMO_UPLOADS_REQUIRED are required mode too; development is not", () => {
    expect(buildChatPhotoServices(h.ctx, { ANONYMO_FLOOR_REQUIRED: "1" }).required).toBe(true);
    expect(buildChatPhotoServices(h.ctx, { ANONYMO_UPLOADS_REQUIRED: "true" }).required).toBe(true);
    const dev = buildChatPhotoServices(h.ctx, { ANONYMO_ENV: "development" });
    expect(dev.required).toBe(false);
    expect(dev.classifier).toBeNull();
  });
});

describe("what is refused before any check", () => {
  test("a remote image link (https or http) is a 400: we cannot check what we do not fetch", async () => {
    for (const url of ["https://images.example/cat.jpg", "http://images.example/cat.png"]) {
      const e = await untouched(post(ask(url)), 400);
      expect(e.type).toBe("remote_image_unsupported");
      expect(e.message).toContain("does not fetch images");
    }
    expect(lookups.length + csamCalls.length + floorSeen.length).toBe(0);
  });

  test("more than four images", async () => {
    const five = [0, 1, 2, 3, 4].map((i) => dataUrl(png([i * 40, 10, 10])));
    expect((await untouched(post(ask(...five)), 400)).type).toBe("too_many_images");
    expect(lookups.length).toBe(0);
  });

  test("an image over 5 MB once decoded", async () => {
    const big = new Uint8Array(MAX_CHAT_PHOTO_BYTES + 16);
    big.set(GREEN.subarray(0, 8));
    expect((await untouched(post(ask(dataUrl(big))), 413)).type).toBe("image_too_large");
  });

  test("only JPEG, PNG, WebP and GIF, and the bytes must match the declared type", async () => {
    expect((await untouched(post(ask(dataUrl(GREEN, "image/svg+xml"))), 415)).type).toBe("unsupported_image_type");
    expect((await untouched(post(ask(dataUrl(GREEN, "image/bmp"))), 415)).type).toBe("unsupported_image_type");
    expect((await untouched(post(ask(dataUrl(GREEN, "image/jpeg"))), 400)).type).toBe("invalid_image");
    expect((await untouched(post(ask(dataUrl(new TextEncoder().encode("plain text, not an image")))), 400)).type).toBe("invalid_image");
    expect((await untouched(post(ask("data:image/png;base64,@@@@")), 400)).type).toBe("invalid_image");
    expect(lookups.length).toBe(0);
  });

  test("sealed and private requests: refused (409) before the hash service or the classifier sees anything", async () => {
    setChatPhotoServices(h.ctx, { csam: csam(), classifier: classifierGate });
    const e1 = await untouched(post({ ...ask(dataUrl(GREEN)), provider: { private: true } }), 409);
    const e2 = await untouched(post(ask(dataUrl(GREEN)), { "x-anonymo-sealed": "required" }), 409);
    const e3 = await untouched(post({ ...ask(dataUrl(GREEN)), model: `${model}:private` }), 409);
    for (const e of [e1, e2, e3]) {
      expect(e.type).toBe("sealed_unavailable");
      expect(e.message).toContain("Photos in sealed and private chats");
    }
    expect(csamCalls.length + lookups.length + floorSeen.length).toBe(0);
  });
});

describe("unit", () => {
  test("photoChecksLeaveProcess: outside unless every check says it stays in process or in the enclave", () => {
    const base = { blocklist: { lookup: async () => null }, required: false } as const;
    expect(photoChecksLeaveProcess({ ...base, csam: csam({ sendsOutside: false }), classifier: null })).toBe(false);
    expect(photoChecksLeaveProcess({ ...base, csam: { match: async () => ({ matched: false }) }, classifier: null })).toBe(true);
    expect(photoChecksLeaveProcess({ ...base, csam: csam({ inEnclave: true }), classifier: null })).toBe(false);
    expect(photoChecksLeaveProcess({ ...base, csam: csam({ sendsOutside: false }), classifier: classifierGate })).toBe(true);
    expect(photoChecksLeaveProcess({ ...base, csam: csam({ sendsOutside: false }), classifier: classifierGate, classifierInEnclave: true })).toBe(false);
  });

  test("chatPhotosOf reads only content-array image parts and accepts both image_url shapes", () => {
    const url = dataUrl(GREEN);
    const photos = chatPhotosOf({ messages: [{ role: "user", content: [{ type: "image_url", image_url: url }, { type: "image_url", image_url: { url } }] }, { role: "user", content: "no parts" }] });
    expect(photos.map((p) => [p.at, p.mime])).toEqual([["messages.0.content.0", "image/png"], ["messages.0.content.1", "image/png"]]);
    expect(chatPhotosOf({ messages: [{ role: "user", content: [{ type: "text", text: url }] }] })).toEqual([]);
    expect(() => chatPhotosOf({ messages: [{ role: "user", content: [{ type: "input_image", image_url: url }] }] })).toThrow();
    expect(() => chatPhotosOf({ messages: [{ role: "user", content: [{ type: "image_url" }] }] })).toThrow();
  });
});

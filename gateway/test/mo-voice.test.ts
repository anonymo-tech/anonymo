import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { FRAME_BYTES, SAMPLE_RATE, micWav } from "../src/anonymo/voice/audio.ts";
import { STOCK_IDS, compareStock, voiceTraits } from "../src/anonymo/voice/design.ts";
import { crisisSignal } from "../src/anonymo/voice/region.ts";
import { VoiceSession, type CallReceipt } from "../src/anonymo/voice/session.ts";
import { handshake, voiceWebsocket } from "../src/anonymo/voice/socket.ts";
import { MediaCatalog } from "../src/anonymo/media/catalog.ts";
import { setMediaServices } from "../src/anonymo/media/services.ts";
import { loadConfig } from "../src/config.ts";
import { deployedInventory } from "../src/privacy/inventory.ts";
import { designedVoices, generations, keys, ledger, offers } from "../src/db/schema.ts";
import { startRouter, type Harness } from "./helpers.ts";

const registry = Object.fromEntries(STOCK_IDS.map((id) => [id, [1, 0, 0, 0, 0, 0, 0, 0]]));
const nearStock = [0.99, 0.01, 0, 0, 0, 0, 0, 0];
const original = [0, 1, 0, 0, 0, 0, 0, 0];
const silence = Buffer.alloc(FRAME_BYTES);
const speaking = Buffer.alloc(FRAME_BYTES);
for (let i = 0; i < FRAME_BYTES; i += 2) speaking.writeInt16LE(i % 4 ? 1800 : -1800, i);
const transcript = "The observatory has a red door.";
const reply = "The telescope is ready.";
const refusal = "I'm sorry, but I can't help with that request.";
const waitAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
function phones(session: VoiceSession) {
  for (let i = 0; i < 15; i++) session.mic(speaking);
  for (let i = 0; i < 28; i++) session.mic(silence);
}

test("feature switch defaults off and removes voice storage and readers from the deployed inventory", () => {
  expect(loadConfig({ ANONYMO_ENV: "test" }).features.moVoice).toBe(false);
  const off = deployedInventory({ ventures: false, moVoice: false });
  const on = deployedInventory({ ventures: false, moVoice: true });
  expect(JSON.stringify(off)).not.toMatch(/src\/anonymo\/voice\/|designed_voices|mo-voice-live/);
  expect(on.postgres.tables.some((table) => table.name === "designed_voices")).toBe(true);
  expect(JSON.stringify(on)).toContain("mo-voice-live");
});

test("speech-triggered barge-in cancels generation and pending synthesis, and stale frames never play", async () => {
  const chats: AbortSignal[] = [];
  const tts: AbortSignal[] = [];
  const media: ArrayBuffer[] = [];
  const events: { type?: string; text?: string }[] = [];
  const started = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  const turn = new VoiceSession(
    {
      send: (data) => { events.push(data); if ((data as { type: string }).type === "idle") idle.resolve(); },
      audio: (wav) => media.push(wav), close() {},
    },
    {
      async transcribe() { return { text: transcript, cost: 0n }; },
      async *chat(_, signal) {
        chats.push(signal);
        yield { text: chats.length === 1 ? "An interrupted sentence." : reply };
        if (chats.length === 1) yield await waitAbort(signal);
        yield { usage: { routes: [], tokens: { in: 5, out: 3 }, cost: 0n } };
      },
      async speak(_, signal) {
        tts.push(signal);
        if (tts.length === 1) {
          started.resolve();
          try { await waitAbort(signal); } catch { /* An upstream can answer after it was cancelled. */ }
        }
        return { wav: new ArrayBuffer(8), cost: 0n };
      },
    },
    (payload) => payload, "A fictional voice call.", crisisSignal,
  );
  turn.ready();
  phones(turn);
  await started.promise;
  phones(turn);
  await idle.promise;
  expect(chats[0].aborted).toBe(true);
  expect(tts[0].aborted).toBe(true);
  expect(chats).toHaveLength(2);
  expect(media).toHaveLength(1);
  expect(events.filter((e) => e.type === "interrupt")).toHaveLength(2);
  await turn.end(false);
});

test("muting discards the pending phrase and crisis signals interrupt the call before dispatch", async () => {
  const events: { type?: string }[] = [];
  let n = 0;
  let chat = 0;
  const detected = Promise.withResolvers<void>();
  const session = new VoiceSession(
    { send: (event) => { events.push(event); if ((event as { type: string }).type === "crisis") detected.resolve(); }, audio() {}, close() {} },
    {
      async transcribe() { n++; return { text: "I want to die.", cost: 0n }; },
      async *chat() { chat++; },
      async speak() { throw new Error("unexpected speech"); },
    },
    (p) => p, "", crisisSignal,
  );
  session.ready();
  for (let i = 0; i < 6; i++) session.mic(speaking);
  session.mute(true);
  phones(session);
  session.mute(false);
  phones(session);
  await detected.promise;
  expect(n).toBe(1);
  expect(chat).toBe(0);
  expect(events.some((e) => e.type === "crisis")).toBe(true);
  await session.end(false);
});

test("traits exclude impersonation and the registry rejects near duplicates and fails closed when incomplete", () => {
  expect(voiceTraits("warm, Low, slightly husky")).toBe("warm low slightly husky");
  for (const description of ["imitate the radio announcer", "data:audio/wav;base64,AAAA", "https://example.invalid/sample.wav"])
    expect(() => voiceTraits(description)).toThrow("Describe pitch");
  expect(() => compareStock(nearStock, registry)).toThrow("too close to a stock voice");
  expect(() => compareStock(original, registry)).not.toThrow();
  expect(() => compareStock(original, {})).toThrow("Stock voice verification is unavailable");
});

let h: Harness;
let auth: HeadersInit;
let other: HeadersInit;
let hash: string;
let worker: ReturnType<typeof Bun.serve>;
let listen: ReturnType<typeof Bun.serve>;
let speechClip: ArrayBuffer;
let traceCalls = 0;
let ttsCalls = 0;
let generated: number[] = original;
const workerBodies: unknown[] = [];

beforeAll(async () => {
  speechClip = await micWav(Array.from({ length: 50 }, () => speaking)).arrayBuffer();
  worker = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/stock-embeddings")) return Response.json(registry);
      workerBodies.push(await request.json());
      if (path.endsWith("/design")) return Response.json({ embedding: generated });
      if (path.endsWith("/speech")) return new Response(speechClip, { headers: { "content-type": "audio/wav" } });
      return new Response(null, { status: 404 });
    },
  });
  const model = (id: string) => ({ id, slug: "anonymo-1", prompt: "0.000001", completion: "0.000001", ctx: 32768 });
  h = await startRouter({
    providers: [
      { id: "early", name: "Early", models: [model("early-mistral")], reply: () => refusal },
      { id: "retry", name: "Retry", models: [model("retry-qwen")], reply: () => reply },
    ],
    env: {
      ANONYMO_FEATURE_MO_VOICE: "true",
      ANONYMO_VOICE_DESIGN_URL: worker.url.origin,
      ANONYMO_LIVEKIT_URL: "wss://sfu.example.invalid",
      ANONYMO_LIVEKIT_KEY: "fixture-issuer", // gitleaks:allow
      ANONYMO_LIVEKIT_SECRET: "fixture-livekit-signing-material", // gitleaks:allow
    },
    rand: () => 0,
  });
  await h.ctx.db.update(offers).set({ tier: 0, upstream: "venice", family: "mistral" }).where(eq(offers.providerId, "early"));
  await h.ctx.db.update(offers).set({ tier: 1, upstream: "selfhost", family: "qwen" }).where(eq(offers.providerId, "retry"));
  await h.ctx.catalog.refresh();
  setMediaServices(h.ctx, {
    catalog: MediaCatalog.fromEnv({ ANONYMO_NANOGPT_API_KEY: "fixture-key" }), // gitleaks:allow
    offered: new Set(["tts", "nanogpt"]),
    transcription: { async transcribe({ file }) {
      expect(file.type).toBe("audio/wav");
      return transcript;
    } },
    speech: { async speak() {
      ttsCalls++;
      return { bytes: new Uint8Array(speechClip), mime: "audio/wav" };
    } },
  });
  const key = await h.fundedKey();
  auth = key.auth;
  hash = key.hash;
  other = (await h.fundedKey()).auth;
  await h.ctx.db.update(keys).set({ tracing: { provider: "otel", include_content: true, endpoint: "https://trace.example.invalid" } }).where(eq(keys.keyHash, hash));
  h.ctx.tracing.enqueue = () => { traceCalls++; };
  listen = Bun.serve({
    hostname: "127.0.0.1", port: 0, websocket: voiceWebsocket,
    fetch(request, server) {
      const incoming = handshake(h.ctx, request, server);
      return h.app.fetch(incoming.request, incoming.env.voiceUpgrade ? incoming.env : server);
    },
  });
});

afterAll(async () => {
  listen?.stop(true);
  worker?.stop(true);
  await h?.close();
});

const sessions = (json: unknown, headers = auth) => h.request("/v1/voice/sessions", { method: "POST", headers, json });
const preview = (json: unknown, headers = auth) => h.request("/v1/voice/voices/preview", { method: "POST", headers, json });
const save = (json: unknown, headers = auth) => h.request("/v1/voice/voices", { method: "POST", headers, json });

async function connect(voice = "kokoro:af_alloy") {
  const r = await sessions({});
  expect(r.status).toBe(200);
  const ticket = await r.json() as { path: string; protocol: string; ticket: string };
  const url = new URL(ticket.path, listen.url);
  url.protocol = "ws:";
  const ws = new WebSocket(url, [ticket.protocol, ticket.ticket]);
  const messages: any[] = [];
  let wavs = 0;
  let check: (() => void) | undefined;
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "start", voice })));
  ws.addEventListener("message", ({ data }) => {
    if (typeof data === "string") messages.push(JSON.parse(data));
    else wavs++;
    check?.();
  });
  async function until(type: string) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${type}; events: ${messages.map((m) => m.type)}`)), 5000);
      check = () => {
        const found = messages.find((m) => m.type === type);
        if (found) { clearTimeout(timer); check = undefined; resolve(found); }
      };
      check();
    });
  }
  await until("ready");
  return {
    ws, until, messages, ticket, url, wavs: () => wavs,
    talk() { for (let i = 0; i < 43; i++) ws.send(i < 15 ? speaking : silence); },
    async hangup() { ws.send(JSON.stringify({ type: "hangup" })); return (await until("receipt")).receipt; },
  };
}

test("WebSocket call reroutes inside one turn, delivers audio and signs both routes and exact media usage", async () => {
  const call = await connect();
  try {
    call.talk();
    await call.until("idle");
    const r = await call.hangup() as { payload: CallReceipt; sig: string; key_id: string };
    expect(call.wavs()).toBe(1);
    expect(call.messages.some((e) => e.type === "caption" && e.text === reply)).toBe(true);
    expect(JSON.stringify(call.messages)).not.toContain(refusal);
    expect(r.payload).toMatchObject({
      stt_seconds: 27 * FRAME_BYTES / 2 / SAMPLE_RATE,
      tts_characters: reply.length,
      routes: [{ provider: "early", refused: true, cost: "0" }, { provider: "retry", refused: false }],
    });
    expect(r.payload.llm_tokens.out).toBeGreaterThan(0);
    expect(await h.ctx.signer.verify(r.payload, r.sig, r.key_id)).toBe(true);
    const rows = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, hash));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain(transcript);
    expect(JSON.stringify(r.payload)).not.toContain(reply);
    expect(traceCalls).toBe(0);
    const debits = await h.ctx.db.select().from(ledger).where(eq(ledger.keyHash, hash));
    const netRefusal = debits.filter((r) => ["refused_usage", "refusal_refund"].includes(r.kind)).reduce((sum, row) => sum + row.amount, 0n);
    expect(netRefusal).toBe(0n);
    expect(debits.some((r) => r.kind === "refusal_refund")).toBe(true);
    expect(debits.find((r) => r.kind === "media_speech")?.amount).toBe(-500_000_000n);
  } finally { call.ws.close(); }
});

test("a socket ticket can be upgraded once and rejects synthesis reference controls", async () => {
  const call = await connect();
  try {
    expect(call.ws.protocol).toBe(call.ticket.protocol);
    const replay = new WebSocket(call.url, [call.ticket.protocol, call.ticket.ticket]);
    const replayed = await new Promise<boolean>((resolve) => {
      replay.addEventListener("open", () => resolve(true), { once: true });
      replay.addEventListener("error", () => resolve(false), { once: true });
    });
    expect(replayed).toBe(false);
    call.ws.send(JSON.stringify({ type: "start", voice: "kokoro:af_alloy", reference_audio: "UklGRg==" }));
    expect(await call.until("error")).toMatchObject({ code: "invalid_voice_request" });
    expect(call.wavs()).toBe(0);
  } finally { call.ws.close(); }
});

test("a double refusal stays in captions and charges zero for generation and synthesis", async () => {
  h.mocks.retry.cfg.reply = () => refusal;
  const call = await connect();
  try {
    call.talk();
    await call.until("idle");
    const summary = await call.hangup();
    expect(call.messages.some((e) => e.type === "caption" && e.text === refusal)).toBe(true);
    expect(call.wavs()).toBe(0);
    expect(summary.payload.routes).toMatchObject([{ refused: true, cost: "0" }, { refused: true, cost: "0" }]);
    expect(summary.payload.tts_characters).toBe(0);
  } finally { h.mocks.retry.cfg.reply = () => reply; call.ws.close(); }
});

test("a floor block never reaches chat providers, the refusal classifier, or synthesis", async () => {
  const before = [h.mocks.early.stats.requests, h.mocks.retry.stats.requests, ttsCalls];
  const floor = h.ctx.anonymo.floor;
  const classifier = h.ctx.anonymo.refusal;
  let classified = 0;
  h.ctx.anonymo.floor = { async check(input) { return input.text.includes(transcript) ? { ok: false, category: "voice_clone" } : { ok: true }; } };
  h.ctx.anonymo.refusal = { async isRefusal() { classified++; return false; } };
  const call = await connect();
  try {
    call.talk();
    expect(await call.until("error")).toMatchObject({ code: "floor_blocked", status: 451 });
    const r = await call.hangup();
    expect(r.payload.routes).toEqual([]);
    expect(r.payload.tts_characters).toBe(0);
    expect([h.mocks.early.stats.requests, h.mocks.retry.stats.requests, ttsCalls]).toEqual(before);
    expect(classified).toBe(0);
  } finally { h.ctx.anonymo.floor = floor; h.ctx.anonymo.refusal = classifier; call.ws.close(); }
});

test("stock similarity happens before synthesis, preview save is key-scoped, and the call can use the saved design", async () => {
  generated = nearStock;
  const refused = await preview({ description: "warm, low, slightly husky" });
  expect(refused.status).toBe(451);
  expect(await refused.json()).toMatchObject({ error: { type: "stock_voice_similarity" } });
  generated = original;
  const allowed = await preview({ description: "warm, low, slightly husky" });
  expect(allowed.status).toBe(200);
  const clip = await allowed.json() as { preview_id: string; audio: string; cost: string; embedding?: unknown };
  expect(clip.audio.length).toBeGreaterThan(100);
  expect(clip.embedding).toBeUndefined();
  expect(clip.cost).toBe("0.0005");
  expect((await save({ preview_id: clip.preview_id, name: "Evening" }, other)).status).toBe(404);
  const r = await save({ preview_id: clip.preview_id, name: "Evening" });
  expect(r.status).toBe(201);
  const row = await r.json() as { id: string };
  expect(row.id).toBe(clip.preview_id);
  const retry = await save({ preview_id: clip.preview_id, name: "Evening" });
  expect(retry.status).toBe(200);
  expect((await h.ctx.db.select().from(designedVoices))).toHaveLength(1);
  const listing = await h.request("/v1/voice/voices", { headers: auth });
  expect(await listing.json()).toMatchObject({ designed: [{ id: row.id, name: "Evening" }] });
  const otherListing = await h.request("/v1/voice/voices", { headers: other });
  expect(await otherListing.json()).toMatchObject({ designed: [] });
  const call = await connect(`designed:${row.id}`);
  try {
    call.talk();
    await call.until("idle");
    await call.hangup();
    expect(call.wavs()).toBe(1);
    expect(workerBodies).toContainEqual({ model: "qwen3-tts", input: reply, embedding: original, response_format: "wav" });
  } finally { call.ws.close(); }
});

test("all synthesis and design entry points reject audio-reference requests before providing a clip", async () => {
  const fakeAudio = "data:audio/wav;base64,UklGRg==";
  const malformed = [
    ["/v1/voice/sessions", { transport: "livekit", audio: fakeAudio }],
    ["/v1/voice/voices", { preview_id: crypto.randomUUID(), name: "Evening", embedding: original }],
    ["/v1/voice/voices/preview", { description: "soft", reference_audio: fakeAudio }],
  ] as const;
  const workerCalls = workerBodies.length;
  for (const [path, json] of malformed) {
    expect((await h.request(path, { method: "POST", headers: auth, json })).status).toBe(400);
    expect((await h.request(path, { method: "POST", headers: { ...auth, "content-type": "audio/wav" }, body: speechClip })).status).toBe(415);
  }
  expect((await h.request("/v1/voice/media", { method: "POST", headers: auth, json: { reference_audio: fakeAudio } })).status).toBe(404);
  expect(workerBodies).toHaveLength(workerCalls);

  const media = await startRouter({ providers: [], env: { ANONYMO_FEATURE_MO_VOICE: "true", ANONYMO_FEATURE_MEDIA: "true" } });
  try {
    const { auth: headers } = await media.fundedKey();
    expect((await media.request("/v1/voice/socket", { headers })).status).toBe(426);
    for (const path of ["/v1/audio/speech", "/api/v1/audio/speech"]) {
      for (const json of [
        { model: "kokoro", input: "Hello", reference_audio: fakeAudio },
        { model: "kokoro", input: { audio: fakeAudio } },
        { model: "kokoro", input: fakeAudio },
        { model: "kokoro", input: "Hello", voice: { audio: fakeAudio } },
      ]) expect((await media.request(path, { method: "POST", headers, json })).status).toBe(400);
      const form = new FormData();
      form.set("file", new File([speechClip], "reference.wav", { type: "audio/wav" }));
      expect((await media.request(path, { method: "POST", headers, body: form })).status).toBe(415);
    }
  } finally { await media.close(); }
});

test("ticket minting requires a funded key and LiveKit grants microphone access only", async () => {
  const unspent = await h.newKey();
  expect((await sessions({ transport: "livekit" }, unspent.auth)).status).toBe(402);
  const result = await sessions({ transport: "livekit" });
  expect(result.status).toBe(200);
  const ticket = await result.json() as { room: string; token: string; codec: string; sample_rate: number };
  expect(ticket.codec).toBe("opus");
  expect(ticket.sample_rate).toBe(48_000);
  const [header, claims, signature] = ticket.token.split(".");
  expect(signature).toBe(createHmac("sha256", h.ctx.cfg.moVoice.livekit.secret!).update(`${header}.${claims}`).digest("base64url"));
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({
    iss: "fixture-issuer",
    video: { room: ticket.room, roomJoin: true, canPublishSources: ["microphone"], canPublishData: false },
  });
});

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { MediaCatalog } from "../../src/anonymo/media/catalog.ts";
import { nanogptSpeechAdapter } from "../../src/anonymo/media/nanogpt-speech.ts";
import { mediaServices, setMediaServices } from "../../src/anonymo/media/services.ts";
import { transcriptionMinutes } from "../../src/anonymo/media/transcription.ts";
import { KOKORO_ID, NANOGPT_KOKORO_VOICES, TRANSCRIPTION_FORMATS, TRANSCRIPTION_MAX_BYTES, WHISPER_ID } from "../../src/anonymo/media/voice-models.ts";
import { holds, keys } from "../../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../../src/ledger/ledger.ts";
import { usdToPico } from "../../src/lib/money.ts";
import { startRouter, type Harness } from "../helpers.ts";
import { toneWav } from "./fixtures.ts";

const priceEnv = {
  ANONYMO_NANOGPT_API_KEY: "demo-key",
  ANONYMO_NANOGPT_SPEECH_USD_KOKORO: "0.004",
  ANONYMO_NANOGPT_TRANSCRIPTION_USD_WHISPER: "0.002",
};
const SPEECH = "/v1/audio/speech";
const STT = "/v1/audio/transcriptions";
const INPUT = "speech-input-canary";
const TRANSCRIPT = "speech-text-canary";
const AUDIO = "speech-file-canary";
const wav = (seconds = 0.5, rate = 16_000) => toneWav(seconds, rate, 440, { id: "LIST", text: AUDIO });
const responseWav = () => new Response(toneWav() as Uint8Array<ArrayBuffer>, { headers: { "content-type": "audio/wav" } });

let h: Harness;
let auth: Record<string, string>;
let accountId: string;
let floorCalls: string[];
let requests: Request[];
let reply: (req: Request) => Response | Promise<Response>;

beforeAll(async () => {
  h = await startRouter({ env: { ANONYMO_FEATURE_MEDIA: "true" } });
  const k = await h.fundedKey(1n);
  auth = k.auth;
  accountId = (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId;
  const adapter = nanogptSpeechAdapter({
    base: "https://voice.invalid/api/v1/", apiKey: "demo-key",
    fetch: (async (url, init) => {
      const req = new Request(url, init);
      requests.push(req.clone());
      return reply(req);
    }) as typeof fetch,
  });
  setMediaServices(h.ctx, { catalog: MediaCatalog.fromEnv(priceEnv), offered: new Set(["nanogpt"]), nanogptSpeech: adapter, transcription: adapter });
});

beforeEach(() => {
  requests = [];
  floorCalls = [];
  h.ctx.anonymo.floor = { async check({ text }) { floorCalls.push(text); return { ok: true }; } };
  reply = (req) => req.url.endsWith(SPEECH) ? responseWav() : Response.json({ text: TRANSCRIPT, duration: 1 });
});
afterAll(async () => h?.close());

const balance = async () => (await balanceOf(h.ctx.db, accountId)).balance;
const postSpeech = (patch = {}) => h.request(SPEECH, { method: "POST", headers: auth, json: { model: KOKORO_ID, input: INPUT, voice: "af_alloy", ...patch } });
function postAudio(bytes: Uint8Array, { path = STT, filename = "sample.wav", headers = auth, model = WHISPER_ID, language = "EN" } = {}) {
  const form = new FormData();
  form.set("file", new File([bytes as Uint8Array<ArrayBuffer>], filename));
  form.set("model", model);
  if (language) form.set("language", language);
  return h.request(path, { method: "POST", headers, body: form });
}

test("catalog lists hosted audio only with a key and publishes its rates and exact 33 stock voices", async () => {
  expect(MediaCatalog.fromEnv({}).get("speech", KOKORO_ID)).toBeNull();
  expect(MediaCatalog.fromEnv({}).get("transcription", WHISPER_ID)).toBeNull();
  const defaults = MediaCatalog.fromEnv({ ANONYMO_NANOGPT_API_KEY: "demo-key" });
  expect(defaults.get("speech", KOKORO_ID)?.usdPer1kChars).toBe("0.003");
  expect(defaults.get("transcription", WHISPER_ID)?.usdPerMinute).toBe("0.001");
  const { data } = await (await h.request("/v1/media/models")).json() as { data: { id: string }[] };
  expect(data.find((m) => m.id === KOKORO_ID)).toMatchObject({
    name: "Kokoro", voices: NANOGPT_KOKORO_VOICES, max_chars: 10_000, pricing: { usd_per_1k_chars: "0.004" },
  });
  expect(new Set(NANOGPT_KOKORO_VOICES).size).toBe(33);
  expect(data.find((m) => m.id === WHISPER_ID)).toMatchObject({
    formats: ["mp3", "ogg", "wav", "m4a", "aac"], max_seconds: 300, max_request_bytes: 4_000_000,
    pricing: { usd_per_started_minute: "0.002" },
  });
});

test("hosted speech requests Kokoro WAV, checks the floor, stamps provenance and charges by character", async () => {
  const before = await balance();
  const res = await postSpeech({ voice: "bm_fable", speed: 1.25 });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-anonymo-provenance")).toBe("c2pa+watermark");
  expect(floorCalls).toEqual([INPUT]);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://voice.invalid/api/v1/audio/speech");
  expect(requests[0].headers.get("authorization")).toBe("Bearer demo-key");
  expect(await requests[0].json()).toEqual({ model: "Kokoro-82m", input: INPUT, speed: 1.25, voice: "bm_fable", response_format: "wav" });
  expect(await balance()).toBe(before - usdToPico("0.004") * BigInt(INPUT.length) / 1000n);
  expect((await mediaServices(h.ctx).provenance.verify(new Uint8Array(await res.arrayBuffer()))).ok).toBe(true);
});

test("speech refuses unknown voices, reference fields, excess input and floor blocks without upstream access", async () => {
  const before = await balance();
  for (const patch of [{ voice: "af_heart" }, { referenceAudio: "sample" }, { voice: { url: "sample" } }, { clone: null }, { input: "a".repeat(10_001) }, { speed: 2.1 }]) {
    expect((await postSpeech(patch)).status).toBe(400);
  }
  expect(floorCalls).toHaveLength(0);
  h.ctx.anonymo.floor = { async check() { return { ok: false, category: "minor" }; } };
  expect((await postSpeech()).status).toBe(451);
  expect(requests).toHaveLength(0);
  expect(await balance()).toBe(before);
});

test("Whisper receives only canonical multipart fields, returns text, and charges started minutes without a floor call", async () => {
  const before = await balance();
  const bytes = wav(61);
  const res = await postAudio(bytes, { path: "/api" + STT });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-anonymo-cost-usd")).toBe("0.004");
  expect(await res.json()).toEqual({ text: TRANSCRIPT });
  expect(floorCalls).toHaveLength(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://voice.invalid/api/v1/audio/transcriptions");
  expect(requests[0].headers.get("authorization")).toBe("Bearer demo-key");
  const upstream = await requests[0].formData();
  expect(upstream.get("model")).toBe("Whisper-Large-V3");
  expect(upstream.get("language")).toBe("en");
  expect(upstream.get("response_format")).toBe("json");
  const file = upstream.get("file") as File;
  expect(file.name).toBe("clip.wav");
  expect(file.type).toMatch(/^audio\/(x-)?wav$/);
  expect(Buffer.compare(Buffer.from(await file.arrayBuffer()), Buffer.from(bytes))).toBe(0);
  expect(await balance()).toBe(before - usdToPico("0.004"));
});

test("transcription rejects oversize, overlong, malformed, WebM, unauthorized and sealed requests before billing", async () => {
  const before = await balance();
  expect((await postAudio(new Uint8Array(TRANSCRIPTION_MAX_BYTES))).status).toBe(413);
  expect((await postAudio(wav(301, 6_000))).status).toBe(400);
  expect((await postAudio(new Uint8Array([1, 2, 3]))).status).toBe(400);
  expect((await postAudio(wav(), { filename: "sample.webm" })).status).toBe(415);
  expect((await postAudio(wav(), { language: "english" })).status).toBe(400);
  expect((await postAudio(wav(), { model: "demo-model" })).status).toBe(404);
  expect((await postAudio(wav(), { headers: {} })).status).toBe(401);
  expect((await postAudio(wav(), { headers: { ...auth, "x-anonymo-sealed": "required" } })).status).toBe(409);
  expect(requests).toHaveLength(0);
  expect(await balance()).toBe(before);
});

test("speech and transcription share the existing per-key rate limit", async () => {
  const k = await h.fundedKey(1n);
  await h.ctx.db.update(keys).set({ rpm: 1 }).where(eq(keys.keyHash, k.hash));
  expect((await postAudio(wav(), { headers: k.auth })).status).toBe(200);
  const limited = await h.request(SPEECH, { method: "POST", headers: k.auth, json: { model: KOKORO_ID, input: INPUT } });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
});

test("counts exact minute boundaries and reads the supported compressed formats", async () => {
  const signal = AbortSignal.timeout(10_000);
  expect(await transcriptionMinutes(new File([wav(60) as Uint8Array<ArrayBuffer>], "clip.wav"), "wav", signal)).toBe(1);
  expect(await transcriptionMinutes(new File([wav(300, 6_000) as Uint8Array<ArrayBuffer>], "clip.wav"), "wav", signal)).toBe(5);
  for (const [format, args] of [
    ["mp3", ["-f", "mp3"]],
    ["aac", ["-f", "adts"]],
    ["ogg", ["-c:a", "libopus", "-f", "ogg"]],
    ["m4a", ["-movflags", "frag_keyframe+empty_moov", "-f", "mp4"]],
  ] as const) {
    const fixture = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", ...args, "pipe:1"]);
    expect(fixture.exitCode).toBe(0);
    const file = new File([fixture.stdout], `clip.${format}`, { type: TRANSCRIPTION_FORMATS[format].mime });
    expect(await transcriptionMinutes(file, format, signal)).toBe(1);
  }
});

test("upstream failures release holds and the media store and database keep no content", async () => {
  const before = await balance();
  const s = mediaServices(h.ctx);
  const stored = s.store.size();
  expect((await postAudio(wav())).status).toBe(200);
  expect((await postSpeech()).status).toBe(200);
  const after = await balance();
  expect(after).toBeLessThan(before);
  reply = () => new Response(`{"bad":${TRANSCRIPT}`, { headers: { "content-type": "application/json" } });
  const failA = await postAudio(wav());
  const failB = await postSpeech();
  expect(failA.status).toBe(502);
  expect(failB.status).toBe(502);
  expect(await failA.text()).not.toContain(TRANSCRIPT);
  expect(await balance()).toBe(after);
  expect(s.store.size()).toBe(stored);
  expect((await h.ctx.db.select().from(holds).where(eq(holds.accountId, accountId))).every((x) => x.status !== "held")).toBe(true);
  const tables = (await h.ctx.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows;
  for (const { table_name } of tables) {
    const { rows } = await h.ctx.db.execute(sql`SELECT * FROM ${sql.identifier(String(table_name))}`);
    const dump = JSON.stringify(rows, (_key, v) => typeof v === "bigint" ? v.toString() : v);
    for (const marker of [INPUT, TRANSCRIPT, AUDIO, "RIFF", Buffer.from(wav()).toString("base64")]) expect(dump).not.toContain(marker);
  }
  expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
});

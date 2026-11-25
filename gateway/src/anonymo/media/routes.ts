import { everydayCoverage, keyEntitlements } from "../everyday/entitlements.ts";
// WS06 · Media endpoints, OpenAI-shaped, ported from Anonyma's /v1 media routes (Express/SQLite) to Hono/Drizzle.
//
//   POST /v1/images/generations   POST /v1/images/edits        POST /v1/audio/speech
//   POST /v1/audio/transcriptions uses the same caller and hold flow. No floor check or media storage.
//   POST /v1/video/generations    GET  /v1/video/generations/{id}  (asynchronous jobs, polled)
//   GET  /v1/media/{id}?expires&sig   short-lived signed download of an output
//   GET  /v1/media/models   GET /v1/media/provenance/keys   POST /v1/media/provenance/verify
// Each is also served under /api/v1.
//
// Every request runs, in order: key → validation → floor gate (ctx.anonymo.floor, never rerouted) → nudity prompt
// check (images and video, prompt-check.ts) → region rules →
// hold (reserve) → upstream → media gate on every visual output → provenance (watermark + signed C2PA manifest,
// self-verified) → delivery → settle. Any failure after the hold releases it, so a blocked, failed or unmarked
// output is never charged, stored or returned. Prompt text is never written anywhere (not even logs).
//
// Safe for work only, everywhere: every upstream is asked for safe output, and the media gate blocks any frame it
// scores as sexually explicit, in every region and for every key. Anonymo's adult content is text only.

import { randomBytes, randomInt } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Ctx } from "../../context.ts";
import { requireKey, requireRole, type KeyRow } from "../../api/auth.ts";
import { readJson } from "../../api/common.ts";
import { release, reserve, settle } from "../../ledger/ledger.ts";
import { ApiError, fail } from "../../lib/errors.ts";
import { picoToUsd, usdToPico, type Pico } from "../../lib/money.ts";
import { log } from "../../lib/util.ts";
import type { FloorInput } from "../seams.ts";
import { DEFAULT_MAX_IMAGES, type ImageModel, type MediaModel, type SpeechModel, type VideoModel } from "./catalog.ts";
import { containerFor, wavDuration, wavSeconds } from "./containers.ts";
import type { GateReason } from "./gate.ts";
import { ProvenanceError } from "./provenance.ts";
import { countryOf } from "./region.ts";
import { mediaJobs } from "./schema.ts";
import { mediaServices, regionRulesOf, type MediaServices } from "./services.ts";
import { checkMediaSignature, signedMediaPath, StoreFullError } from "./store.ts";
import { isStudioVerdict, stricterVerdict, type StudioSafety } from "./studio.ts";
import { readTranscription, transcriptionMinutes } from "./transcription.ts";
import { TRANSCRIPTION_FORMATS, TRANSCRIPTION_MAX_BYTES, TRANSCRIPTION_MAX_SECONDS, WHISPER_ID } from "./voice-models.ts";
import { UpstreamError, type Media, type SpeechUpstream } from "./upstreams.ts";

const MAX_PROMPT = 4000;
const MAX_VIDEO_PROMPT = 2000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_DEADLINE_MS = 240_000;
const VIDEO_HOLD_MS = 60 * 60_000;
// Fields that would carry a voice sample or a reference image into a model that only takes stock inputs.
const CLONE_FIELDS = ["reference_audio", "speaker_wav", "voice_sample", "audio", "audio_prompt", "prompt_audio", "voice_url", "clone", "reference_text", "speaker_audio", "voice_file"];
const SOUND_REFERENCE_FIELD = /reference|clone|speaker(?:id|wav|audio|file|sample)|(?:voice|audio)(?:url|file|sample|prompt|data|reference)/i;
const VIDEO_UPLOAD_FIELD = /^(?:(?:input|reference|first|last|start|end|source)?(?:image|video|audio)s?(?:url|dataurl|attachmentid|file)?|inputreference|(?:first|last|start|end)frame|references?)$/i;

class MediaBlocked extends Error {
  constructor(readonly reason: GateReason | "studio_unsafe") {
    super(reason);
  }
}

// ---- Small helpers -------------------------------------------------------------------------------------------------
const requestId = () => "med_" + randomBytes(12).toString("hex");
const priceOf = (usd: string, units: number) => usdToPico(usd) * BigInt(units);
const speechPrice = (m: SpeechModel, chars: number): Pico => (usdToPico(m.usdPer1kChars) * BigInt(chars) + 999n) / 1000n;
const usd = (p: Pico) => Number(picoToUsd(p));
const str = (v: unknown) => (typeof v === "string" ? v : "");

function parseSize(m: { sizes: string[]; defaultSize: string }, raw: unknown): { width: number; height: number; size: string } {
  const size = raw == null || raw === "auto" ? m.defaultSize : str(raw);
  if (!m.sizes.includes(size)) fail(400, `Choose a size this model offers: ${m.sizes.join(", ")}.`, "invalid_size");
  const [width, height] = size.split("x").map(Number);
  return { width, height, size };
}
function parseSeed(raw: unknown) {
  if (raw == null) return randomInt(0, 2 ** 31 - 1);
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > 2 ** 31 - 1) fail(400, "seed must be an integer from 0 to 2147483647.");
  return raw as number;
}
function modelOr404<T extends MediaModel>(m: T | null, kind: string): T {
  if (!m) fail(404, `Unknown ${kind} model. GET /v1/media/models lists them.`, "model_not_found");
  return m;
}

async function caller(ctx: Ctx, c: Context): Promise<KeyRow> {
  const key = await requireKey(ctx, c.req.header("authorization"));
  await limitMediaCaller(ctx, key);
  return key;
}

async function limitMediaCaller(ctx: Ctx, key: KeyRow) {
  await requireRole(ctx, key, ["owner", "admin", "member"]);
  const limit = key.rpm ?? ctx.cfg.limits.defaultRpm;
  const r = await ctx.limiter.take(`k:${key.keyHash}`, 1, limit, 60_000);
  if (!r.ok) fail(429, `Rate limit exceeded (${limit} requests/min). Retry in ${Math.ceil(r.retryAfterMs / 1000)}s.`, "rate_limited", { retry_after_ms: r.retryAfterMs }, { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
}

/** The floor gate, exactly as chat runs it: 451 with the category and no text on a block, 503 if it cannot answer. */
async function floorCheck(ctx: Ctx, input: FloorInput) {
  let verdict;
  try {
    verdict = await ctx.anonymo.floor.check(input);
  } catch {
    throw new ApiError(503, "The safety check is unavailable. Nothing was sent or charged; try again shortly.", "floor_unavailable");
  }
  if (!verdict.ok) throw new ApiError(451, "This request crosses a line Anonymo blocks for everyone. Nothing was sent or charged.", "floor_blocked", { category: verdict.category });
}

/** Images and video are safe for work only: a prompt asking for nudity or sex is refused before anything is sent. */
async function nudityCheck(s: MediaServices, prompt: string, signal: AbortSignal) {
  const v = await s.promptCheck.check(prompt, signal);
  if (!v.ok) throw new ApiError(451, "Anonymo makes no nude or sexual images or video. Nothing was sent or charged.", "explicit_media_unavailable", { stage: "prompt" });
}

async function checkVisualPrompt(ctx: Ctx, s: MediaServices, c: Context, input: FloorInput, o: ReceiptInput) {
  try {
    await floorCheck(ctx, input);
    await nudityCheck(s, input.text, c.req.raw.signal);
  } catch (error) {
    if (s.studio && error instanceof ApiError)
      throw studioFailure(ctx, error, o, { prompt: error.status === 451 ? "unsafe" : "unavailable", outputs: [] });
    throw error;
  }
}

function regionPolicy(ctx: Ctx, c: Context, s: MediaServices) {
  if (ctx.cfg.features.compliance) return; // The shared region gate already checked access.
  const policy = regionRulesOf(ctx, s).forCountry(countryOf(c));
  if (policy.blocked) fail(451, "Anonymo is not available in this region. Nothing was sent or charged.", "region_blocked");
}

/** A backstop for upstream metadata the format strippers do not know about: an output that carries the caller's
 *  prompt verbatim is refused rather than returned with the prompt baked into a shareable file. */
function echoesPrompt(bytes: Uint8Array, prompt: string) {
  const t = prompt.trim();
  if (t.length < 16) return false;
  const hay = Buffer.from(bytes);
  return [t.slice(0, 48), JSON.stringify(t).slice(1, 49)].some((needle) => hay.includes(Buffer.from(needle)));
}

const stripped = (m: Media) => {
  const c = containerFor(m.mime);
  try {
    return c?.matches(m.bytes) ? c.strip(m.bytes) : m.bytes;
  } catch {
    return m.bytes; // malformed: stamp() refuses it anyway
  }
};

/** Gate, then stamp: the only way an upstream's bytes become something we return. */
async function finishOutput(s: MediaServices, out: Media, o: { requestId: string; model: string; fromUpload?: boolean; prompt?: string; visual: boolean; signal?: AbortSignal; safety?: StudioSafety }): Promise<Media> {
  if (o.visual) {
    if (s.studio && o.safety) {
      const verdicts = await s.studio.output({ bytes: stripped(out), mime: out.mime }, o.signal);
      o.safety.outputs.push(verdicts);
      const verdict = stricterVerdict(verdicts.shieldgemma2, verdicts.llavaguard);
      if (verdict !== "safe") throw new MediaBlocked(verdict === "unsafe" ? "studio_unsafe" : "unscored");
    }
    // explicitAllowed is always false: no explicit image or video frame is ever returned (see the header).
    const verdict = await s.gate.assess(out.bytes, out.mime, { explicitAllowed: false, fromUpload: o.fromUpload, signal: o.signal });
    if (!verdict.ok) throw new MediaBlocked(verdict.reason);
  }
  // Checked after the known metadata chunks are stripped and before the watermark touches any bit.
  if (o.prompt && echoesPrompt(stripped(out), o.prompt)) throw new ProvenanceError("output carries the prompt");
  const bytes = await s.provenance.stamp(out.bytes, out.mime, { requestId: o.requestId, model: o.model });
  return { bytes, mime: out.mime };
}

/** Errors after the hold, mapped to OpenAI-shaped responses that never echo the prompt or upstream text. */
function mediaError(e: unknown, what: string): unknown {
  if (e instanceof MediaBlocked) {
    if (e.reason === "studio_unsafe") return new ApiError(451, `The ${what} did not pass the safe-for-work check. Nothing was charged.`, "media_blocked", { reason: e.reason, stage: "output" });
    if (e.reason === "unscored") return new ApiError(503, `The ${what} could not be safety-checked, so it was not returned. Nothing was charged; try again shortly.`, "media_gate_unavailable");
    if (e.reason === "explicit") return new ApiError(451, `Anonymo makes no explicit images or video. Nothing was returned or charged.`, "explicit_media_unavailable");
    return new ApiError(451, `The ${what} crossed a line Anonymo blocks for everyone. Nothing was returned, stored or charged.`, "media_blocked", { reason: e.reason });
  }
  if (e instanceof ProvenanceError) return new ApiError(502, `The ${what} could not be labelled with provenance, so it was not returned. Nothing was charged.`, "provenance_failed");
  if (e instanceof UpstreamError)
    return new ApiError(e.status, e.status === 503 ? `The ${what} provider is unavailable right now. Nothing was charged.` : e.rejected ? `The ${what} provider rejected this request. Nothing was charged.` : `The ${what} provider failed. Nothing was charged.`, e.status === 503 ? "upstream_unavailable" : e.rejected ? "upstream_rejected" : "upstream_failed");
  if (e instanceof StoreFullError) return new ApiError(503, "Media storage is full right now. Nothing was charged; try again shortly or ask for b64_json.", "media_store_full");
  return e;
}

type ReceiptInput = { requestId: string; model: MediaModel; units: number; unit: string };

function receipt(ctx: Ctx, o: ReceiptInput & { charged: Pico; outputs: Media[]; at?: Date; safety?: StudioSafety }) {
  const payload = {
    v: 1,
    kind: "media",
    request_id: o.requestId,
    model_id: o.model.id,
    routes: [`${o.model.upstream}:${o.model.upstreamModel}`],
    media_units: o.units,
    unit: o.unit,
    cost_usd: picoToUsd(o.charged),
    outputs_sha256: o.outputs.map((m) => new Bun.CryptoHasher("sha256").update(m.bytes).digest("hex")),
    provenance: o.outputs.length ? "c2pa+watermark" : null,
    ...(o.safety ? { safety: o.safety } : {}),
    ts: (o.at ?? new Date()).toISOString(),
  };
  const s = ctx.signer.sign(payload);
  return { payload, key_id: s.keyId, sig: s.sig };
}
export type StudioReceipt = ReturnType<typeof receipt>;
const receiptHeader = (r: StudioReceipt) => Buffer.from(JSON.stringify(r)).toString("base64url");
function studioFailure(ctx: Ctx, error: ApiError, o: ReceiptInput, safety: StudioSafety) {
  const r = receipt(ctx, { ...o, charged: 0n, outputs: [], safety });
  return new ApiError(error.status, error.message, error.type, error.metadata, {
    ...error.headers,
    "x-anonymo-receipt": receiptHeader(r),
    "x-anonymo-request-id": o.requestId,
  });
}
const absolute = (ctx: Ctx, path: string) => (ctx.cfg.publicUrl ? ctx.cfg.publicUrl + path : path);

async function charge(ctx: Ctx, holdId: string, amount: Pico, kind: string, description: string, coverageUnits?: number) {
  const r = await settle(ctx.db, holdId, amount, { kind, description, consumeCoverage: true, coverageUnits });
  return r.charged;
}

// ---- Images --------------------------------------------------------------------------------------------------------
type ImageInput = { model: ImageModel; prompt: string; n: number; width: number; height: number; seed: number; format: "url" | "b64_json"; upload?: Media };

function readImageFields(s: MediaServices, f: Record<string, unknown>, edit: boolean): Omit<ImageInput, "upload"> {
  const model = modelOr404(s.catalog.get("image", f.model), "image");
  if (model.edit !== edit) fail(400, edit ? "This model does not edit images; use /v1/images/generations." : "This model edits an uploaded image; use /v1/images/edits.", "wrong_endpoint");
  const prompt = str(f.prompt);
  if (!prompt.trim() || prompt.length > MAX_PROMPT) fail(400, `Enter a prompt of 1–${MAX_PROMPT.toLocaleString("en-US")} characters.`);
  const n = f.n == null ? 1 : Number(f.n);
  const maxImages = model.maxImages ?? DEFAULT_MAX_IMAGES;
  if (!Number.isInteger(n) || n < 1 || n > maxImages) fail(400, `n must be 1–${maxImages}.`);
  const format = f.response_format == null ? "url" : f.response_format;
  if (format !== "url" && format !== "b64_json") fail(400, 'response_format must be "url" or "b64_json".');
  return { model, prompt, n, ...parseSize(model, f.size), seed: parseSeed(f.seed == null ? undefined : Number(f.seed)), format };
}

function sniffUpload(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (Buffer.from(b.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
function uploadOf(bytes: Uint8Array): Media {
  if (!bytes.length) fail(400, "Attach the image to edit.");
  if (bytes.length > MAX_UPLOAD_BYTES) fail(413, "The image exceeds the 10 MB limit.", "payload_too_large");
  const mime = sniffUpload(bytes);
  if (!mime) fail(400, "The image must be a PNG, JPEG or WebP file.");
  return { bytes, mime };
}

async function readEditRequest(s: MediaServices, c: Context): Promise<ImageInput> {
  const type = c.req.header("content-type") ?? "";
  if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES + 1024 * 1024) fail(413, "The request exceeds the 10 MB upload limit.", "payload_too_large");
  if (type.startsWith("multipart/form-data")) {
    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await c.req.raw.formData();
    } catch {
      fail(400, "Send a valid multipart/form-data body.");
    }
    if (form.has("mask")) fail(400, "Masks are not supported.", "unsupported_parameter");
    const files = [...form.getAll("image"), ...form.getAll("image[]")].filter((v) => typeof v !== "string") as unknown as Blob[];
    if (files.length !== 1) fail(400, "Attach exactly one image as `image`.");
    const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
    return { ...readImageFields(s, fields, true), upload: uploadOf(new Uint8Array(await files[0].arrayBuffer())) };
  }
  const body = await readJson(c);
  if (body.mask != null) fail(400, "Masks are not supported.", "unsupported_parameter");
  const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(str(body.image));
  if (!m) fail(400, "Send the image as multipart `image`, or as a base64 data URL in `image`. Image URLs are not fetched.");
  return { ...readImageFields(s, body, true), upload: uploadOf(new Uint8Array(Buffer.from(m[1], "base64"))) };
}

async function runImages(ctx: Ctx, c: Context, key: KeyRow, s: MediaServices, input: ImageInput, maxInlineBytes?: number): Promise<Response> {
  const edit = !!input.upload;
  const id = requestId();
  const receiptInput = { requestId: id, model: input.model, units: input.n, unit: "image" };
  const safety: StudioSafety | undefined = s.studio ? { prompt: "safe", outputs: [] } : undefined;
  await checkVisualPrompt(ctx, s, c, { text: input.prompt, modality: "image", hasUpload: edit }, receiptInput);
  regionPolicy(ctx, c, s);
  if (input.upload) {
    if (s.studio && safety) {
      safety.upload = await s.studio.upload(input.upload, c.req.raw.signal);
      if (safety.upload !== "safe") {
        const error = safety.upload === "unsafe"
          ? new ApiError(451, "Anonymo refuses edits of real people's photos. Nothing was charged.", "floor_blocked", { category: "real_person" })
          : new ApiError(503, "The upload could not be safety-checked. Nothing was charged.", "media_gate_unavailable");
        throw studioFailure(ctx, error, receiptInput, safety);
      }
    }
    // An explicit or unscorable upload is refused before any generation.
    const verdict = await s.gate.assess(input.upload.bytes, input.upload.mime, { explicitAllowed: true, fromUpload: true });
    if (!verdict.ok) {
      const error = mediaError(new MediaBlocked(verdict.reason), "image");
      if (safety && error instanceof ApiError) throw studioFailure(ctx, error, receiptInput, { ...safety, upload: verdict.reason === "unscored" ? "unavailable" : "unsafe" });
      throw error;
    }
  }
  const price = priceOf(input.model.usdPerImage, input.n);
  const rights = await keyEntitlements(ctx, key.keyHash);
  await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: price, kind: "media_image", ttlMs: IMAGE_DEADLINE_MS + 60_000,
    cover: everydayCoverage(key.keyHash, rights, "image", price, input.n) });
  const stored: string[] = [];
  try {
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(IMAGE_DEADLINE_MS)]);
    const upstream = s.images[input.model.upstream];
    if (!upstream) throw new UpstreamError("no image upstream", 503);
    const raw = await upstream.generate({ model: input.model.upstreamModel, prompt: input.prompt, n: input.n, width: input.width, height: input.height, seed: input.seed, safe: true, image: input.upload }, signal);
    if (raw.length !== input.n) throw new UpstreamError("wrong number of images", 502);
    // Every image passes the gate and gets provenance before any of them is delivered: one block stops the batch.
    const outputs: Media[] = [];
    for (const out of raw) outputs.push(await finishOutput(s, out, { requestId: id, model: input.model.id, fromUpload: edit, prompt: input.prompt, visual: true, signal, safety }));
    if (maxInlineBytes && outputs.some((output) => output.bytes.length > maxInlineBytes))
      fail(503, "Turn art is too large for the room.", "studio_image_too_large");
    const data = outputs.map((o) => {
      if (input.format === "b64_json") return { b64_json: Buffer.from(o.bytes).toString("base64") };
      const put = s.store.put({ bytes: o.bytes, mime: o.mime, accountId: key.accountId }, s.ttlMs);
      stored.push(put.id);
      return { url: absolute(ctx, signedMediaPath(ctx.cfg.appSecret, put.id, put.expiresAt)), expires_at: Math.floor(put.expiresAt / 1000) };
    });
    const charged = await charge(ctx, id, price, "media_image", `${edit ? "Image edit" : "Image"}: ${input.model.name}`);
    const r = receipt(ctx, { ...receiptInput, charged, outputs, safety });
    return c.json({ created: Math.floor(Date.now() / 1000), data, anonymo: { request_id: id, model: input.model.id, cost_usd: usd(charged), provenance: { c2pa: true, watermark: true }, receipt: r } }, 200, { "x-anonymo-receipt": receiptHeader(r), "x-anonymo-request-id": id });
  } catch (e) {
    for (const m of stored) s.store.delete(m);
    await release(ctx.db, id).catch(() => undefined);
    if (e instanceof MediaBlocked) log.warn("media output blocked", { kind: "image", reason: e.reason, model: input.model.id });
    const error = mediaError(e, "image");
    if (e instanceof MediaBlocked && safety && error instanceof ApiError) throw studioFailure(ctx, error, receiptInput, safety);
    throw error;
  }
}

// Party uses the Studio image pipeline and returns the gated bytes inline.
export async function partyTurnArt(ctx: Ctx, c: Context, key: KeyRow, prompt: string) {
  if (!ctx.cfg.features.media) fail(503, "Studio is unavailable.", "studio_unavailable");
  await limitMediaCaller(ctx, key);
  const s = mediaServices(ctx);
  const model = s.catalog.models.find((m) => m.kind === "image" && !m.edit &&
    (!s.offered || s.offered.has(m.upstream)) && (!key.allowedModels?.length || key.allowedModels.includes(m.id)));
  if (!model) fail(503, "Studio is unavailable.", "studio_unavailable");
  return runImages(ctx, c, key, s, readImageFields(s, { model: model.id, prompt, response_format: "b64_json" }, false), 2_000_000);
}

// ---- Speech --------------------------------------------------------------------------------------------------------
const SPEECH_PICO_PER_SECOND = usdToPico("0.0005");
const MAX_LIVE_SPEECH_SECONDS = 45;

export async function runSpeech(ctx: Ctx, c: Context, live?: { body?: Record<string, unknown>; upstream?: SpeechUpstream }): Promise<Response> {
  const key = await caller(ctx, c);
  const s = mediaServices(ctx);
  if (!(c.req.header("content-type") ?? "application/json").startsWith("application/json")) fail(415, "Send a JSON body. Voice uploads are not accepted: stock voices only.", "unsupported_media_type");
  const body = live?.body ?? await readJson(c);
  if (ctx.cfg.features.moVoice && (!Object.keys(body).every((key) => ["model", "input", "voice", "speed", "response_format"].includes(key)) ||
      (body.speed != null && typeof body.speed !== "number" && typeof body.speed !== "string") ||
      (typeof body.input === "string" && /^\s*data:audio\//i.test(body.input))))
    fail(400, "Speech accepts text and a stock voice ID.", "voice_clone_not_supported");
  const model = modelOr404(s.catalog.get("speech", body.model), "speech");
  if (Object.keys(body).some((f) => CLONE_FIELDS.includes(f) || SOUND_REFERENCE_FIELD.test(f.replace(/[_-]/g, ""))) || (body.voice != null && typeof body.voice !== "string"))
    fail(400, "Voice cloning is not available. Choose one of the model's stock voices.", "voice_clone_not_supported");
  const input = str(body.input);
  if (!input.trim() || input.length > model.maxChars) fail(400, `Enter text of 1–${model.maxChars.toLocaleString("en-US")} characters.`);
  const voice = str(body.voice) || model.voices[0];
  if (!model.voices.includes(voice)) fail(400, `Choose one of this model's stock voices (GET /v1/media/models).`, "voice_not_available");
  if (body.response_format != null && body.response_format !== "wav")
    fail(400, 'response_format must be "wav": provenance is embedded in WAV output. Other formats need the watermark sidecar and are not offered yet.', "unsupported_format");
  const speed = body.speed == null ? 1 : Number(body.speed);
  const hosted = model.upstream === "nanogpt";
  const [minSpeed, maxSpeed] = hosted ? [0.5, 2] : [0.25, 4];
  if (!Number.isFinite(speed) || speed < minSpeed || speed > maxSpeed) fail(400, `speed must be ${minSpeed}–${maxSpeed}.`);
  if (hosted && c.req.header("x-anonymo-sealed")?.trim().toLowerCase() === "required")
    fail(409, "An attested speech route is unavailable.", "sealed_unavailable");
  const upstream = live?.upstream ?? (hosted ? s.nanogptSpeech : s.speech);
  if (!upstream) fail(503, "The speech provider is unavailable.", "upstream_unavailable");
  await floorCheck(ctx, { text: input, modality: "audio", hasUpload: false });
  regionPolicy(ctx, c, s);
  const id = requestId();
  const price = live ? SPEECH_PICO_PER_SECOND * BigInt(MAX_LIVE_SPEECH_SECONDS) : speechPrice(model, input.length);
  const rights = await keyEntitlements(ctx, key.keyHash);
  await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: price, kind: "media_speech", ttlMs: 5 * 60_000,
    cover: everydayCoverage(key.keyHash, rights, "voice", price, 1) });
  try {
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)]);
    const raw = await upstream.speak({ model: model.upstreamModel, input, voice, speed }, signal);
    let actual = price;
    if (live) {
      const { samples, rate } = wavDuration(raw.bytes);
      if (samples > rate * MAX_LIVE_SPEECH_SECONDS) throw new UpstreamError("Speech clip exceeds the call limit", 502);
      actual = (SPEECH_PICO_PER_SECOND * BigInt(samples) + BigInt(rate - 1)) / BigInt(rate);
      signal.throwIfAborted();
    }
    const out = await finishOutput(s, raw, { requestId: id, model: model.id, prompt: input, visual: false });
    if (live) signal.throwIfAborted();
    const includedTime = rights && (rights.active.length > 0 || rights.limits.dailyVoiceSeconds > 0);
    let seconds: number | undefined;
    if (includedTime) {
      try { seconds = wavSeconds(out.bytes); }
      catch { fail(502, "The speech duration could not be verified.", "speech_duration_unavailable"); }
    }
    const charged = await charge(ctx, id, actual, "media_speech", `Speech: ${model.name}`, seconds);
    const r = receipt(ctx, { requestId: id, model, units: input.length, unit: "character", charged, outputs: [out] });
    return new Response(out.bytes as unknown as ConstructorParameters<typeof Response>[0], {
      status: 200,
      headers: { "content-type": "audio/wav", "cache-control": "no-store", "x-anonymo-request-id": id, "x-anonymo-cost-usd": String(usd(charged)), "x-anonymo-provenance": "c2pa+watermark", "x-anonymo-receipt": receiptHeader(r) },
    });
  } catch (e) {
    await release(ctx.db, id).catch(() => undefined);
    throw mediaError(e, "audio");
  }
}

export async function runTranscription(ctx: Ctx, c: Context, live?: { file: File; samples: number; rate: number }): Promise<Response> {
  const key = await caller(ctx, c);
  const s = mediaServices(ctx);
  if (c.req.header("x-anonymo-sealed")?.trim().toLowerCase() === "required")
    fail(409, "An attested transcription route is unavailable.", "sealed_unavailable");
  const input = live
    ? { model: WHISPER_ID, file: live.file, language: undefined, format: "wav" as const }
    : await readTranscription(c);
  const model = modelOr404(s.catalog.get("transcription", input.model), "transcription");
  if (!s.transcription) fail(503, "The transcription provider is unavailable.", "upstream_unavailable");
  regionPolicy(ctx, c, s);
  const validationSignal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
  const minutes = live ? 0 : await transcriptionMinutes(input.file, input.format, validationSignal).catch((e: unknown) => {
    if (e instanceof ApiError) throw e;
    if (c.req.raw.signal.aborted) fail(499, "Client closed the request.", "cancelled");
    fail(503, "Audio validation is unavailable.", "audio_validation_unavailable");
  });
  const id = requestId();
  const perMinute = usdToPico(model.usdPerMinute);
  const samplesPerMinute = BigInt(live ? live.rate * 60 : 1);
  const price = live ? (perMinute * BigInt(live.samples) + samplesPerMinute - 1n) / samplesPerMinute : priceOf(model.usdPerMinute, minutes);
  const kind = "media_transcription";
  const rights = await keyEntitlements(ctx, key.keyHash);
  await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: price, kind, ttlMs: 5 * 60_000,
    cover: everydayCoverage(key.keyHash, rights, "credits", price) });
  try {
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)]);
    const text = await s.transcription.transcribe({ model: model.upstreamModel, file: input.file, language: input.language }, signal);
    if (live) signal.throwIfAborted();
    const charged = await charge(ctx, id, price, kind, `Transcription: ${model.name}`);
    return c.json({ text }, 200, { "cache-control": "no-store", "x-anonymo-request-id": id, "x-anonymo-cost-usd": String(usd(charged)) });
  } catch (e) {
    await release(ctx.db, id).catch(() => undefined);
    throw mediaError(e, "transcription");
  }
}

// ---- Video ---------------------------------------------------------------------------------------------------------
type JobRow = typeof mediaJobs.$inferSelect;

async function submitVideo(ctx: Ctx, c: Context): Promise<Response> {
  const key = await caller(ctx, c);
  const s = mediaServices(ctx);
  const body = await readJson(c);
  const model = modelOr404(s.catalog.get("video", body.model), "video");
  if (Object.entries(body).some(([field, value]) => value != null && VIDEO_UPLOAD_FIELD.test(field.replace(/[_-]/g, ""))))
    fail(400, "Video takes a text prompt only; references and uploads are not accepted.", "video_uploads_not_supported");
  const prompt = str(body.prompt);
  if (!prompt.trim() || prompt.length > MAX_VIDEO_PROMPT) fail(400, `Enter a prompt of 1–${MAX_VIDEO_PROMPT.toLocaleString("en-US")} characters.`);
  const seconds = body.seconds ?? body.duration ?? model.defaultSeconds;
  const secs = Number(typeof seconds === "string" ? seconds.replace(/s$/, "") : seconds);
  if (!Number.isInteger(secs) || secs < model.seconds[0] || secs > model.seconds[1]) fail(400, `seconds must be a whole number from ${model.seconds[0]} to ${model.seconds[1]}.`);
  if (model.allowedSeconds && !model.allowedSeconds.includes(secs)) fail(400, `Choose a length this model offers: ${model.allowedSeconds.join(", ")} seconds.`, "invalid_duration");
  const { width, height, size } = parseSize(model, body.size);
  const seed = parseSeed(body.seed);
  const id = requestId().replace("med_", "vid_");
  await checkVisualPrompt(ctx, s, c, { text: prompt, modality: "video", hasUpload: false }, { requestId: id, model, units: secs, unit: "second" });
  regionPolicy(ctx, c, s);
  const price = priceOf(model.usdPerSecond, secs);
  await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: price, kind: "media_video", ttlMs: VIDEO_HOLD_MS });
  await ctx.db.insert(mediaJobs).values({ id, accountId: key.accountId, keyHash: key.keyHash, holdId: id, model: model.id, upstream: model.upstream, status: "queued", seconds: secs, width, height, explicitAllowed: false, pricePico: price });
  try {
    const upstream = s.video[model.upstream];
    if (!upstream) throw new UpstreamError("no video upstream", 503);
    const ref = await upstream.submit({ model: model.upstreamModel, prompt, seconds: secs, width, height, seed, safe: true }, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]));
    await ctx.db.update(mediaJobs).set({ upstreamRef: ref, status: "running", updatedAt: new Date() }).where(eq(mediaJobs.id, id));
  } catch (e) {
    await release(ctx.db, id).catch(() => undefined);
    await ctx.db.update(mediaJobs).set({ status: "failed", errorType: e instanceof UpstreamError && e.status === 503 ? "upstream_unavailable" : "upstream_failed", updatedAt: new Date() }).where(eq(mediaJobs.id, id));
    throw mediaError(e, "video");
  }
  return c.json({ id, object: "video.generation", model: model.id, status: "queued", created: Math.floor(Date.now() / 1000), seconds: secs, size }, 202);
}

/** Move a running job forward once: poll its upstream and, when the video is ready, gate, stamp, store and settle.
 *  Claims are conditional updates, so concurrent pollers on any replica cannot double-poll or double-settle. */
async function advance(ctx: Ctx, s: MediaServices, job: JobRow): Promise<void> {
  if (job.status !== "running" || !job.upstreamRef) return;
  const cutoff = new Date(Date.now() - s.pollIntervalMs);
  const claimed = await ctx.db
    .update(mediaJobs)
    .set({ lastPolledAt: new Date() })
    .where(and(eq(mediaJobs.id, job.id), eq(mediaJobs.status, "running"), or(isNull(mediaJobs.lastPolledAt), lt(mediaJobs.lastPolledAt, cutoff))))
    .returning({ id: mediaJobs.id });
  if (!claimed.length) return;
  const model = s.catalog.get("video", job.model);
  const upstream = model ? s.video[model.upstream] : undefined;
  const end = async (status: "failed" | "blocked", errorType: string) => {
    await release(ctx.db, job.holdId).catch(() => undefined);
    await ctx.db.update(mediaJobs).set({ status, errorType, updatedAt: new Date() }).where(eq(mediaJobs.id, job.id));
  };
  if (!model || !upstream) return end("failed", "model_unavailable");
  let polled;
  try {
    polled = await upstream.poll(job.upstreamRef, model.upstreamModel, AbortSignal.timeout(60_000));
  } catch {
    return; // transient: try again on the next poll; the hold's own expiry bounds how long
  }
  if (polled.state === "running") return;
  if (polled.state === "failed") return polled.blocked ? end("blocked", "upstream_blocked") : end("failed", "upstream_failed");
  const finishing = await ctx.db.update(mediaJobs).set({ status: "finishing", updatedAt: new Date() }).where(and(eq(mediaJobs.id, job.id), eq(mediaJobs.status, "running"))).returning({ id: mediaJobs.id });
  if (!finishing.length) return;
  let mediaId: string | null = null;
  const safety: StudioSafety | undefined = s.studio ? { prompt: "safe", outputs: [] } : undefined;
  try {
    const out = await finishOutput(s, polled.media, { requestId: job.id, model: model.id, visual: true, safety });
    const put = s.store.put({ bytes: out.bytes, mime: out.mime, accountId: job.accountId, ...(safety ? { safety } : {}) }, s.ttlMs);
    mediaId = put.id;
    const charged = await charge(ctx, job.holdId, job.pricePico, "media_video", `Video: ${model.name}`);
    await ctx.db.update(mediaJobs).set({ status: "completed", mediaId: put.id, mediaExpiresAt: new Date(put.expiresAt), chargedPico: charged, updatedAt: new Date() }).where(eq(mediaJobs.id, job.id));
  } catch (e) {
    if (mediaId) s.store.delete(mediaId);
    if (e instanceof MediaBlocked) {
      log.warn("media output blocked", { kind: "video", reason: e.reason, model: model.id });
      const type = e.reason === "unscored" ? "media_gate_unavailable" : e.reason === "explicit" ? "explicit_media_unavailable" : "media_blocked";
      const verdicts = safety?.outputs[0];
      const code = verdicts
        ? [type, e.reason, verdicts.shieldgemma2, verdicts.llavaguard].join(":")
        : type === "media_blocked" ? `${type}:${e.reason}` : type;
      return end(e.reason === "unscored" ? "failed" : "blocked", code);
    }
    return end("failed", e instanceof ProvenanceError ? "provenance_failed" : e instanceof StoreFullError ? "media_store_full" : "internal");
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  upstream_unavailable: "The video provider was unavailable. Nothing was charged.",
  upstream_failed: "The video provider failed. Nothing was charged.",
  upstream_blocked: "The video provider blocked this request. Nothing was charged.",
  model_unavailable: "This video model is no longer available. Nothing was charged.",
  media_gate_unavailable: "The video could not be safety-checked, so it was not returned. Nothing was charged.",
  explicit_media_unavailable: "Anonymo makes no explicit video. Nothing was returned or charged.",
  provenance_failed: "The video could not be labelled with provenance, so it was not returned. Nothing was charged.",
  media_store_full: "Media storage was full. Nothing was charged.",
  internal: "The job failed. Nothing was charged.",
};

function videoJson(ctx: Ctx, s: MediaServices, job: JobRow) {
  const status = job.status === "completed" ? "completed" : job.status === "failed" || job.status === "blocked" ? "failed" : job.status === "queued" ? "queued" : "in_progress";
  const expires = job.mediaExpiresAt?.getTime() ?? 0;
  const live = job.status === "completed" && job.mediaId && expires > Date.now();
  const [type, reason, shieldgemma2, llavaguard] = (job.errorType ?? "").split(":");
  const output = live ? s.store.get(job.mediaId!) : null;
  const declined = isStudioVerdict(shieldgemma2) && isStudioVerdict(llavaguard);
  const model = output || declined ? s.catalog.get("video", job.model) : null;
  const signed = model && (declined || (output && job.chargedPico != null))
    ? receipt(ctx, {
      requestId: job.id, model, units: job.seconds, unit: "second", charged: job.chargedPico ?? 0n,
      outputs: output ? [output] : [], at: job.updatedAt,
      safety: declined ? { prompt: "safe", outputs: [{ shieldgemma2, llavaguard }] } : output?.safety,
    })
    : null;
  const body = {
    id: job.id,
    object: "video.generation",
    model: job.model,
    status,
    created: Math.floor(job.createdAt.getTime() / 1000),
    seconds: job.seconds,
    size: `${job.width}x${job.height}`,
    ...(live ? { url: absolute(ctx, signedMediaPath(ctx.cfg.appSecret, job.mediaId!, expires)), expires_at: Math.floor(expires / 1000) } : {}),
    ...(job.status === "completed" && !live ? { expired: true } : {}),
    ...(job.errorType
      ? { error: { type, message: reason === "studio_unsafe" ? "The video did not pass the safe-for-work check. Nothing was charged." : type === "media_blocked" ? "The video crossed a line Anonymo blocks for everyone. Nothing was returned, stored or charged." : (ERROR_MESSAGES[type] ?? ERROR_MESSAGES.internal), ...(reason ? { reason } : {}) } }
      : {}),
    anonymo: { request_id: job.id, cost_usd: job.chargedPico != null ? usd(job.chargedPico) : 0, quoted_usd: usd(job.pricePico), ...(job.status === "completed" ? { provenance: { c2pa: true, watermark: true } } : {}), ...(signed ? { receipt: signed } : {}) },
  };
  return { body, studioBlocked: declined && job.status === "blocked" };
}

async function getVideo(ctx: Ctx, c: Context): Promise<Response> {
  const key = await caller(ctx, c);
  const s = mediaServices(ctx);
  const id = c.req.param("id") ?? "";
  const load = async () => (await ctx.db.select().from(mediaJobs).where(and(eq(mediaJobs.id, id), eq(mediaJobs.accountId, key.accountId))))[0];
  const job = await load();
  if (!job) fail(404, "Unknown video job.", "not_found");
  if (job.status === "running") await advance(ctx, s, job);
  const current = (await load())!;
  const { body, studioBlocked } = videoJson(ctx, s, current);
  if (studioBlocked) {
    const signed = body.anonymo.receipt;
    return c.json(body, 451, signed ? { "x-anonymo-receipt": receiptHeader(signed), "x-anonymo-request-id": current.id } : undefined);
  }
  return c.json(body);
}

// ---- Shared endpoints ----------------------------------------------------------------------------------------------
function getMedia(ctx: Ctx, c: Context): Response {
  const s = mediaServices(ctx);
  const id = c.req.param("id") ?? "";
  const notFound = () => c.json(new ApiError(404, "Media not found or expired.", "not_found").toJSON(), 404);
  if (!/^m_[A-Za-z0-9_-]{24}$/.test(id) || !checkMediaSignature(ctx.cfg.appSecret, id, c.req.query("expires"), c.req.query("sig"))) return notFound();
  const item = s.store.get(id);
  if (!item) return notFound();
  const ext = item.mime === "image/png" ? "png" : item.mime === "audio/wav" ? "wav" : "mp4";
  const disposition = ext === "mp4" && c.req.query("download") === "1" ? "attachment" : "inline";
  const headers = new Headers({ "content-type": item.mime, "cache-control": "private, no-store", "content-disposition": `${disposition}; filename="${id}.${ext}"`, "x-content-type-options": "nosniff", "x-anonymo-provenance": "c2pa+watermark" });
  let bytes = item.bytes;
  let status = 200;
  if (ext === "mp4") {
    headers.set("accept-ranges", "bytes");
    const range = /^bytes=(\d*)-(\d*)$/i.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      const length = bytes.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, length - Number(range[2]));
      const end = Math.min(length - 1, range[1] && range[2] ? Number(range[2]) : length - 1);
      if (start > end) {
        headers.set("content-range", `bytes */${length}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set("content-range", `bytes ${start}-${end}/${length}`);
      bytes = bytes.subarray(start, end + 1);
      status = 206;
    }
  }
  headers.set("content-length", String(bytes.length));
  return new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], { status, headers });
}

function listModels(ctx: Ctx, c: Context) {
  const s = mediaServices(ctx);
  return c.json({
    object: "list",
    data: s.catalog.models.filter((m) => (ctx.cfg.features.media || m.kind === "image" || m.kind === "video") && (!s.offered || s.offered.has(m.upstream))).map((m) => ({
      id: m.id,
      object: "model",
      kind: m.kind,
      name: m.name,
      family: m.family,
      license: m.license,
      upstream: m.upstream === "venice" || m.upstream === "nanogpt" ? m.upstream : "self-hosted",
      ...(m.kind === "image" ? { pricing: { usd_per_image: m.usdPerImage }, edit: m.edit, sizes: m.sizes, max_images: m.maxImages ?? DEFAULT_MAX_IMAGES } : {}),
      ...(m.kind === "speech" ? { pricing: { usd_per_1k_chars: m.usdPer1kChars }, voices: m.voices, max_chars: m.maxChars, response_formats: ["wav"] } : {}),
      ...(m.kind === "transcription" ? { pricing: { usd_per_started_minute: m.usdPerMinute }, max_seconds: TRANSCRIPTION_MAX_SECONDS, max_request_bytes: TRANSCRIPTION_MAX_BYTES, formats: Object.keys(TRANSCRIPTION_FORMATS) } : {}),
      ...(m.kind === "video" ? { pricing: { usd_per_second: m.usdPerSecond }, seconds: { min: m.seconds[0], max: m.seconds[1], default: m.defaultSeconds, ...(m.allowedSeconds ? { allowed: m.allowedSeconds } : {}) }, sizes: m.sizes } : {}),
    })),
  });
}

function provenanceKeys(ctx: Ctx, c: Context) {
  return c.json({ keys: mediaServices(ctx).provenance.keys().map((k) => ({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: k.keyId, x: Buffer.from(k.publicKeyHex, "hex").toString("base64url") })) });
}

async function verifyProvenance(ctx: Ctx, c: Context) {
  await caller(ctx, c); // per-key limit; no caller address is read
  if (Number(c.req.header("content-length") ?? 0) > 110 * 1024 * 1024) fail(413, "File too large.", "payload_too_large");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length || bytes.length > 110 * 1024 * 1024) fail(400, "Send the media file as the request body.");
  const check = await mediaServices(ctx).provenance.verify(bytes);
  return c.json({
    verified: check.ok,
    c2pa: check.manifest.ok ? { valid: true, key_id: check.manifest.keyId, model: check.manifest.generation.model, request_id: check.manifest.generation.requestId, generated_at: check.manifest.generation.generatedAt, digital_source_type: check.manifest.digitalSourceType } : { valid: false, reason: check.manifest.reason },
    watermark: check.watermark ? { found: true, alg: check.watermark.alg, id: check.watermark.id } : { found: false },
  });
}

export function mediaRoutes(app: Hono, ctx: Ctx) {
  mediaServices(ctx); // build now, so a bad key or catalog fails at startup rather than on the first request
  const both = (method: "get" | "post", path: string, h: (c: Context) => Response | Promise<Response>) => {
    app[method](`/v1${path}`, h);
    app[method](`/api/v1${path}`, h);
  };
  both("post", "/images/generations", async (c) => {
    const key = await caller(ctx, c);
    const s = mediaServices(ctx);
    const body = await readJson(c);
    if (["image", "image_url", "input_image", "mask"].some((f) => body[f] != null)) fail(400, "Uploads go to /v1/images/edits.", "wrong_endpoint");
    return runImages(ctx, c, key, s, readImageFields(s, body, false));
  });
  both("post", "/images/edits", async (c) => {
    const key = await caller(ctx, c);
    const s = mediaServices(ctx);
    return runImages(ctx, c, key, s, await readEditRequest(s, c));
  });
  if (ctx.cfg.features.media) {
    both("post", "/audio/speech", (c) => runSpeech(ctx, c));
    both("post", "/audio/transcriptions", (c) => runTranscription(ctx, c));
  }
  both("post", "/video/generations", (c) => submitVideo(ctx, c));
  both("get", "/video/generations/:id", (c) => getVideo(ctx, c));
  both("get", "/media/models", (c) => listModels(ctx, c));
  both("get", "/media/provenance/keys", (c) => provenanceKeys(ctx, c));
  both("post", "/media/provenance/verify", (c) => verifyProvenance(ctx, c));
  both("get", "/media/:id", (c) => getMedia(ctx, c));
}

/** Advance every running video job once (for a periodic worker; polling GETs also advance jobs on their own). */
export async function sweepVideoJobs(ctx: Ctx, limit = 50) {
  const s = mediaServices(ctx);
  const rows = await ctx.db.select().from(mediaJobs).where(eq(mediaJobs.status, "running")).orderBy(sql`${mediaJobs.updatedAt} asc`).limit(limit);
  for (const job of rows) await advance(ctx, s, job).catch((e) => log.warn("video job advance failed", { job: job.id, error: (e as Error).message }));
  return rows.length;
}

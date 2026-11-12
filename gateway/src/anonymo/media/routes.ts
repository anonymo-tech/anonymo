// WS06 · Media endpoints, OpenAI-shaped, ported from Anonyma's /v1 media routes (Express/SQLite) to Hono/Drizzle.
//
//   POST /v1/images/generations   POST /v1/images/edits        POST /v1/audio/speech
//   POST /v1/video/generations    GET  /v1/video/generations/{id}  (asynchronous jobs, polled)
//   GET  /v1/media/{id}?expires&sig   short-lived signed download of an output
//   GET  /v1/media/models   GET /v1/media/provenance/keys   POST /v1/media/provenance/verify
// Each is also served under /api/v1.
//
// Every request runs, in order: key → validation → floor gate (ctx.anonymo.floor, never rerouted) → region rules →
// hold (reserve) → upstream → media gate on every visual output → provenance (watermark + signed C2PA manifest,
// self-verified) → delivery → settle. Any failure after the hold releases it, so a blocked, failed or unmarked
// output is never charged, stored or returned. Prompt text is never written anywhere (not even logs).

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
import type { ImageModel, MediaModel, SpeechModel, VideoModel } from "./catalog.ts";
import { containerFor } from "./containers.ts";
import type { GateReason } from "./gate.ts";
import { ProvenanceError } from "./provenance.ts";
import { countryOf } from "./region.ts";
import { mediaJobs } from "./schema.ts";
import { mediaServices, regionRulesOf, type MediaServices } from "./services.ts";
import { checkMediaSignature, signedMediaPath, StoreFullError } from "./store.ts";
import { UpstreamError, type Media } from "./upstreams.ts";

const MAX_PROMPT = 4000;
const MAX_VIDEO_PROMPT = 2000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_DEADLINE_MS = 240_000;
const VIDEO_HOLD_MS = 60 * 60_000;
// Fields that would carry a voice sample or a reference image into a model that only takes stock inputs.
const CLONE_FIELDS = ["reference_audio", "speaker_wav", "voice_sample", "audio", "audio_prompt", "prompt_audio", "voice_url", "clone", "reference_text", "speaker_audio", "voice_file"];
const VIDEO_UPLOAD_FIELDS = ["image", "image_url", "input_reference", "input_image", "first_frame", "last_frame", "reference_image", "video", "video_url"];

class MediaBlocked extends Error {
  constructor(readonly reason: GateReason) {
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
  await requireRole(ctx, key, ["owner", "admin", "member"]);
  const limit = key.rpm ?? ctx.cfg.limits.defaultRpm;
  const r = await ctx.limiter.take(`k:${key.keyHash}`, 1, limit, 60_000);
  if (!r.ok) fail(429, `Rate limit exceeded (${limit} requests/min). Retry in ${Math.ceil(r.retryAfterMs / 1000)}s.`, "rate_limited", { retry_after_ms: r.retryAfterMs }, { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
  return key;
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

function regionPolicy(ctx: Ctx, c: Context, s: MediaServices) {
  const policy = regionRulesOf(ctx, s).forCountry(countryOf(c));
  if (policy.blocked) fail(451, "Anonymo is not available in this region. Nothing was sent or charged.", "region_blocked");
  return policy;
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
async function finishOutput(s: MediaServices, out: Media, o: { requestId: string; model: string; explicitAllowed: boolean; fromUpload?: boolean; prompt?: string; visual: boolean; signal?: AbortSignal }): Promise<Media> {
  if (o.visual) {
    const verdict = await s.gate.assess(out.bytes, out.mime, { explicitAllowed: o.explicitAllowed, fromUpload: o.fromUpload, signal: o.signal });
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
    if (e.reason === "unscored") return new ApiError(503, `The ${what} could not be safety-checked, so it was not returned. Nothing was charged; try again shortly.`, "media_gate_unavailable");
    if (e.reason === "explicit_region") return new ApiError(451, `Explicit ${what}s are switched off in this region. Nothing was returned or charged.`, "explicit_media_unavailable");
    return new ApiError(451, `The ${what} crossed a line Anonymo blocks for everyone. Nothing was returned, stored or charged.`, "media_blocked", { reason: e.reason });
  }
  if (e instanceof ProvenanceError) return new ApiError(502, `The ${what} could not be labelled with provenance, so it was not returned. Nothing was charged.`, "provenance_failed");
  if (e instanceof UpstreamError)
    return new ApiError(e.status, e.status === 503 ? `The ${what} provider is unavailable right now. Nothing was charged.` : e.rejected ? `The ${what} provider rejected this request. Nothing was charged.` : `The ${what} provider failed. Nothing was charged.`, e.status === 503 ? "upstream_unavailable" : e.rejected ? "upstream_rejected" : "upstream_failed");
  if (e instanceof StoreFullError) return new ApiError(503, "Media storage is full right now. Nothing was charged; try again shortly or ask for b64_json.", "media_store_full");
  return e;
}

function receipt(ctx: Ctx, o: { requestId: string; model: MediaModel; units: number; unit: string; charged: Pico; outputs: Media[] }) {
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
    provenance: "c2pa+watermark",
    ts: new Date().toISOString(),
  };
  const s = ctx.signer.sign(payload);
  return { payload, key_id: s.keyId, sig: s.sig };
}
const receiptHeader = (r: ReturnType<typeof receipt>) => Buffer.from(JSON.stringify(r)).toString("base64url");
const absolute = (ctx: Ctx, path: string) => (ctx.cfg.publicUrl ? ctx.cfg.publicUrl + path : path);

async function charge(ctx: Ctx, holdId: string, amount: Pico, kind: string, description: string) {
  const r = await settle(ctx.db, holdId, amount, { kind, description });
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
  if (!Number.isInteger(n) || n < 1 || n > 4) fail(400, "n must be 1–4.");
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

async function runImages(ctx: Ctx, c: Context, key: KeyRow, s: MediaServices, input: ImageInput): Promise<Response> {
  const edit = !!input.upload;
  await floorCheck(ctx, { text: input.prompt, modality: "image", hasUpload: edit });
  const policy = regionPolicy(ctx, c, s);
  // No NSFW edits of uploaded photos: an explicit (or unscorable) upload is refused before any model sees it.
  if (input.upload) {
    const v = await s.gate.assess(input.upload.bytes, input.upload.mime, { explicitAllowed: true, fromUpload: true });
    if (!v.ok) throw mediaError(new MediaBlocked(v.reason), "image");
  }
  const id = requestId();
  const price = priceOf(input.model.usdPerImage, input.n);
  await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: price, kind: "media_image", ttlMs: IMAGE_DEADLINE_MS + 60_000 });
  const stored: string[] = [];
  try {
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(IMAGE_DEADLINE_MS)]);
    const upstream = s.images[input.model.upstream];
    if (!upstream) throw new UpstreamError("no image upstream", 503);
    const raw = await upstream.generate({ model: input.model.upstreamModel, prompt: input.prompt, n: input.n, width: input.width, height: input.height, seed: input.seed, safe: edit || !policy.explicitMediaAllowed, image: input.upload }, signal);
    if (raw.length !== input.n) throw new UpstreamError("wrong number of images", 502);
    // Every image passes the gate and gets provenance before any of them is delivered: one block stops the batch.
    const outputs: Media[] = [];
    for (const out of raw) outputs.push(await finishOutput(s, out, { requestId: id, model: input.model.id, explicitAllowed: policy.explicitMediaAllowed && !edit, fromUpload: edit, prompt: input.prompt, visual: true, signal }));
    const data = outputs.map((o) => {
      if (input.format === "b64_json") return { b64_json: Buffer.from(o.bytes).toString("base64") };
      const put = s.store.put({ bytes: o.bytes, mime: o.mime, accountId: key.accountId }, s.ttlMs);
      stored.push(put.id);
      return { url: absolute(ctx, signedMediaPath(ctx.cfg.appSecret, put.id, put.expiresAt)), expires_at: Math.floor(put.expiresAt / 1000) };
    });
    const charged = await charge(ctx, id, price, "media_image", `${edit ? "Image edit" : "Image"}: ${input.model.name}`);
    const r = receipt(ctx, { requestId: id, model: input.model, units: input.n, unit: "image", charged, outputs });
    return c.json({ created: Math.floor(Date.now() / 1000), data, anonymo: { request_id: id, model: input.model.id, cost_usd: usd(charged), provenance: { c2pa: true, watermark: true }, receipt: r } }, 200, { "x-anonymo-receipt": receiptHeader(r), "x-anonymo-request-id": id });
  } catch (e) {
    for (const m of stored) s.store.delete(m);
    await release(ctx.db, id).catch(() => undefined);
    if (e instanceof MediaBlocked) log.warn("media output blocked", { kind: "image", reason: e.reason, model: input.model.id });
    throw mediaError(e, "image");
  }
}

// ---- Speech --------------------------------------------------------------------------------------------------------
async function runSpeech(ctx: Ctx, c: Context): Promise<Response> {
  const key = await caller(ctx, c);
  const s = mediaServices(ctx);
  if (!(c.req.header("content-type") ?? "application/json").startsWith("application/json")) fail(415, "Send a JSON body. Voice uploads are not accepted: stock voices only.", "unsupported_media_type");
  const body = await readJson(c);
  const model = modelOr404(s.catalog.get("speech", body.model), "speech");
  if (CLONE_FIELDS.some((f) => body[f] != null) || (body.voice != null && typeof body.voice !== "string"))
    fail(400, "Voice cloning is not available. Choose one of the model's stock voices.", "voice_clone_not_supported");
  const input = str(body.input);
  if (!input.trim() || input.length > model.maxChars) fail(400, `Enter text of 1–${model.maxChars.toLocaleString("en-US")} characters.`);
  const voice = str(body.voice) || model.voices[0];
  if (!model.voices.includes(voice)) fail(400, `Choose one of this model's stock voices (GET /v1/media/models).`, "voice_not_available");
  if (body.response_format != null && body.response_format !== "wav")
    fail(400, 'response_format must be "wav": provenance is embedded in WAV output. Other formats need the watermark sidecar and are not offered yet.', "unsupported_format");
  const speed = body.speed == null ? 1 : Number(body.speed);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) fail(400, "speed must be 0.25–4.");
  await floorCheck(ctx, { text: input, modality: "audio", hasUpload: false });
  regionPolicy(ctx, c, s);
  const id = requestId();
  const price = speechPrice(model, input.length);
  await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: price, kind: "media_speech", ttlMs: 5 * 60_000 });
  try {
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)]);
    const raw = await s.speech.speak({ model: model.upstreamModel, input, voice, speed }, signal);
    const out = await finishOutput(s, raw, { requestId: id, model: model.id, explicitAllowed: true, prompt: input, visual: false });
    const charged = await charge(ctx, id, price, "media_speech", `Speech: ${model.name}`);
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

// ---- Video ---------------------------------------------------------------------------------------------------------
type JobRow = typeof mediaJobs.$inferSelect;

async function submitVideo(ctx: Ctx, c: Context): Promise<Response> {
  const key = await caller(ctx, c);
  const s = mediaServices(ctx);
  const body = await readJson(c);
  const model = modelOr404(s.catalog.get("video", body.model), "video");
  if (VIDEO_UPLOAD_FIELDS.some((f) => body[f] != null)) fail(400, "Video takes a text prompt only; reference images and uploads are not accepted.", "video_uploads_not_supported");
  const prompt = str(body.prompt);
  if (!prompt.trim() || prompt.length > MAX_VIDEO_PROMPT) fail(400, `Enter a prompt of 1–${MAX_VIDEO_PROMPT.toLocaleString("en-US")} characters.`);
  const seconds = body.seconds ?? body.duration ?? model.defaultSeconds;
  const secs = Number(typeof seconds === "string" ? seconds.replace(/s$/, "") : seconds);
  if (!Number.isInteger(secs) || secs < model.seconds[0] || secs > model.seconds[1]) fail(400, `seconds must be a whole number from ${model.seconds[0]} to ${model.seconds[1]}.`);
  const { width, height, size } = parseSize(model, body.size);
  const seed = parseSeed(body.seed);
  await floorCheck(ctx, { text: prompt, modality: "video", hasUpload: false });
  const policy = regionPolicy(ctx, c, s);
  const id = requestId().replace("med_", "vid_");
  const price = priceOf(model.usdPerSecond, secs);
  await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: price, kind: "media_video", ttlMs: VIDEO_HOLD_MS });
  await ctx.db.insert(mediaJobs).values({ id, accountId: key.accountId, keyHash: key.keyHash, holdId: id, model: model.id, upstream: model.upstream, status: "queued", seconds: secs, width, height, explicitAllowed: policy.explicitMediaAllowed, pricePico: price });
  try {
    const upstream = s.video[model.upstream];
    if (!upstream) throw new UpstreamError("no video upstream", 503);
    const ref = await upstream.submit({ model: model.upstreamModel, prompt, seconds: secs, width, height, seed, safe: !policy.explicitMediaAllowed }, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]));
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
  if (polled.state === "failed") return end("failed", "upstream_failed");
  const finishing = await ctx.db.update(mediaJobs).set({ status: "finishing", updatedAt: new Date() }).where(and(eq(mediaJobs.id, job.id), eq(mediaJobs.status, "running"))).returning({ id: mediaJobs.id });
  if (!finishing.length) return;
  let mediaId: string | null = null;
  try {
    const out = await finishOutput(s, polled.media, { requestId: job.id, model: model.id, explicitAllowed: job.explicitAllowed, visual: true });
    const put = s.store.put({ bytes: out.bytes, mime: out.mime, accountId: job.accountId }, s.ttlMs);
    mediaId = put.id;
    const charged = await charge(ctx, job.holdId, job.pricePico, "media_video", `Video: ${model.name}`);
    await ctx.db.update(mediaJobs).set({ status: "completed", mediaId: put.id, mediaExpiresAt: new Date(put.expiresAt), chargedPico: charged, updatedAt: new Date() }).where(eq(mediaJobs.id, job.id));
  } catch (e) {
    if (mediaId) s.store.delete(mediaId);
    if (e instanceof MediaBlocked) {
      log.warn("media output blocked", { kind: "video", reason: e.reason, model: model.id });
      return end(e.reason === "unscored" ? "failed" : "blocked", e.reason === "unscored" ? "media_gate_unavailable" : e.reason === "explicit_region" ? "explicit_media_unavailable" : `media_blocked:${e.reason}`);
    }
    return end("failed", e instanceof ProvenanceError ? "provenance_failed" : e instanceof StoreFullError ? "media_store_full" : "internal");
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  upstream_unavailable: "The video provider was unavailable. Nothing was charged.",
  upstream_failed: "The video provider failed. Nothing was charged.",
  model_unavailable: "This video model is no longer available. Nothing was charged.",
  media_gate_unavailable: "The video could not be safety-checked, so it was not returned. Nothing was charged.",
  explicit_media_unavailable: "Explicit video is switched off in this region. Nothing was returned or charged.",
  provenance_failed: "The video could not be labelled with provenance, so it was not returned. Nothing was charged.",
  media_store_full: "Media storage was full. Nothing was charged.",
  internal: "The job failed. Nothing was charged.",
};

function videoJson(ctx: Ctx, job: JobRow) {
  const status = job.status === "completed" ? "completed" : job.status === "failed" || job.status === "blocked" ? "failed" : job.status === "queued" ? "queued" : "in_progress";
  const expires = job.mediaExpiresAt?.getTime() ?? 0;
  const live = job.status === "completed" && job.mediaId && expires > Date.now();
  const [type, reason] = (job.errorType ?? "").split(":");
  return {
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
      ? { error: { type, message: type === "media_blocked" ? "The video crossed a line Anonymo blocks for everyone. Nothing was returned, stored or charged." : (ERROR_MESSAGES[type] ?? ERROR_MESSAGES.internal), ...(reason ? { reason } : {}) } }
      : {}),
    anonymo: { request_id: job.id, cost_usd: job.chargedPico != null ? usd(job.chargedPico) : 0, quoted_usd: usd(job.pricePico), ...(job.status === "completed" ? { provenance: { c2pa: true, watermark: true } } : {}) },
  };
}

async function getVideo(ctx: Ctx, c: Context): Promise<Response> {
  const key = await caller(ctx, c);
  const s = mediaServices(ctx);
  const id = c.req.param("id") ?? "";
  const load = async () => (await ctx.db.select().from(mediaJobs).where(and(eq(mediaJobs.id, id), eq(mediaJobs.accountId, key.accountId))))[0];
  const job = await load();
  if (!job) fail(404, "Unknown video job.", "not_found");
  if (job.status === "running") await advance(ctx, s, job);
  return c.json(videoJson(ctx, (await load())!));
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
  return new Response(item.bytes as unknown as ConstructorParameters<typeof Response>[0], {
    headers: { "content-type": item.mime, "cache-control": "private, no-store", "content-disposition": `inline; filename="${id}.${ext}"`, "x-content-type-options": "nosniff", "x-anonymo-provenance": "c2pa+watermark" },
  });
}

function listModels(ctx: Ctx, c: Context) {
  const s = mediaServices(ctx);
  return c.json({
    object: "list",
    data: s.catalog.models.map((m) => ({
      id: m.id,
      object: "model",
      kind: m.kind,
      name: m.name,
      family: m.family,
      license: m.license,
      upstream: m.upstream === "venice" ? "venice" : "self-hosted",
      ...(m.kind === "image" ? { pricing: { usd_per_image: m.usdPerImage }, edit: m.edit, sizes: m.sizes } : {}),
      ...(m.kind === "speech" ? { pricing: { usd_per_1k_chars: m.usdPer1kChars }, voices: m.voices, max_chars: m.maxChars, response_formats: ["wav"] } : {}),
      ...(m.kind === "video" ? { pricing: { usd_per_second: m.usdPerSecond }, seconds: { min: m.seconds[0], max: m.seconds[1] }, sizes: m.sizes } : {}),
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
  both("post", "/audio/speech", (c) => runSpeech(ctx, c));
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

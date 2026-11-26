// The media services one gateway uses, built from the environment on first use and replaceable per gateway (tests
// swap in doubles with setMediaServices). Kept beside ctx rather than on ctx.anonymo, because services.ts and
// seams.ts belong to WS00: when WS02 adds `region` to ctx.anonymo, media reads it from there instead of the
// placeholder below, with no change here.
//
// Environment (all optional; an unset upstream answers 503 and charges nothing, an unset classifier blocks every
// image and video, an unset video watermark sidecar blocks every video):
//   ANONYMO_MEDIA_CLASSIFIER_URL / _TOKEN     NSFW × apparent-age classifier service (gate.ts httpClassifier)
//   Without it, the hosted pair (hosted-classifier.ts) when both keys are set: ANONYMO_NANOGPT_API_KEY (NanoGPT's NSFW
//   check) and ANONYMO_MEDIA_GUARD_KEY with ANONYMO_MEDIA_GUARD_URL (default https://api.ppq.ai/v1) and
//   ANONYMO_MEDIA_GUARD_MODEL (default meta-llama/llama-guard-4-12b). Images only.
//   ANONYMO_NANOGPT_API_KEY / ANONYMO_NANOGPT_BASE: hosted image and video models (catalog.ts)
//   ANONYMO_MEDIA_NSFW_THRESHOLD, ANONYMO_MEDIA_MIN_ADULT_AGE, ANONYMO_MEDIA_VIDEO_FRAMES
//   ANONYMO_WATERMARK_URL / _TOKEN / _MIMES   watermark sidecar (watermark.ts httpWatermarker); MIMES defaults to video/mp4
//   ANONYMO_WATERMARK_KEY                     64 hex chars; default derived from APP_SECRET
//   ANONYMO_PROVENANCE_KEY                    64 hex chars, the Ed25519 seed; default derived from APP_SECRET
//   ANONYMO_PROVENANCE_PREVIOUS_KEYS          "keyId:publicKeyHex,…" still accepted when verifying
//   ANONYMO_VENICE_API_KEY / ANONYMO_VENICE_BASE, ANONYMO_VENICE_IMAGE_MODELS / _VIDEO_MODELS (catalog.ts)
//   ANONYMO_COMFY_URL / _TOKEN / ANONYMO_COMFY_WORKFLOWS_DIR
//   ANONYMO_TTS_URL / _TOKEN
//   ANONYMO_MEDIA_TTL_S (default 3600, at most 86400), ANONYMO_MEDIA_STORE_MB (default 512)
//   ANONYMO_REGION_BLOCKED, ANONYMO_EXPLICIT_MEDIA_OFF (region.ts, placeholder until WS02)
//   ANONYMO_FLOOR_* (read, not owned): the nudity prompt check asks the floor's guard when it runs safeguard (prompt-check.ts)

import { hkdfSync } from "node:crypto";
import type { Ctx } from "../../context.ts";
import type { RegionRules } from "../seams.ts";
import { MediaCatalog, type Upstream } from "./catalog.ts";
import { provenanceKeyFromSeed } from "./c2pa.ts";
import { compVideoConfig, type CompVideoAllowance } from "./first-video.ts";
import { createMediaGate, httpClassifier, unconfiguredClassifier, type MediaClassifier, type MediaOutputGate } from "./gate.ts";
import { hostedClassifier } from "./hosted-classifier.ts";
import { nanogptSpeechAdapter, type TranscriptionUpstream } from "./nanogpt-speech.ts";
import { nanogptVideoAdapter } from "./nanogpt-video.ts";
import { createProvenance, type MediaProvenance } from "./provenance.ts";
import { promptCheckFromEnv, type MediaPromptCheck } from "./prompt-check.ts";
import { placeholderRegionRules } from "./region.ts";
import { MemoryMediaStore, type MediaStore } from "./store.ts";
import { comfyAdapter, nanogptAdapter, ttsAdapter, unconfigured, veniceAdapter, type ImageUpstream, type SpeechUpstream, type VideoUpstream } from "./upstreams.ts";
import { chainWatermarkers, httpWatermarker, lsbWatermarker } from "./watermark.ts";
import { createStudioGate, llavaGuardClassifier, shieldGemmaClassifier, studioPersonClassifier } from "./studio.ts";
import { workflowSet } from "./workflows.ts";

export type MediaServices = {
  catalog: MediaCatalog;
  compVideo?: CompVideoAllowance;
  /** Upstreams this gateway has configured: GET /v1/media/models lists only their models. Unset lists everything. */
  offered?: ReadonlySet<Upstream>;
  gate: MediaOutputGate;
  studio?: ReturnType<typeof createStudioGate>;
  /** Refuses image and video prompts that ask for nudity or sex, before anything is generated. */
  promptCheck: MediaPromptCheck;
  provenance: MediaProvenance;
  /** Used only while ctx.anonymo carries no `region` of its own (WS02). */
  region: RegionRules;
  store: MediaStore;
  images: Partial<Record<Upstream, ImageUpstream>>;
  video: Partial<Record<Upstream, VideoUpstream>>;
  speech: SpeechUpstream;
  nanogptSpeech?: SpeechUpstream;
  transcription?: TranscriptionUpstream;
  ttlMs: number;
  /** Milliseconds between upstream polls of one video job. */
  pollIntervalMs: number;
};

type Env = Record<string, string | undefined>;
const hex32 = (v: string | undefined, name: string) => {
  if (!v) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be 64 hex characters`);
  return Uint8Array.from(Buffer.from(v, "hex"));
};
const derive = (secret: string, label: string) => new Uint8Array(hkdfSync("sha256", secret, "anonymo-media", label, 32));
const num = (v: string | undefined, fallback: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

const nanogptBase = (env: Env) => env.ANONYMO_NANOGPT_BASE?.trim() || "https://nano-gpt.com/api/v1";

/** Our classifier service when configured, else the hosted pair when both of its keys are set, else none (every
 *  visual output is blocked). */
export function classifierFromEnv(env: Env): MediaClassifier {
  if (env.ANONYMO_MEDIA_CLASSIFIER_URL?.trim()) return httpClassifier(env.ANONYMO_MEDIA_CLASSIFIER_URL, { token: env.ANONYMO_MEDIA_CLASSIFIER_TOKEN });
  const nanogptKey = env.ANONYMO_NANOGPT_API_KEY?.trim(), guardKey = env.ANONYMO_MEDIA_GUARD_KEY?.trim();
  if (nanogptKey && guardKey)
    return hostedClassifier({
      nanogpt: { base: nanogptBase(env), apiKey: nanogptKey },
      guard: { url: env.ANONYMO_MEDIA_GUARD_URL?.trim() || "https://api.ppq.ai/v1", model: env.ANONYMO_MEDIA_GUARD_MODEL?.trim() || "meta-llama/llama-guard-4-12b", apiKey: guardKey },
    });
  return unconfiguredClassifier;
}

export function buildMediaServices(ctx: Pick<Ctx, "cfg">, env: Env = process.env): MediaServices {
  const secret = ctx.cfg.appSecret;
  const key = provenanceKeyFromSeed(hex32(env.ANONYMO_PROVENANCE_KEY, "ANONYMO_PROVENANCE_KEY") ?? derive(secret, "provenance-v1"));
  const previousKeys = (env.ANONYMO_PROVENANCE_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((s) => s.trim().split(":"))
    .filter(([id, pub]) => /^[0-9a-f]{16}$/.test(id ?? "") && /^[0-9a-f]{64}$/.test(pub ?? ""))
    .map(([keyId, publicKeyHex]) => ({ keyId, publicKeyHex }));
  const sidecar = env.ANONYMO_WATERMARK_URL
    ? [httpWatermarker(env.ANONYMO_WATERMARK_URL, { token: env.ANONYMO_WATERMARK_TOKEN, mimes: (env.ANONYMO_WATERMARK_MIMES ?? "video/mp4").split(",").map((s) => s.trim()) })]
    : [];
  const watermarker = chainWatermarkers([...sidecar, lsbWatermarker(hex32(env.ANONYMO_WATERMARK_KEY, "ANONYMO_WATERMARK_KEY") ?? derive(secret, "watermark-v1"))]);
  const classifier = classifierFromEnv(env);
  const studio = ctx.cfg.studioClassifiers;
  const videoFrames = Math.max(1, Math.floor(num(env.ANONYMO_MEDIA_VIDEO_FRAMES, 8)));
  const nanogptKey = env.ANONYMO_NANOGPT_API_KEY?.trim();
  const nanogpt = nanogptKey
    ? nanogptAdapter({ base: nanogptBase(env), apiKey: nanogptKey })
    : unconfigured("NanoGPT");
  const voice = nanogptKey ? nanogptSpeechAdapter({ base: nanogptBase(env), apiKey: nanogptKey }) : undefined;
  const venice = env.ANONYMO_VENICE_API_KEY ? veniceAdapter({ base: env.ANONYMO_VENICE_BASE ?? "https://api.venice.ai/api/v1", apiKey: env.ANONYMO_VENICE_API_KEY }) : unconfigured("Venice");
  const comfy = env.ANONYMO_COMFY_URL ? comfyAdapter({ base: env.ANONYMO_COMFY_URL, token: env.ANONYMO_COMFY_TOKEN, workflows: workflowSet(env.ANONYMO_COMFY_WORKFLOWS_DIR) }) : unconfigured("The ComfyUI worker pool");
  return {
    catalog: MediaCatalog.fromEnv(env),
    compVideo: compVideoConfig(env),
    offered: new Set<Upstream>([
      ...(env.ANONYMO_NANOGPT_API_KEY?.trim() ? (["nanogpt"] as const) : []),
      ...(env.ANONYMO_VENICE_API_KEY ? (["venice"] as const) : []),
      ...(env.ANONYMO_COMFY_URL ? (["comfyui"] as const) : []),
      ...(env.ANONYMO_TTS_URL ? (["tts"] as const) : []),
    ]),
    gate: createMediaGate(classifier, {
      nsfw: num(env.ANONYMO_MEDIA_NSFW_THRESHOLD, 0.5),
      minAdultAge: Math.max(18, num(env.ANONYMO_MEDIA_MIN_ADULT_AGE, 25)),
      videoFrames,
    }),
    ...(studio ? { studio: createStudioGate(
      shieldGemmaClassifier(studio.shieldGemma),
      llavaGuardClassifier(studio.llavaGuard),
      studioPersonClassifier(studio.person),
      videoFrames,
    ) } : {}),
    promptCheck: promptCheckFromEnv(env),
    provenance: createProvenance({ key, watermarker, previousKeys }),
    region: placeholderRegionRules(env),
    store: new MemoryMediaStore(Math.max(16, num(env.ANONYMO_MEDIA_STORE_MB, 512)) * 1024 * 1024),
    images: { venice, comfyui: comfy, nanogpt },
    video: { venice, comfyui: comfy, ...(nanogptKey ? { nanogpt: nanogptVideoAdapter({ base: env.ANONYMO_NANOGPT_BASE?.trim() || undefined, apiKey: nanogptKey }) } : {}) },
    speech: env.ANONYMO_TTS_URL ? ttsAdapter({ base: env.ANONYMO_TTS_URL, token: env.ANONYMO_TTS_TOKEN }) : unconfigured("The TTS worker pool"),
    nanogptSpeech: voice,
    transcription: voice,
    ttlMs: Math.min(86_400, Math.max(60, num(env.ANONYMO_MEDIA_TTL_S, 3600))) * 1000,
    pollIntervalMs: 2000,
  };
}

const registry = new WeakMap<object, MediaServices>();
export function mediaServices(ctx: Ctx): MediaServices {
  let s = registry.get(ctx);
  if (!s) registry.set(ctx, (s = buildMediaServices(ctx)));
  return s;
}
/** Replace some of a gateway's media services (tests, or a deployment wiring its own). */
export function setMediaServices(ctx: Ctx, patch: Partial<MediaServices>): MediaServices {
  const next = { ...mediaServices(ctx), ...patch };
  registry.set(ctx, next);
  return next;
}
/** Region rules: WS02's on ctx.anonymo once they exist there, this module's placeholder until then. */
export const regionRulesOf = (ctx: Ctx, s: MediaServices): RegionRules => (ctx.anonymo as { region?: RegionRules }).region ?? s.region;

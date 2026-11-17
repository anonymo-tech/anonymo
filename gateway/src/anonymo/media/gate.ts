// MediaGate (seams.ts): NSFW score × apparent age on every image and on sampled video frames, before anything is
// stored or returned. Scores come from a classifier service (WS10 hosts it next to the ComfyUI workers) through
// MediaClassifier; tests use a double. The gate fails CLOSED: a classifier that errors, times out, returns too few
// frames or numbers that are not numbers is a block ("unscored"), never a pass.

import type { MediaGate, MediaVerdict } from "../seams.ts";
import { normalizeMime } from "./containers.ts";

export type FrameScore = {
  /** Probability the frame is sexually explicit, 0–1. */
  nsfw: number;
  /** Apparent age of the youngest person in the frame; null when the frame shows no person. */
  apparentAge: number | null;
  /** Probability a person shown is a real, identifiable individual (photo-real likeness), 0–1. Optional. */
  realPerson?: number | null;
};
export interface MediaClassifier {
  /** Score an image (one frame) or a video (the service samples `frames` frames across its length). */
  score(bytes: Uint8Array, mime: string, opts: { frames: number; signal?: AbortSignal }): Promise<{ frames: FrameScore[] }>;
}

export type GateThresholds = {
  /** At or above this NSFW score a frame counts as explicit. */
  nsfw: number;
  /** An explicit frame whose youngest apparent age is under this is blocked. Set well above 18: open age estimators
   *  are weak on synthetic images (Overview §11), so the margin is deliberate. */
  minAdultAge: number;
  /** An explicit frame at or above this real-person score is blocked. */
  realPerson: number;
  /** Frames sampled from every video. */
  videoFrames: number;
  timeoutMs: number;
};
export const DEFAULT_THRESHOLDS: GateThresholds = { nsfw: 0.5, minAdultAge: 25, realPerson: 0.5, videoFrames: 8, timeoutMs: 20_000 };

/** Why a gate stopped an output. The first three are the seam's MediaVerdict reasons. */
export type GateReason = "nsfw_minor" | "nsfw_real_person" | "unscored" | "explicit" | "explicit_from_upload";
export type GateResult = { ok: true; explicit: boolean } | { ok: false; reason: GateReason };
export type AssessOptions = {
  /** False: any explicit frame blocks. The media routes always pass false (Anonymo's images and video are SFW only). */
  explicitAllowed: boolean;
  /** True for edits of an uploaded photo: any explicit frame blocks (no NSFW edits of uploads). */
  fromUpload?: boolean;
  signal?: AbortSignal;
};

const isScore = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isAge = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 130);

/** The decision for a list of frame scores, as a pure function so it can be tested exhaustively. */
export function judgeFrames(frames: unknown, expected: number, opts: Pick<AssessOptions, "explicitAllowed" | "fromUpload">, t: GateThresholds = DEFAULT_THRESHOLDS): GateResult {
  if (!Array.isArray(frames) || frames.length < expected) return { ok: false, reason: "unscored" };
  let explicit = false;
  for (const f of frames as FrameScore[]) {
    if (!f || !isScore(f.nsfw) || !isAge(f.apparentAge) || (f.realPerson != null && !isScore(f.realPerson))) return { ok: false, reason: "unscored" };
  }
  // Minors first: the most serious reason wins whatever else a later frame shows.
  for (const f of frames as FrameScore[]) {
    if (f.nsfw < t.nsfw) continue;
    explicit = true;
    if (f.apparentAge !== null && f.apparentAge < t.minAdultAge) return { ok: false, reason: "nsfw_minor" };
  }
  for (const f of frames as FrameScore[]) {
    if (f.nsfw >= t.nsfw && f.realPerson != null && f.realPerson >= t.realPerson) return { ok: false, reason: "nsfw_real_person" };
  }
  // An explicit frame whose age the estimator could not read cannot be shown to be of an adult: fail closed.
  if ((frames as FrameScore[]).some((f) => f.nsfw >= t.nsfw && f.apparentAge === null)) return { ok: false, reason: "unscored" };
  if (explicit && opts.fromUpload) return { ok: false, reason: "explicit_from_upload" };
  if (explicit && !opts.explicitAllowed) return { ok: false, reason: "explicit" };
  return { ok: true, explicit };
}

export interface MediaOutputGate extends MediaGate {
  assess(bytes: Uint8Array, mime: string, opts: AssessOptions): Promise<GateResult>;
}

export function createMediaGate(classifier: MediaClassifier, thresholds: Partial<GateThresholds> = {}): MediaOutputGate {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  async function assess(bytes: Uint8Array, mimeIn: string, opts: AssessOptions): Promise<GateResult> {
    const mime = normalizeMime(mimeIn);
    const visual = mime.startsWith("image/") || mime.startsWith("video/");
    if (!visual) return { ok: false, reason: "unscored" };
    const frames = mime.startsWith("video/") ? t.videoFrames : 1;
    let scored: { frames: FrameScore[] };
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(t.timeoutMs), ...(opts.signal ? [opts.signal] : [])]);
      scored = await classifier.score(bytes, mime, { frames, signal });
    } catch {
      return { ok: false, reason: "unscored" };
    }
    return judgeFrames(scored?.frames, frames, opts, t);
  }
  return {
    assess,
    async check(bytes, mime): Promise<MediaVerdict> {
      const r = await assess(bytes, mime, { explicitAllowed: true });
      if (r.ok) return { ok: true };
      return { ok: false, reason: r.reason === "nsfw_minor" || r.reason === "nsfw_real_person" ? r.reason : "unscored" };
    },
  };
}

/**
 * The classifier service client. Contract, defined here for WS10:
 *   POST {base}/v1/score   body = media bytes, content-type = mime, x-sample-frames = N
 *   → 200 {"frames": [{"nsfw": 0..1, "apparent_age": years | null, "real_person": 0..1 | null}, …]}
 * Video frames are sampled evenly across the clip by the service, which decodes the media itself.
 */
export function httpClassifier(base: string, opts: { token?: string; fetch?: typeof fetch } = {}): MediaClassifier {
  const f = opts.fetch ?? fetch;
  return {
    async score(bytes, mime, { frames, signal }) {
      const r = await f(base.replace(/\/$/, "") + "/v1/score", {
        method: "POST",
        headers: { "content-type": mime, "x-sample-frames": String(frames), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        body: bytes,
        signal,
      });
      if (!r.ok) throw new Error(`classifier returned ${r.status}`);
      const j = (await r.json()) as { frames?: { nsfw?: unknown; apparent_age?: unknown; real_person?: unknown }[] };
      if (!Array.isArray(j.frames)) throw new Error("classifier returned no frames");
      return { frames: j.frames.map((x) => ({ nsfw: x?.nsfw as number, apparentAge: (x?.apparent_age ?? null) as number | null, realPerson: (x?.real_person ?? null) as number | null })) };
    },
  };
}

/** No classifier configured: every output is unscored, so nothing visual is ever returned. */
export const unconfiguredClassifier: MediaClassifier = {
  async score() {
    throw new Error("media classifier not configured (ANONYMO_MEDIA_CLASSIFIER_URL)");
  },
};

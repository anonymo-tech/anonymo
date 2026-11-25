// The sidecars receive media bytes only, and return constrained verdicts. Keep model rationales out of receipts.
import type { Media } from "./upstreams.ts";

export type StudioVerdict = "safe" | "unsafe" | "unavailable";
export type OutputVerdicts = { shieldgemma2: StudioVerdict; llavaguard: StudioVerdict };
export type StudioSafety = { prompt: StudioVerdict; upload?: StudioVerdict; outputs: OutputVerdicts[] };

export interface StudioOutputClassifier {
  classify(media: Media, frames: number, signal: AbortSignal): Promise<"safe" | "unsafe">;
}

export interface StudioPersonClassifier {
  classify(media: Media, signal: AbortSignal): Promise<{ faceDetected: boolean; personLikeness: boolean }>;
}

export const isStudioVerdict = (v: unknown): v is StudioVerdict => v === "safe" || v === "unsafe" || v === "unavailable";

export function stricterVerdict(...verdicts: StudioVerdict[]): StudioVerdict {
  if (verdicts.includes("unsafe")) return "unsafe";
  return verdicts.includes("unavailable") ? "unavailable" : "safe";
}

export function createStudioGate(
  shieldgemma2: StudioOutputClassifier,
  llavaguard: StudioOutputClassifier,
  person: StudioPersonClassifier,
  videoFrames: number,
) {
  const deadline = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  return {
    async output(media: Media, signal?: AbortSignal): Promise<OutputVerdicts> {
      const frames = media.mime.startsWith("video/") ? videoFrames : 1;
      const bounded = deadline(signal);
      const check = async (classifier: StudioOutputClassifier): Promise<StudioVerdict> => {
        try {
          const verdict = await classifier.classify(media, frames, bounded);
          return verdict === "safe" || verdict === "unsafe" ? verdict : "unavailable";
        } catch {
          return "unavailable";
        }
      };
      const [shield, llava] = await Promise.all([check(shieldgemma2), check(llavaguard)]);
      return { shieldgemma2: shield, llavaguard: llava };
    },
    async upload(media: Media, signal?: AbortSignal): Promise<StudioVerdict> {
      try {
        const { faceDetected, personLikeness } = await person.classify(media, deadline(signal));
        if (typeof faceDetected !== "boolean" || typeof personLikeness !== "boolean") return "unavailable";
        // The likeness check also covers obscured faces and people facing away.
        return personLikeness ? "unsafe" : "safe";
      } catch {
        return "unavailable";
      }
    },
  };
}

type Endpoint = { url?: string; token?: string };
type Fetch = typeof fetch;

async function inspect(endpoint: Endpoint, path: string, media: Media, signal: AbortSignal, send: Fetch, frames?: number): Promise<unknown> {
  if (!endpoint.url) throw new Error("Studio classifier is not configured");
  const response = await send(endpoint.url.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: {
      "content-type": media.mime,
      ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
      ...(frames == null ? {} : { "x-sample-frames": String(frames) }),
    },
    body: media.bytes,
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Studio classifier request failed");
  }
  return response.json();
}

function outputClassifier(endpoint: Endpoint, path: string, send: Fetch): StudioOutputClassifier {
  return {
    async classify(media, frames, signal) {
      const result = await inspect(endpoint, path, media, signal, send, frames) as { frames?: unknown };
      const labels = result?.frames;
      if (!Array.isArray(labels) || labels.length !== frames || labels.some((label) => label !== "safe" && label !== "unsafe"))
        throw new Error("Studio classifier returned invalid frame verdicts");
      return labels.includes("unsafe") ? "unsafe" : "safe";
    },
  };
}

export const shieldGemmaClassifier = (endpoint: Endpoint, send: Fetch = fetch) => outputClassifier(endpoint, "/v1/shieldgemma2", send);
export const llavaGuardClassifier = (endpoint: Endpoint, send: Fetch = fetch) => outputClassifier(endpoint, "/v1/llavaguard", send);

export function studioPersonClassifier(endpoint: Endpoint, send: Fetch = fetch): StudioPersonClassifier {
  return {
    async classify(media, signal) {
      const result = await inspect(endpoint, "/v1/person-likeness", media, signal, send) as { face_detected?: unknown; person_likeness?: unknown };
      if (typeof result?.face_detected !== "boolean" || typeof result.person_likeness !== "boolean")
        throw new Error("Studio classifier returned an invalid person verdict");
      return { faceDetected: result.face_detected, personLikeness: result.person_likeness };
    },
  };
}

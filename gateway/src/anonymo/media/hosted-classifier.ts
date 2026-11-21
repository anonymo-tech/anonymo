// A media classifier built from two hosted checks, for gateways without their own classifier service (gate.ts
// httpClassifier). Both see every image and either one can block it:
//   1. NanoGPT's NSFW image check (POST {origin}/api/nsfw/image): a yes/no on nudity and sexual content.
//   2. Llama Guard 4 (a vision safety model, here through PPQ's OpenAI-compatible API): "unsafe" with S4 (child
//      sexual exploitation) marks the image as showing a minor; S3 or S12 (sex crimes, sexual content) as explicit.
//      Other Llama Guard categories (violence and so on) are allowed in Anonymo's images and are ignored here.
// Neither estimates an age, so an explicit image is scored with no age: the gate blocks it as explicit (images and
// video are safe for work only). It fails closed like every classifier: any error, timeout or odd answer throws,
// and the gate turns that into a block. A video is checked as still frames (video-frames.ts samples the number the
// gate asks for), each through both checks; any frame that cannot be read or checked blocks the whole clip.
// Each image or frame travels as a data URL; nothing about it is logged or stored.

import type { FrameScore, MediaClassifier } from "./gate.ts";
import { normalizeMime } from "./containers.ts";
import { sampleVideoFrames } from "./video-frames.ts";

export type HostedClassifierOptions = {
  nanogpt: { base: string; apiKey: string };
  guard: { url: string; model: string; apiKey: string };
  fetch?: typeof fetch;
  /** Frame sampler for video (tests replace it). */
  frames?: typeof sampleVideoFrames;
};

export const LLAMA_GUARD_MINOR = ["S4"];
export const LLAMA_GUARD_SEXUAL = ["S3", "S12"];

/** Llama Guard's answer: "safe", or "unsafe" and a line of category codes ("S1,S12"). Anything else throws. */
export function parseGuardVerdict(content: unknown): { unsafe: boolean; categories: string[] } {
  if (typeof content !== "string") throw new Error("guard answer is not text");
  const lines = content.trim().split(/\s*\n\s*/);
  if (lines[0] === "safe") return { unsafe: false, categories: [] };
  if (lines[0] !== "unsafe") throw new Error("guard answer is neither safe nor unsafe");
  const categories = (lines[1] ?? "").split(/[,\s]+/).filter(Boolean);
  if (!categories.length || categories.some((c) => !/^S\d{1,2}$/.test(c))) throw new Error("guard answer has no categories");
  return { unsafe: true, categories };
}

/** The frame score for the two answers. Exported for tests. */
export function hostedFrame(nsfw: boolean, guard: { unsafe: boolean; categories: string[] }): FrameScore {
  const has = (list: string[]) => guard.unsafe && guard.categories.some((c) => list.includes(c));
  if (has(LLAMA_GUARD_MINOR)) return { nsfw: 1, apparentAge: 0, realPerson: null };
  if (nsfw || has(LLAMA_GUARD_SEXUAL)) return { nsfw: 1, apparentAge: null, realPerson: null };
  return { nsfw: 0, apparentAge: null, realPerson: null };
}

export function hostedClassifier(o: HostedClassifierOptions): MediaClassifier {
  const f = o.fetch ?? fetch;
  const nsfwUrl = `${new URL(o.nanogpt.base).origin}/api/nsfw/image`;
  const guardUrl = `${o.guard.url.replace(/\/+$/, "")}/chat/completions`;

  async function nanogptNsfw(dataUrl: string, signal?: AbortSignal): Promise<boolean> {
    const r = await f(nsfwUrl, { method: "POST", headers: { "content-type": "application/json", "x-api-key": o.nanogpt.apiKey }, body: JSON.stringify({ imageDataUrl: dataUrl }), signal });
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined);
      throw new Error(`NSFW check returned ${r.status}`);
    }
    const j = (await r.json()) as { has_nsfw_concepts?: unknown };
    const v = Array.isArray(j?.has_nsfw_concepts) ? j.has_nsfw_concepts[0] : undefined;
    if (typeof v !== "boolean") throw new Error("NSFW check returned no answer");
    return v;
  }

  async function llamaGuard(dataUrl: string, signal?: AbortSignal) {
    const r = await f(guardUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${o.guard.apiKey}` },
      body: JSON.stringify({
        model: o.guard.model,
        messages: [{ role: "user", content: [{ type: "text", text: "Here is an image." }, { type: "image_url", image_url: { url: dataUrl } }] }],
        max_tokens: 20,
        temperature: 0,
      }),
      signal,
    });
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined);
      throw new Error(`image guard returned ${r.status}`);
    }
    const j = (await r.json()) as { choices?: { message?: { content?: unknown } }[] };
    return parseGuardVerdict(j?.choices?.[0]?.message?.content);
  }

  return {
    async score(bytes, mimeIn, { frames: count, signal }) {
      const mime = normalizeMime(mimeIn);
      const check = async (image: Uint8Array, imageMime: string) => {
        const dataUrl = `data:${imageMime};base64,${Buffer.from(image).toString("base64")}`;
        const [nsfw, guard] = await Promise.all([nanogptNsfw(dataUrl, signal), llamaGuard(dataUrl, signal)]);
        return hostedFrame(nsfw, guard);
      };
      if (mime.startsWith("image/")) return { frames: [await check(bytes, mime)] };
      if (mime !== "video/mp4") throw new Error("the hosted classifier checks images and MP4 video only");
      const stills = await (o.frames ?? sampleVideoFrames)(bytes, count, { signal });
      if (stills.length !== count) throw new Error("not every video frame was sampled");
      return { frames: await Promise.all(stills.map((still) => check(still, "image/png"))) };
    },
  };
}

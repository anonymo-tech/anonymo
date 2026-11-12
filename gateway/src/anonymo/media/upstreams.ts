// Media upstream adapters. Each one returns raw bytes; nothing an upstream returns is passed on before the media
// gate and provenance have run (pipeline.ts). Media is only ever taken inline (base64 or a response body from the
// configured host), never fetched from a URL an upstream names, so an upstream cannot point the gateway elsewhere.
//
// (U) Request shapes for Venice's image and video endpoints and for the ComfyUI worker pool are written from their
// public API documentation and have not been exercised against live hosts (no keys or GPUs were available).

import type { WorkflowSet } from "./workflows.ts";
import { sniffMime } from "./containers.ts";

export type Media = { bytes: Uint8Array; mime: string };
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/** An upstream failure. Nothing was delivered, so the caller's hold is released and nothing is charged. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The upstream rejected the request itself (4xx other than auth/limits), as opposed to being down. */
    readonly rejected = false,
  ) {
    super(message);
  }
}

export type ImageRequest = { model: string; prompt: string; n: number; width: number; height: number; seed: number; safe: boolean; image?: Media };
export type SpeechRequest = { model: string; input: string; voice: string; speed: number };
export type VideoRequest = { model: string; prompt: string; seconds: number; width: number; height: number; seed: number; safe: boolean };
export type VideoPoll = { state: "running" } | { state: "failed"; message: string } | { state: "done"; media: Media };

export interface ImageUpstream {
  generate(r: ImageRequest, signal: AbortSignal): Promise<Media[]>;
}
export interface SpeechUpstream {
  speak(r: SpeechRequest, signal: AbortSignal): Promise<Media>;
}
export interface VideoUpstream {
  /** Start a job; returns the upstream's reference for it. */
  submit(r: VideoRequest, signal: AbortSignal): Promise<string>;
  poll(ref: string, model: string, signal: AbortSignal): Promise<VideoPoll>;
}

async function readCapped(r: Response): Promise<Uint8Array> {
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > MAX_MEDIA_BYTES) throw new UpstreamError("upstream media exceeds 100 MB", 502);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > MAX_MEDIA_BYTES) throw new UpstreamError("upstream media exceeds 100 MB", 502);
  return b;
}
const failed = (label: string, status: number) =>
  new UpstreamError(`${label} returned ${status}`, [401, 402, 403, 429].includes(status) || status >= 500 ? 503 : 502, status >= 400 && status < 500 && ![401, 402, 403, 408, 429].includes(status));
const media = (bytes: Uint8Array, claimed?: string | null): Media => ({ bytes, mime: sniffMime(bytes) ?? (claimed ?? "application/octet-stream").split(";")[0].trim() });
const b64 = (s: unknown) => (typeof s === "string" && /^[A-Za-z0-9+/=\s]+$/.test(s) ? new Uint8Array(Buffer.from(s, "base64")) : null);
const sizeOf = (w: number, h: number) => (w === h ? "1:1" : w > h ? "16:9" : "9:16");

// ---- Venice (T0) ---------------------------------------------------------------------------------------------------
export function veniceAdapter(o: { base: string; apiKey: string; fetch?: typeof fetch }): ImageUpstream & VideoUpstream {
  const f = o.fetch ?? fetch;
  const call = (path: string, body: unknown, signal: AbortSignal) =>
    f(o.base.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` }, body: JSON.stringify(body), signal });
  return {
    async generate(r, signal) {
      if (r.image) throw new UpstreamError("Venice image edits are not wired", 400, true);
      const out: Media[] = [];
      for (let i = 0; i < r.n; i++) {
        const res = await call("/image/generate", { model: r.model, prompt: r.prompt, width: r.width, height: r.height, seed: r.seed + i, format: "png", safe_mode: r.safe, hide_watermark: true, return_binary: false }, signal);
        if (!res.ok) throw failed("Venice image", res.status);
        const j = (await res.json()) as { images?: unknown[] };
        const bytes = b64(j.images?.[0]);
        if (!bytes?.length) throw new UpstreamError("Venice returned no image", 502);
        out.push(media(bytes, "image/png"));
      }
      return out;
    },
    async submit(r, signal) {
      const res = await call("/video/queue", { model: r.model, prompt: r.prompt, duration: `${r.seconds}s`, aspect_ratio: sizeOf(r.width, r.height), resolution: `${Math.min(r.width, r.height)}p`, seed: r.seed, safe_mode: r.safe }, signal);
      if (!res.ok) throw failed("Venice video", res.status);
      const j = (await res.json()) as { queue_id?: unknown };
      if (typeof j.queue_id !== "string" || !j.queue_id) throw new UpstreamError("Venice returned no queue id", 502);
      return j.queue_id;
    },
    async poll(ref, model, signal) {
      const res = await call("/video/retrieve", { model, queue_id: ref, delete_media_on_completion: true }, signal);
      if (!res.ok) return res.status >= 500 || res.status === 429 ? { state: "running" } : { state: "failed", message: `Venice video returned ${res.status}` };
      const type = res.headers.get("content-type") ?? "";
      if (type.startsWith("video/")) return { state: "done", media: media(await readCapped(res), type) };
      const j = (await res.json().catch(() => ({}))) as { status?: string };
      return /fail|error/i.test(j.status ?? "") ? { state: "failed", message: "Venice video job failed" } : { state: "running" };
    },
  };
}

// ---- ComfyUI worker pool (T1, self-hosted) -------------------------------------------------------------------------
type ComfyFile = { filename: string; subfolder?: string; type?: string };
type ComfyHistory = Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, Record<string, ComfyFile[] | unknown>> }>;

export function comfyAdapter(o: { base: string; token?: string; workflows: WorkflowSet; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number }): ImageUpstream & VideoUpstream {
  const f = o.fetch ?? fetch;
  const url = (p: string) => o.base.replace(/\/$/, "") + p;
  const auth: Record<string, string> = o.token ? { authorization: `Bearer ${o.token}` } : {};
  const negative = "";

  async function queue(graph: unknown, signal: AbortSignal): Promise<string> {
    const r = await f(url("/prompt"), { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ prompt: graph, client_id: "anonymo-gateway" }), signal });
    if (!r.ok) throw failed("ComfyUI", r.status);
    const j = (await r.json()) as { prompt_id?: unknown };
    if (typeof j.prompt_id !== "string" || !j.prompt_id) throw new UpstreamError("ComfyUI returned no prompt id", 502);
    return j.prompt_id;
  }
  async function history(id: string, signal: AbortSignal) {
    const r = await f(url(`/history/${encodeURIComponent(id)}`), { headers: auth, signal });
    if (!r.ok) throw failed("ComfyUI history", r.status);
    return ((await r.json()) as ComfyHistory)[id] ?? null;
  }
  async function files(entry: NonNullable<ComfyHistory[string]>, signal: AbortSignal): Promise<Media[]> {
    const out: Media[] = [];
    for (const node of Object.values(entry.outputs ?? {}))
      for (const key of ["images", "gifs", "videos"]) {
        const list = node[key];
        if (!Array.isArray(list)) continue;
        for (const file of list as ComfyFile[]) {
          if (!file?.filename || (file.type && file.type !== "output")) continue;
          const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: "output" });
          const r = await f(url(`/view?${q}`), { headers: auth, signal });
          if (!r.ok) throw failed("ComfyUI view", r.status);
          out.push(media(await readCapped(r), r.headers.get("content-type")));
        }
      }
    return out;
  }
  /** Best effort: drop the job from the worker's history. Its files are removed by the worker's own cleaner (WS10). */
  const forget = (id: string) => f(url("/history"), { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ delete: [id] }) }).catch(() => undefined);
  async function upload(image: Media, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([image.bytes as unknown as ArrayBuffer], { type: image.mime }), `in-${crypto.randomUUID()}.png`);
    form.append("type", "input");
    form.append("overwrite", "true");
    const r = await f(url("/upload/image"), { method: "POST", headers: auth, body: form, signal });
    if (!r.ok) throw failed("ComfyUI upload", r.status);
    const j = (await r.json()) as { name?: unknown; subfolder?: unknown };
    if (typeof j.name !== "string") throw new UpstreamError("ComfyUI upload returned no name", 502);
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }
  async function run(graph: unknown, signal: AbortSignal): Promise<Media[]> {
    const id = await queue(graph, signal);
    const deadline = Date.now() + (o.timeoutMs ?? 180_000);
    try {
      for (;;) {
        const h = await history(id, signal);
        if (h?.status?.status_str === "error") throw new UpstreamError("ComfyUI job failed", 502);
        if (h?.status?.completed || (h?.outputs && Object.keys(h.outputs).length)) return await files(h, signal);
        if (Date.now() > deadline) throw new UpstreamError("ComfyUI job timed out", 504);
        await Bun.sleep(o.pollMs ?? 500);
      }
    } finally {
      void forget(id);
    }
  }
  return {
    async generate(r, signal) {
      const image = r.image ? await upload(r.image, signal) : undefined;
      const out: Media[] = [];
      for (let i = 0; i < r.n; i++) out.push(...(await run(o.workflows.build(r.model, { prompt: r.prompt, negative, seed: r.seed + i, width: r.width, height: r.height, image }), signal)).slice(0, 1));
      if (out.length < r.n) throw new UpstreamError("ComfyUI returned fewer images than asked", 502);
      return out;
    },
    async submit(r, signal) {
      const fps = 24;
      return queue(o.workflows.build(r.model, { prompt: r.prompt, negative, seed: r.seed, width: r.width, height: r.height, frames: r.seconds * fps + 1, fps }), signal);
    },
    async poll(ref, _model, signal) {
      const h = await history(ref, signal);
      if (!h) return { state: "running" };
      if (h.status?.status_str === "error") {
        void forget(ref);
        return { state: "failed", message: "Video job failed on the worker" };
      }
      if (!h.status?.completed && !(h.outputs && Object.keys(h.outputs).length)) return { state: "running" };
      try {
        const list = await files(h, signal);
        const video = list.find((m) => m.mime.startsWith("video/"));
        return video ? { state: "done", media: video } : { state: "failed", message: "Worker produced no video" };
      } finally {
        void forget(ref);
      }
    },
  };
}

// ---- OpenAI-compatible TTS workers (Kokoro-FastAPI and peers) -------------------------------------------------------
export function ttsAdapter(o: { base: string; token?: string; fetch?: typeof fetch }): SpeechUpstream {
  const f = o.fetch ?? fetch;
  return {
    async speak(r, signal) {
      const res = await f(o.base.replace(/\/$/, "") + "/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
        body: JSON.stringify({ model: r.model, input: r.input, voice: r.voice, response_format: "wav", speed: r.speed }),
        signal,
      });
      if (!res.ok) throw failed("TTS worker", res.status);
      const bytes = await readCapped(res);
      if (!bytes.length) throw new UpstreamError("TTS worker returned no audio", 502);
      return media(bytes, res.headers.get("content-type"));
    },
  };
}

/** An upstream that is not configured: requests for its models fail with 503 and nothing is charged. */
export const unconfigured = (what: string): ImageUpstream & VideoUpstream & SpeechUpstream => {
  const no = async (): Promise<never> => {
    throw new UpstreamError(`${what} is not configured on this gateway`, 503);
  };
  return { generate: no, submit: no, poll: no, speak: no };
};

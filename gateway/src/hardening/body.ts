import type { Context } from "hono";
import type { Config } from "../config.ts";
import { TRANSCRIPTION_MAX_BYTES } from "../anonymo/media/voice-models.ts";
import { KEY_SAFE_BODY_MAX, KEY_SAFE_PATH } from "../anonymo/keysafe/wire.ts";
const LARGE = 16 * 1024 * 1024;
/** Preserve existing image/file wire limits; their route-specific semantic caps still apply. */
export function requestCap(path: string, cfg: Config): number {
  if (cfg.features.keySafe && (path === KEY_SAFE_PATH || path === `${KEY_SAFE_PATH}/lookup`))
    return Math.min(KEY_SAFE_BODY_MAX, cfg.hardening.requestMaxBytes);
  if (/^\/(api\/v1|v1)\/audio\/transcriptions$/.test(path)) return TRANSCRIPTION_MAX_BYTES;
  if (path === "/mcp") return cfg.hardening.mcpMaxBytes;
  if (/^\/(api\/v1|v1)\/(chat\/completions|responses|messages|batches)$/.test(path)) return LARGE;
  return cfg.hardening.requestMaxBytes;
}
export async function capBody(c: Context, cap: number): Promise<Response | undefined> {
  const tooLarge = () => c.json({ error: { type: "payload_too_large", message: `Request body exceeds ${cap} bytes.`, max_bytes: cap } }, 413);
  if (Number(c.req.header("content-length") ?? 0) > cap) { void c.req.raw.body?.cancel().catch(() => {}); return tooLarge(); }
  const original = c.req.raw;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > cap) { void reader.cancel().catch(() => {}); return tooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  // Retain at most cap bytes, and preserve cancellation, headers and the original URL for downstream handlers.
  c.req.raw = new Request(original.url, { method: original.method, headers: original.headers, body: Buffer.concat(chunks, size), signal: original.signal });
}

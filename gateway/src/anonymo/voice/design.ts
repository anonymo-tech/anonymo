import { z } from "zod";
import { fail } from "../../lib/errors.ts";
import { KOKORO_VOICES, QWEN3_TTS_VOICES } from "../media/catalog.ts";
import { readCapped, type SpeechUpstream } from "../media/upstreams.ts";

const TEXTURE = new Set((
  "a an and with very quite slightly softly moderately gently voice sound tone texture pitch pace speaking " +
  "warm cool low lower deep higher high mid medium soft clear airy breathy husky gravelly raspy bright dark " +
  "resonant round rich smooth textured crisp steady slow slower fast faster measured relaxed calm composed " +
  "gentle friendly lively playful dry youthful mature adult formal casual neutral expressive energetic " +
  "even loud quiet deliberate clipped lilting melodic understated soothing pleasant confident precise " +
  "nasal throaty velvety rounded fluent rhythmic careful light heavy feminine masculine androgynous " +
  "whispery spoken conversational soft-spoken matter-of-fact somewhat but lightly warm-toned"
).split(" "));

export const descriptionBody = z.object({ description: z.string().trim().min(1).max(300) }).strict();
export const saveBody = z.object({ preview_id: z.string().uuid(), name: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{M}\p{N} ._'-]+$/u) }).strict();
export const STOCK_IDS = [...KOKORO_VOICES.map((name) => `kokoro:${name}`), ...QWEN3_TTS_VOICES.map((name) => `qwen3-tts:${name}`)];
const vector = z.array(z.number().finite().min(-1e6).max(1e6)).min(8).max(4096);
const VECTOR_THRESHOLD = 0.9;
export const PREVIEW_LINE = "The last light is still on. We can sit here a little longer.";

export function voiceTraits(description: string) {
  const terms = description.toLowerCase().split(/[\s,.;]+/).filter(Boolean);
  if (!terms.length || !terms.every((term) => TEXTURE.has(term)))
    fail(451, "Describe pitch, pace and tone using voice traits from the examples.", "voice_traits_only", { category: "voice_clone" });
  return terms.join(" ");
}

export function compareStock(embedding: readonly number[], registry: Record<string, number[]>) {
  function norm(v: readonly number[]) { return Math.sqrt(v.reduce((sum, n) => sum + n * n, 0)); }
  const length = norm(embedding);
  if (!length) fail(502, "The voice designer returned an invalid embedding.", "voice_design_unavailable");
  for (const id of STOCK_IDS) {
    const stock = registry[id];
    if (stock?.length !== embedding.length || !norm(stock))
      fail(503, "Stock voice verification is unavailable.", "voice_design_unavailable");
    const dot = stock.reduce((sum, n, i) => sum + n * embedding[i], 0);
    if (dot / (length * norm(stock)) >= VECTOR_THRESHOLD)
      fail(451, "This design is too close to a stock voice. Try different traits.", "stock_voice_similarity", { category: "voice_clone" });
  }
}

const pack = (values: number[]) => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((n, i) => bytes.writeFloatLE(n, 4 * i));
  return bytes;
};
const unpack = (bytes: Buffer) => Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));

export function voiceDesigner(cfg: { url?: string; token?: string }, request: typeof fetch = fetch) {
  let cached: { until: number; registry: Record<string, number[]> } | undefined;
  async function call(path: string, signal: AbortSignal, body?: object) {
    if (!cfg.url) fail(503, "Voice design is unavailable.", "voice_design_unavailable");
    try {
      const res = await request(cfg.url.replace(/\/$/, "") + path, {
        method: body ? "POST" : "GET", redirect: "error",
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
        body: body && JSON.stringify(body),
        signal,
      });
      if (res.ok) return res;
      await res.body?.cancel();
    } catch {
      signal.throwIfAborted();
    }
    fail(502, "The voice designer is unavailable.", "voice_design_unavailable");
  }

  async function json<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: object) {
    try {
      return schema.parse(JSON.parse(new TextDecoder().decode(await readCapped(await call(path, signal, body), 8 * 1024 * 1024))));
    } catch {
      signal.throwIfAborted();
      fail(502, "Voice verification is unavailable.", "voice_design_unavailable");
    }
  }

  async function stock(signal: AbortSignal) {
    if (cached && cached.until > Date.now()) return cached.registry;
    const registry = await json("/v1/voices/stock-embeddings", z.record(z.string(), vector), signal);
    cached = { registry, until: Date.now() + 60_000 };
    return registry;
  }

  return {
    async design(description: string, signal: AbortSignal) {
      const registry = await stock(signal);
      const result = await json("/v1/voices/design", z.object({ embedding: vector }).strict(), signal, { model: "qwen3-tts", description });
      const embedding = pack(result.embedding);
      compareStock(unpack(embedding), registry);
      return embedding;
    },
    speech(lookup: (signal: AbortSignal) => Promise<Buffer>): SpeechUpstream {
      return {
        async speak({ input }, signal) {
          const embedding = unpack(await lookup(signal));
          compareStock(embedding, await stock(signal));
          const res = await call("/v1/voices/speech", signal, { model: "qwen3-tts", input, embedding, response_format: "wav" });
          const bytes = await readCapped(res, 8 * 1024 * 1024);
          return { bytes, mime: res.headers.get("content-type")?.split(";")[0] ?? "audio/wav" };
        },
      };
    },
  };
}

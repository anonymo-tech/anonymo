// Client for a guard model (Llama Guard 3-1B / ShieldGemma-2B class) served behind an OpenAI-compatible endpoint,
// self-hosted or on a TEE route. Every failure (timeout, HTTP error, bad JSON, unparseable verdict) throws, and the
// gate turns a throw into a closed failure: the request is never served unchecked.
//
// Long inputs are checked in overlapping chunks so nothing is skipped; past `maxChunks` the client refuses to answer
// (fails closed) rather than checking only part of the text.

import type { FloorCategory } from "../seams.ts";
import { FLOOR_POLICY, FloorParseError, llamaGuardChatMessages, llamaGuardPrompt, parseLlamaGuard, parseShieldGemma, shieldGemmaPrompt } from "./policy.ts";

export type GuardFormat = "llama-guard" | "llama-guard-chat" | "shieldgemma";

export type GuardClientOptions = {
  url: string; // base URL of the OpenAI-compatible server, e.g. https://guard.internal/v1
  model: string;
  apiKey?: string;
  format?: GuardFormat;
  timeoutMs?: number; // per HTTP call
  chunkChars?: number;
  overlapChars?: number;
  maxChunks?: number;
  concurrency?: number;
  fetch?: typeof fetch;
};

export class FloorUnavailableError extends Error {}

export class GuardModelClient {
  readonly format: GuardFormat;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly chunkChars: number;
  private readonly overlapChars: number;
  private readonly maxChunks: number;
  private readonly concurrency: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GuardClientOptions) {
    if (!/^https?:\/\//.test(opts.url)) throw new Error("ANONYMO_FLOOR_URL must be an http(s) URL");
    if (!opts.model) throw new Error("ANONYMO_FLOOR_MODEL is required with ANONYMO_FLOOR_URL");
    this.base = opts.url.replace(/\/+$/, "");
    this.format = opts.format ?? "llama-guard";
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.chunkChars = opts.chunkChars ?? 8000;
    this.overlapChars = Math.min(opts.overlapChars ?? 400, Math.floor(this.chunkChars / 4));
    this.maxChunks = opts.maxChunks ?? 32;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** The first violated category across all chunks, or null when every chunk is safe. */
  async classify(text: string, signal?: AbortSignal): Promise<FloorCategory | null> {
    const chunks = chunk(text, this.chunkChars, this.overlapChars);
    if (chunks.length > this.maxChunks) throw new FloorUnavailableError("input too long for the floor gate");
    const found: (FloorCategory | null)[] = new Array(chunks.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        found[i] = await this.classifyOne(chunks[i], signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, chunks.length) }, worker));
    for (const p of FLOOR_POLICY) if (found.includes(p.category)) return p.category;
    return null;
  }

  private async classifyOne(text: string, signal?: AbortSignal): Promise<FloorCategory | null> {
    if (this.format === "llama-guard") return parseLlamaGuard(await this.complete(llamaGuardPrompt(text), signal));
    if (this.format === "llama-guard-chat") return parseLlamaGuard(await this.chat(llamaGuardChatMessages(text), signal));
    const answers = await Promise.all(FLOOR_POLICY.map(async (p) => [p.category, parseShieldGemma(await this.complete(shieldGemmaPrompt(text, p), signal))] as const));
    return answers.find(([, yes]) => yes)?.[0] ?? null;
  }

  private async complete(prompt: string, signal?: AbortSignal): Promise<unknown> {
    const j = await this.post("/completions", { model: this.opts.model, prompt, max_tokens: 10, temperature: 0 }, signal);
    return (j as { choices?: { text?: unknown }[] })?.choices?.[0]?.text;
  }

  private async chat(messages: { role: string; content: string }[], signal?: AbortSignal): Promise<unknown> {
    const j = await this.post("/chat/completions", { model: this.opts.model, messages, max_tokens: 10, temperature: 0 }, signal);
    return (j as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(this.base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((e: unknown) => {
      // Never forward the underlying message: some runtimes include the request body in network errors.
      throw new FloorUnavailableError(e instanceof Error && e.name === "TimeoutError" ? "floor guard timed out" : "floor guard unreachable");
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new FloorUnavailableError(`floor guard answered HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new FloorParseError("not JSON");
    }
  }
}

/** Overlapping windows, so a phrase split at a boundary is still seen whole by one call. */
export function chunk(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  const step = size - overlap;
  for (let start = 0; start < text.length; start += step) {
    out.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return out;
}

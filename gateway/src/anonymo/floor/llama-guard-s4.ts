// A second, independent floor check for the worst category: Meta's Llama Guard 4 with its own built-in taxonomy, read
// for S4 (Child Sexual Exploitation) only. No custom policy is sent, so this is Meta's classifier as published, not one
// of ours. Every other code it gives (S12 "Sexual Content" for adult material, and the rest) is ignored, so adult
// content is never blocked by it. It runs beside the guard on every prompt and every reply (gate.ts); a block from
// either one blocks.
//
// Measured on PPQ before it was added: S4 on all three short requests involving a 13- and 14-year-old and a
// seventh-grader; S12 (ignored) on an adult erotic request; none of the 101 in-repo adult-legal prompts flagged S4;
// 101 checks at 8 at a time in about 6 s and a burst of 30 paragraphs with no rate limit.
//
// It fails closed like the guard: a timeout, an HTTP error or an answer that is not "safe" / "unsafe\nS<n>,..." throws,
// and chat answers 503. A passing failure (network, timeout, 408/429/5xx, an unreadable answer) is retried once. Long
// text is checked in overlapping chunks, with verdicts kept per chunk (VerdictCache: an HMAC, never the text).
//
// Configuration (env): ANONYMO_FLOOR_LLAMAGUARD_URL and _KEY turn it on (PPQ: https://api.ppq.ai/v1);
// ANONYMO_FLOOR_LLAMAGUARD_MODEL defaults to meta-llama/llama-guard-4-12b.

import type { FloorCategory } from "../seams.ts";
import type { FloorClassifier } from "./gate.ts";
import { chunk, FloorUnavailableError, GUARD_RETRY_DELAY_MS, GUARD_RETRY_MAX_WAIT_MS, VerdictCache } from "./guard-client.ts";
import { FloorParseError } from "./policy.ts";
import { log } from "../../lib/util.ts";

export type LlamaGuardS4Options = {
  url: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  chunkChars?: number;
  maxChunks?: number;
  concurrency?: number;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
};

/** Meta's built-in verdict: "safe", or "unsafe" and a line of S-codes. True when S4 is among them. */
export function parseLlamaGuardS4(output: unknown): boolean {
  if (typeof output !== "string") throw new FloorParseError("not a string");
  const m = /^(safe|unsafe)\s*(?:\n\s*(S\d{1,2}(?:\s*,\s*S\d{1,2})*))?\s*$/.exec(output.trim());
  if (!m) throw new FloorParseError("shape");
  if (m[1] === "safe") {
    if (m[2]) throw new FloorParseError("safe with categories");
    return false;
  }
  if (!m[2]) throw new FloorParseError("unsafe without category");
  return m[2].split(",").map((c) => c.trim()).includes("S4");
}

export class LlamaGuardS4Classifier implements FloorClassifier {
  private readonly base: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: VerdictCache | null;

  constructor(private readonly opts: LlamaGuardS4Options) {
    this.base = opts.url.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(this.base)) throw new Error("ANONYMO_FLOOR_LLAMAGUARD_URL must be an http(s) URL");
    this.model = opts.model ?? "meta-llama/llama-guard-4-12b";
    this.fetchImpl = opts.fetch ?? fetch;
    const ttl = opts.cacheTtlMs ?? 3_600_000;
    this.cache = ttl > 0 ? new VerdictCache(`llama-guard-s4\n${this.model}`, ttl) : null;
  }

  async classify(text: string, signal?: AbortSignal): Promise<FloorCategory | null> {
    const chunks = chunk(text, this.opts.chunkChars ?? 8000, 400);
    if (chunks.length > (this.opts.maxChunks ?? 32)) throw new FloorUnavailableError("input too long for the Llama Guard check");
    let flagged = false;
    const todo: string[] = [];
    for (const c of chunks) {
      const v = this.cache?.get(c);
      if (v === undefined) todo.push(c);
      else if (v === "minor") flagged = true;
    }
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const c = todo[next++];
        const hit = await this.askOne(c, signal);
        this.cache?.set(c, hit ? "minor" : null);
        if (hit) flagged = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? 4, todo.length) }, worker));
    return flagged ? "minor" : null;
  }

  /** One chunk, retried once on a passing failure. */
  private async askOne(text: string, signal?: AbortSignal): Promise<boolean> {
    try {
      return parseLlamaGuardS4(await this.post(text, signal));
    } catch (e) {
      const passing = (e instanceof FloorUnavailableError && e.retryable) || e instanceof FloorParseError;
      if (!passing || signal?.aborted) throw e;
      log.warn("Llama Guard check failed, retrying once", { reason: (e as Error).message });
      const after = e instanceof FloorUnavailableError ? e.retryAfterMs : undefined;
      await new Promise((r) => setTimeout(r, after !== undefined ? Math.min(Math.max(after, GUARD_RETRY_DELAY_MS), GUARD_RETRY_MAX_WAIT_MS) : GUARD_RETRY_DELAY_MS));
      return parseLlamaGuardS4(await this.post(text, signal));
    }
  }

  private async post(text: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 5000);
    const res = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      // The text as the user turn and nothing else: Llama Guard applies Meta's own template and taxonomy.
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: text }], max_tokens: 20, temperature: 0 }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((e: unknown) => {
      // Never forward the underlying message: some runtimes include the request body in network errors.
      throw new FloorUnavailableError(e instanceof Error && e.name === "TimeoutError" ? "Llama Guard check timed out" : "Llama Guard check unreachable", !signal?.aborted);
    });
    if (!res.ok) {
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => undefined);
      throw new FloorUnavailableError(`Llama Guard check answered HTTP ${res.status}`, res.status === 408 || res.status === 429 || res.status >= 500, Number.isFinite(after) && after > 0 ? after * 1000 : undefined);
    }
    try {
      return ((await res.json()) as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    } catch {
      throw new FloorParseError("not JSON");
    }
  }
}

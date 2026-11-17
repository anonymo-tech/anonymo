// Client for a guard model (Llama Guard 3-1B / ShieldGemma-2B class) served behind an OpenAI-compatible endpoint,
// self-hosted or on a TEE route. Every failure (timeout, HTTP error, bad JSON, unparseable verdict) throws, and the
// gate turns a throw into a closed failure: the request is never served unchecked.
//
// Long inputs are checked in overlapping chunks so nothing is skipped; past `maxChunks` the client refuses to answer
// (fails closed) rather than checking only part of the text.
//
// Chunks start at fixed offsets, so when a conversation grows only its last chunk changes. Verdicts are kept per chunk
// (VerdictCache) and the earlier chunks are not sent again. The cache holds a keyed hash of each chunk, never its text,
// in memory only, under a random key made at start-up.
//
// A failure that may be passing (network error, timeout, HTTP 408/429/5xx, an unparseable verdict) is retried once
// after a short pause (on a 429, after the wait the server asks for, up to GUARD_RETRY_MAX_WAIT_MS: PayPerQ's hosted
// gpt-oss-safeguard is rate-limited upstream and asks for about a second); if the retry fails too, the error propagates and the gate fails closed as before. Auth and other
// 4xx errors are not retried.

import { createHmac, randomBytes } from "node:crypto";
import type { FloorCategory } from "../seams.ts";
import { log } from "../../lib/util.ts";
import { FLOOR_POLICY, FloorParseError, llamaGuardChatMessages, llamaGuardPrompt, parseLlamaGuard, parseSafeguard, parseShieldGemma, safeguardMessages, shieldGemmaPrompt } from "./policy.ts";

/** llama-guard (raw /completions), llama-guard-chat, shieldgemma (self-hosted small guards), or safeguard
 *  (gpt-oss-safeguard on a hosted OpenAI-compatible API, for example PayPerQ's openai/gpt-oss-safeguard-20b). */
export type GuardFormat = "llama-guard" | "llama-guard-chat" | "shieldgemma" | "safeguard";

/** Per-call timeout when none is configured: small self-hosted guards answer in well under a second; a hosted reasoning
 *  guard needs longer. */
export const DEFAULT_TIMEOUT_MS: Readonly<Record<GuardFormat, number>> = { "llama-guard": 1500, "llama-guard-chat": 1500, shieldgemma: 1500, safeguard: 8000 };

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
  /** How long a chunk's verdict is reused, in ms. 0 turns the cache off. Default one hour. */
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  /** Retry a passing failure once (default). Off for a primary guard that has a fallback: failing over is faster. */
  retry?: boolean;
  fetch?: typeof fetch;
};

/** Pause before the one retry of a failed guard call, and the most a 429's requested wait is honoured. */
export const GUARD_RETRY_DELAY_MS = 200;
export const GUARD_RETRY_MAX_WAIT_MS = 2000;

export class FloorUnavailableError extends Error {
  /** retryable: the same call may well succeed if sent again (network, timeout, 408/429/5xx). retryAfterMs: the wait a
   *  429 asked for, when it said. */
  constructor(
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** The wait a 429 asks for: the Retry-After header (seconds), or retry_after_seconds in an OpenRouter-style error body
 *  (PayPerQ sends only the body). Only that number is read from the body. */
async function retryAfterMsOf(res: Response): Promise<number | undefined> {
  const raw = res.headers.get("retry-after")?.trim();
  const header = raw ? Number(raw) : NaN;
  if (Number.isFinite(header) && header >= 0) return header * 1000;
  const j = (await res.json().catch(() => null)) as { error?: { metadata?: { retry_after_seconds?: unknown } } } | null;
  const s = j?.error?.metadata?.retry_after_seconds;
  return typeof s === "number" && Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
}

const retryable = (e: unknown) => (e instanceof FloorUnavailableError && e.retryable) || e instanceof FloorParseError;

/** A loggable reason for a floor failure. Guard errors carry fixed messages (never prompt or model text); for anything
 *  else only the error's class name is given. */
export const floorErrorReason = (e: unknown) =>
  e instanceof FloorUnavailableError || e instanceof FloorParseError ? e.message : e instanceof Error ? e.name : "unknown";

export class GuardModelClient {
  readonly format: GuardFormat;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly chunkChars: number;
  private readonly overlapChars: number;
  private readonly maxChunks: number;
  private readonly concurrency: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: VerdictCache | null;

  constructor(private readonly opts: GuardClientOptions) {
    if (!/^https?:\/\//.test(opts.url)) throw new Error("ANONYMO_FLOOR_URL must be an http(s) URL");
    if (!opts.model) throw new Error("ANONYMO_FLOOR_MODEL is required with ANONYMO_FLOOR_URL");
    this.base = opts.url.replace(/\/+$/, "");
    this.format = opts.format ?? "llama-guard";
    if (!(this.format in DEFAULT_TIMEOUT_MS)) throw new Error(`unknown guard format ${this.format}`);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS[this.format];
    this.chunkChars = opts.chunkChars ?? 8000;
    this.overlapChars = Math.min(opts.overlapChars ?? 400, Math.floor(this.chunkChars / 4));
    this.maxChunks = opts.maxChunks ?? 32;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.fetchImpl = opts.fetch ?? fetch;
    const ttl = opts.cacheTtlMs ?? 3_600_000;
    this.cache = ttl > 0 ? new VerdictCache(`${this.format}\n${opts.model}`, ttl, opts.cacheMaxEntries) : null;
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
        const hit = this.cache?.get(chunks[i]);
        if (hit !== undefined) found[i] = hit;
        else {
          found[i] = await this.classifyOne(chunks[i], signal);
          this.cache?.set(chunks[i], found[i]);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, chunks.length) }, worker));
    for (const p of FLOOR_POLICY) if (found.includes(p.category)) return p.category;
    return null;
  }

  /** One chunk's verdict, retried once on a failure that may be passing. */
  private async classifyOne(text: string, signal?: AbortSignal): Promise<FloorCategory | null> {
    try {
      return await this.ask(text, signal);
    } catch (e) {
      if (this.opts.retry === false || !retryable(e) || signal?.aborted) throw e;
      log.warn("floor guard call failed, retrying once", { reason: floorErrorReason(e) });
      const wait = e instanceof FloorUnavailableError && e.retryAfterMs !== undefined ? Math.min(Math.max(e.retryAfterMs, GUARD_RETRY_DELAY_MS), GUARD_RETRY_MAX_WAIT_MS) : GUARD_RETRY_DELAY_MS;
      await new Promise((r) => setTimeout(r, wait));
      if (signal?.aborted) throw e;
      return await this.ask(text, signal);
    }
  }

  private async ask(text: string, signal?: AbortSignal): Promise<FloorCategory | null> {
    if (this.format === "llama-guard") return parseLlamaGuard(await this.complete(llamaGuardPrompt(text), signal));
    if (this.format === "llama-guard-chat") return parseLlamaGuard(await this.chat(llamaGuardChatMessages(text), signal));
    // The guide says not to cap a reasoning guard tightly; low effort keeps it short. reasoning_effort is also stated in
    // the policy text, for servers that drop the parameter.
    if (this.format === "safeguard") return parseSafeguard(await this.chat(safeguardMessages(text), signal, { max_tokens: 2048, reasoning_effort: "low" }));
    const answers = await Promise.all(FLOOR_POLICY.map(async (p) => [p.category, parseShieldGemma(await this.complete(shieldGemmaPrompt(text, p), signal))] as const));
    return answers.find(([, yes]) => yes)?.[0] ?? null;
  }

  private async complete(prompt: string, signal?: AbortSignal): Promise<unknown> {
    const j = await this.post("/completions", { model: this.opts.model, prompt, max_tokens: 10, temperature: 0 }, signal);
    return (j as { choices?: { text?: unknown }[] })?.choices?.[0]?.text;
  }

  private async chat(messages: { role: string; content: string }[], signal?: AbortSignal, extra: Record<string, unknown> = {}): Promise<unknown> {
    const j = await this.post("/chat/completions", { model: this.opts.model, messages, max_tokens: 10, temperature: 0, ...extra }, signal);
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
      throw new FloorUnavailableError(e instanceof Error && e.name === "TimeoutError" ? "floor guard timed out" : "floor guard unreachable", !signal?.aborted);
    });
    if (res.status === 429) throw new FloorUnavailableError("floor guard answered HTTP 429", true, await retryAfterMsOf(res));
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new FloorUnavailableError(`floor guard answered HTTP ${res.status}`, res.status === 408 || res.status === 429 || res.status >= 500);
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

/** Verdicts per chunk, keyed by an HMAC of the chunk under a random per-process key (never the text). Oldest first out. */
export class VerdictCache {
  private readonly key = randomBytes(32);
  private readonly map = new Map<string, { verdict: FloorCategory | null; until: number }>();
  constructor(
    private readonly scope: string,
    private readonly ttlMs: number,
    private readonly maxEntries = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  private id(text: string) {
    return createHmac("sha256", this.key).update(this.scope).update("\0").update(text).digest("base64url");
  }

  /** The cached verdict (null is "safe"), or undefined when there is none. */
  get(text: string): FloorCategory | null | undefined {
    const id = this.id(text);
    const e = this.map.get(id);
    if (!e) return undefined;
    if (e.until <= this.now()) {
      this.map.delete(id);
      return undefined;
    }
    return e.verdict;
  }

  set(text: string, verdict: FloorCategory | null) {
    const id = this.id(text);
    this.map.delete(id);
    this.map.set(id, { verdict, until: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  get size() {
    return this.map.size;
  }
}

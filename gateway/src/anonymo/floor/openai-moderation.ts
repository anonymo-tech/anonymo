// A second, independent floor check for the worst category: OpenAI's moderation endpoint (omni-moderation-latest), a
// widely used classifier with a dedicated sexual/minors category. It runs beside the guard model on every prompt and
// every reply (gate.ts), and a block from either one blocks. It reads only sexual/minors, with OpenAI's own threshold
// (the `categories` flag), so adult content it calls "sexual" is never blocked by it.
//
// Measured before it was added: none of the 101 in-repo adult-legal prompts flagged (highest score 0.10, a puberty
// question), while short requests involving a 13- and 14-year-old and a seventh-grader were flagged (0.77 to 0.91).
//
// Like the guard it fails closed: a timeout, an HTTP error or a reply without the category throws, and chat answers 503.
// A passing failure (network, timeout, 408/429/5xx) is retried once. Long text is sent in overlapping chunks, and
// verdicts are kept per chunk (VerdictCache, keyed by an HMAC, never the text), so a growing reply resends only its
// newest chunk.
//
// Configuration (env): ANONYMO_FLOOR_OPENAI_KEY turns it on; ANONYMO_FLOOR_OPENAI_URL (default
// https://api.openai.com/v1), ANONYMO_FLOOR_OPENAI_MODEL (default omni-moderation-latest).

import type { FloorCategory } from "../seams.ts";
import type { FloorClassifier } from "./gate.ts";
import { chunk, FloorUnavailableError, GUARD_RETRY_DELAY_MS, GUARD_RETRY_MAX_WAIT_MS, VerdictCache } from "./guard-client.ts";
import { log } from "../../lib/util.ts";

export type OpenAIModerationOptions = {
  apiKey: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  chunkChars?: number;
  maxChunks?: number;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
};

const CATEGORY = "sexual/minors";

export class OpenAIModerationClassifier implements FloorClassifier {
  private readonly base: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: VerdictCache | null;

  constructor(private readonly opts: OpenAIModerationOptions) {
    if (!opts.apiKey) throw new Error("ANONYMO_FLOOR_OPENAI_KEY is empty");
    this.base = (opts.url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(this.base)) throw new Error("ANONYMO_FLOOR_OPENAI_URL must be an http(s) URL");
    this.model = opts.model ?? "omni-moderation-latest";
    this.fetchImpl = opts.fetch ?? fetch;
    const ttl = opts.cacheTtlMs ?? 3_600_000;
    this.cache = ttl > 0 ? new VerdictCache(`openai-moderation\n${this.model}`, ttl) : null;
  }

  async classify(text: string, signal?: AbortSignal): Promise<FloorCategory | null> {
    const chunks = chunk(text, this.opts.chunkChars ?? 8000, 400);
    if (chunks.length > (this.opts.maxChunks ?? 32)) throw new FloorUnavailableError("input too long for the moderation check");
    let flagged = false;
    const todo: string[] = [];
    for (const c of chunks) {
      const v = this.cache?.get(c);
      if (v === undefined) todo.push(c);
      else if (v === "minor") flagged = true;
    }
    if (todo.length) {
      const flags = await this.ask(todo, signal);
      todo.forEach((c, i) => this.cache?.set(c, flags[i] ? "minor" : null));
      if (flags.some(Boolean)) flagged = true;
    }
    return flagged ? "minor" : null;
  }

  /** One flag per input, retried once on a passing failure. */
  private async ask(inputs: string[], signal?: AbortSignal): Promise<boolean[]> {
    try {
      return await this.post(inputs, signal);
    } catch (e) {
      if (!(e instanceof FloorUnavailableError && e.retryable) || signal?.aborted) throw e;
      log.warn("moderation check failed, retrying once", { reason: e.message });
      const wait = e.retryAfterMs !== undefined ? Math.min(Math.max(e.retryAfterMs, GUARD_RETRY_DELAY_MS), GUARD_RETRY_MAX_WAIT_MS) : GUARD_RETRY_DELAY_MS;
      await new Promise((r) => setTimeout(r, wait));
      return await this.post(inputs, signal);
    }
  }

  private async post(inputs: string[], signal?: AbortSignal): Promise<boolean[]> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 5000);
    const res = await this.fetchImpl(`${this.base}/moderations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({ model: this.model, input: inputs }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((e: unknown) => {
      // Never forward the underlying message: some runtimes include the request body in network errors.
      throw new FloorUnavailableError(e instanceof Error && e.name === "TimeoutError" ? "moderation check timed out" : "moderation check unreachable", !signal?.aborted);
    });
    if (!res.ok) {
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => undefined);
      throw new FloorUnavailableError(`moderation check answered HTTP ${res.status}`, res.status === 408 || res.status === 429 || res.status >= 500, Number.isFinite(after) && after > 0 ? after * 1000 : undefined);
    }
    let j: { results?: { categories?: Record<string, unknown> }[] };
    try {
      j = (await res.json()) as typeof j;
    } catch {
      throw new FloorUnavailableError("moderation check answered with something that is not JSON");
    }
    const results = j.results;
    if (!Array.isArray(results) || results.length !== inputs.length) throw new FloorUnavailableError("moderation check answered with the wrong number of results");
    return results.map((r) => {
      const flag = r?.categories?.[CATEGORY];
      if (typeof flag !== "boolean") throw new FloorUnavailableError("moderation check answered without the sexual/minors category");
      return flag;
    });
  }
}

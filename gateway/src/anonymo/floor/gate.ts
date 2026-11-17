// The real FloorGate (WS02): a deterministic pre-filter, then the guard model. A block records an encrypted minimal
// hit (hits.ts) and returns the category; chat.ts answers 451 and never reroutes. Any error from the guard model
// propagates, and chat.ts answers 503 floor_unavailable: the gate fails closed.
//
// Configuration (env):
//   ANONYMO_FLOOR_URL          OpenAI-compatible base URL of the guard model. Selects this gate.
//   ANONYMO_FLOOR_MODEL        model name on that server (required with the URL)
//   ANONYMO_FLOOR_KEY          bearer key for that server (optional)
//   ANONYMO_FLOOR_FORMAT       llama-guard (default, raw /completions) | llama-guard-chat | shieldgemma | safeguard
//                              (gpt-oss-safeguard on a hosted API, for example https://api.ppq.ai/v1 with
//                              openai/gpt-oss-safeguard-20b and the PPQ API key)
//   ANONYMO_FLOOR_TIMEOUT_MS   per call, default 1500 (safeguard: 8000)
//   ANONYMO_FLOOR_CACHE_MINUTES how long a chunk's verdict is reused, default 60; 0 turns it off
//   ANONYMO_FLOOR_CHUNK_CHARS  default 8000; ANONYMO_FLOOR_MAX_CHUNKS default 32 (longer input fails closed)
//   ANONYMO_FLOOR_HIT_TTL_HOURS how long an unreported hit stays in memory, default 72
//   ANONYMO_FLOOR_EXTRA_BODY   optional JSON object added to every guard request, e.g. a provider pin on a router:
//                              {"provider":{"only":["groq"],"allow_fallbacks":false}} on NanoGPT
//   ANONYMO_FLOOR_FALLBACK_URL, _MODEL, _KEY, _FORMAT, _EXTRA_BODY (format defaults to the primary's)
//                              a second guard asked only when the first one errors (rate limit, outage, bad verdict).
//                              A verdict from the first guard is final: a fallback can never turn a block into a pass.
//                              With a fallback the first guard does not retry; the fallback retries once.
//   ANONYMO_FLOOR_LLAMAGUARD_URL, _KEY, _MODEL
//                              a second, independent check for the worst category: Meta's Llama Guard 4 with its own
//                              taxonomy, S4 (Child Sexual Exploitation) only (llama-guard-s4.ts). It runs beside the
//                              guard; a block from either blocks. PPQ serves it (https://api.ppq.ai/v1).
//   ANONYMO_FLOOR_OPENAI_KEY   optional, the same kind of check on OpenAI's moderation endpoint,
//                              sexual/minors only (openai-moderation.ts). It runs beside the guard; a block from
//                              either blocks. _OPENAI_URL and _OPENAI_MODEL override its defaults.
//   ANONYMO_FLOOR_REQUIRED=1   with no URL, every check fails closed (every real deployment sets this;
//                              ANONYMO_ENV=production implies it)
// With neither URL nor REQUIRED (local development), only the pre-filter runs.

import { floorGateStub, type FloorCategory, type FloorGate, type FloorInput, type FloorVerdict } from "../seams.ts";
import { floorErrorReason, GuardModelClient, type GuardFormat } from "./guard-client.ts";
import { log } from "../../lib/util.ts";
import { FloorHitLog, type FloorLayer } from "./hits.ts";
import { prefilter } from "./prefilter.ts";
import { FLOOR_POLICY } from "./policy.ts";
import { OpenAIModerationClassifier } from "./openai-moderation.ts";
import { LlamaGuardS4Classifier } from "./llama-guard-s4.ts";

export interface FloorClassifier {
  classify(text: string, signal?: AbortSignal): Promise<FloorCategory | null>;
}

export type FloorGateOptions = {
  /** The guard model. Null runs the pre-filter only. */
  classifier: FloorClassifier | null;
  /** Independent checks run beside the guard (OpenAI moderation). A block from any one blocks, even if another
   *  errored; an error with no block fails closed. */
  also?: FloorClassifier[];
  /** Skip the deterministic layer (only for measuring the model alone in the suite harness). */
  skipPrefilter?: boolean;
  hits?: FloorHitLog;
};

export class AnonymoFloorGate implements FloorGate {
  readonly hits: FloorHitLog;
  constructor(private readonly opts: FloorGateOptions) {
    this.hits = opts.hits ?? new FloorHitLog();
  }

  /** Without a guard model only the pre-filter runs, and it reads requests, not replies (floor/reply.ts). */
  get checksReplies() {
    return this.opts.classifier !== null || (this.opts.also?.length ?? 0) > 0;
  }

  async check(input: FloorInput, signal?: AbortSignal): Promise<FloorVerdict> {
    if (!input.text.trim()) return { ok: true }; // nothing to judge; uploads go through the upload rule
    // A reply is read with the pre-filter's content rules only: its request rules match requests, not what a model wrote.
    if (!this.opts.skipPrefilter) {
      const hit = prefilter(input.text, { reply: input.stage === "reply" });
      if (hit) return this.block(input, hit.category, "prefilter");
    }
    const runs: [FloorClassifier, FloorLayer][] = [...(this.opts.classifier ? [[this.opts.classifier, "model"] as [FloorClassifier, FloorLayer]] : []), ...(this.opts.also ?? []).map((c) => [c, "moderation"] as [FloorClassifier, FloorLayer])];
    if (!runs.length) return { ok: true };
    const settled = await Promise.allSettled(runs.map(([c]) => c.classify(input.text, signal)));
    for (const p of FLOOR_POLICY)
      for (const [i, s] of settled.entries()) if (s.status === "fulfilled" && s.value === p.category) return this.block(input, p.category, runs[i][1]);
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;
    return { ok: true };
  }

  private block(input: FloorInput, category: FloorCategory, layer: FloorLayer): FloorVerdict {
    this.hits.record(input, category, layer);
    return { ok: false, category };
  }
}

/** The pending floor hits behind a gate, when it keeps them (the real gate does; test doubles may not). */
export const floorHitsOf = (gate: FloorGate): FloorHitLog | null => ((gate as { hits?: unknown }).hits instanceof FloorHitLog ? (gate as AnonymoFloorGate).hits : null);

const truthy = (v: unknown) => v === true || v === "1" || v === "true";
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const int = (v: unknown, name: string): number | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
};
/** An optional JSON object setting. It may not set what the guard request itself decides. */
const RESERVED_BODY_KEYS = ["model", "messages", "prompt", "max_tokens", "temperature", "reasoning_effort", "stream"];
const jsonObject = (v: unknown, name: string): Record<string, unknown> | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${name} must be a JSON object`);
  const bad = Object.keys(o).filter((k) => RESERVED_BODY_KEYS.includes(k));
  if (bad.length) throw new Error(`${name} may not set ${bad.join(", ")}`);
  return o as Record<string, unknown>;
};
const FORMATS: GuardFormat[] = ["llama-guard", "llama-guard-chat", "shieldgemma", "safeguard"];
const minutes = (v: unknown, name: string): number | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of minutes (0 turns it off)`);
  return n * 60_000;
};

/** Build the floor gate from env. See the header of this file for the variables. */
export function createFloorGate(env: Record<string, unknown>): FloorGate {
  const url = str(env.ANONYMO_FLOOR_URL);
  // Production never runs on the pre-filter alone: without a guard model URL every check fails closed (503).
  const required = truthy(env.ANONYMO_FLOOR_REQUIRED) || str(env.ANONYMO_ENV) === "production";
  const cacheTtlMs = minutes(env.ANONYMO_FLOOR_CACHE_MINUTES, "ANONYMO_FLOOR_CACHE_MINUTES");
  const also: FloorClassifier[] = [];
  const lgUrl = str(env.ANONYMO_FLOOR_LLAMAGUARD_URL);
  if (lgUrl) also.push(new LlamaGuardS4Classifier({ url: lgUrl, apiKey: str(env.ANONYMO_FLOOR_LLAMAGUARD_KEY), model: str(env.ANONYMO_FLOOR_LLAMAGUARD_MODEL), cacheTtlMs }));
  const openaiKey = str(env.ANONYMO_FLOOR_OPENAI_KEY);
  if (openaiKey) also.push(new OpenAIModerationClassifier({ apiKey: openaiKey, url: str(env.ANONYMO_FLOOR_OPENAI_URL), model: str(env.ANONYMO_FLOOR_OPENAI_MODEL), cacheTtlMs }));
  if (!url) return required ? floorGateStub(true) : new AnonymoFloorGate({ classifier: null, also });
  const format = str(env.ANONYMO_FLOOR_FORMAT) ?? "llama-guard";
  if (!FORMATS.includes(format as GuardFormat)) throw new Error(`ANONYMO_FLOOR_FORMAT must be one of ${FORMATS.join(", ")}`);
  const ttlHours = int(env.ANONYMO_FLOOR_HIT_TTL_HOURS, "ANONYMO_FLOOR_HIT_TTL_HOURS");
  const fallbackUrl = str(env.ANONYMO_FLOOR_FALLBACK_URL);
  if (fallbackUrl && !str(env.ANONYMO_FLOOR_FALLBACK_MODEL)) throw new Error("ANONYMO_FLOOR_FALLBACK_MODEL is required with ANONYMO_FLOOR_FALLBACK_URL");
  const fallbackFormat = str(env.ANONYMO_FLOOR_FALLBACK_FORMAT) ?? format;
  if (!FORMATS.includes(fallbackFormat as GuardFormat)) throw new Error(`ANONYMO_FLOOR_FALLBACK_FORMAT must be one of ${FORMATS.join(", ")}`);
  const client = (o: { url: string; model: string; apiKey?: string; format: string; retry: boolean; extraBody?: Record<string, unknown> }) =>
    new GuardModelClient({
      ...o,
      format: o.format as GuardFormat,
      timeoutMs: int(env.ANONYMO_FLOOR_TIMEOUT_MS, "ANONYMO_FLOOR_TIMEOUT_MS"),
      chunkChars: int(env.ANONYMO_FLOOR_CHUNK_CHARS, "ANONYMO_FLOOR_CHUNK_CHARS"),
      maxChunks: int(env.ANONYMO_FLOOR_MAX_CHUNKS, "ANONYMO_FLOOR_MAX_CHUNKS"),
      cacheTtlMs: minutes(env.ANONYMO_FLOOR_CACHE_MINUTES, "ANONYMO_FLOOR_CACHE_MINUTES"),
    });
  const primary = client({ url, model: str(env.ANONYMO_FLOOR_MODEL) ?? "", apiKey: str(env.ANONYMO_FLOOR_KEY), format, retry: !fallbackUrl, extraBody: jsonObject(env.ANONYMO_FLOOR_EXTRA_BODY, "ANONYMO_FLOOR_EXTRA_BODY") });
  const classifier = fallbackUrl
    ? new FallbackClassifier(primary, client({ url: fallbackUrl, model: str(env.ANONYMO_FLOOR_FALLBACK_MODEL) ?? "", apiKey: str(env.ANONYMO_FLOOR_FALLBACK_KEY), format: fallbackFormat, retry: true, extraBody: jsonObject(env.ANONYMO_FLOOR_FALLBACK_EXTRA_BODY, "ANONYMO_FLOOR_FALLBACK_EXTRA_BODY") }))
    : primary;
  return new AnonymoFloorGate({ classifier, also, hits: ttlHours ? new FloorHitLog(ttlHours * 3_600_000) : undefined });
}

/** Asks `fallback` only when `primary` errors. Whatever verdict `primary` gives (block or pass) is final. */
export class FallbackClassifier implements FloorClassifier {
  constructor(
    private readonly primary: FloorClassifier,
    private readonly fallback: FloorClassifier,
  ) {}

  async classify(text: string, signal?: AbortSignal): Promise<FloorCategory | null> {
    try {
      return await this.primary.classify(text, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      log.warn("floor guard failed, asking the fallback guard", { reason: floorErrorReason(e) });
      return await this.fallback.classify(text, signal);
    }
  }
}

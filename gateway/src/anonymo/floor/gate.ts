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
//   ANONYMO_FLOOR_REQUIRED=1   with no URL, every check fails closed (every real deployment sets this;
//                              ANONYMO_ENV=production implies it)
// With neither URL nor REQUIRED (local development), only the pre-filter runs.

import { floorGateStub, type FloorCategory, type FloorGate, type FloorInput, type FloorVerdict } from "../seams.ts";
import { GuardModelClient, type GuardFormat } from "./guard-client.ts";
import { FloorHitLog, type FloorLayer } from "./hits.ts";
import { prefilter } from "./prefilter.ts";

export interface FloorClassifier {
  classify(text: string, signal?: AbortSignal): Promise<FloorCategory | null>;
}

export type FloorGateOptions = {
  /** The guard model. Null runs the pre-filter only. */
  classifier: FloorClassifier | null;
  /** Skip the deterministic layer (only for measuring the model alone in the suite harness). */
  skipPrefilter?: boolean;
  hits?: FloorHitLog;
};

export class AnonymoFloorGate implements FloorGate {
  readonly hits: FloorHitLog;
  constructor(private readonly opts: FloorGateOptions) {
    this.hits = opts.hits ?? new FloorHitLog();
  }

  async check(input: FloorInput, signal?: AbortSignal): Promise<FloorVerdict> {
    if (!input.text.trim()) return { ok: true }; // nothing to judge; uploads go through the upload rule
    if (!this.opts.skipPrefilter) {
      const hit = prefilter(input.text);
      if (hit) return this.block(input, hit.category, "prefilter");
    }
    if (!this.opts.classifier) return { ok: true };
    const category = await this.opts.classifier.classify(input.text, signal);
    return category ? this.block(input, category, "model") : { ok: true };
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
  if (!url) return required ? floorGateStub(true) : new AnonymoFloorGate({ classifier: null });
  const format = str(env.ANONYMO_FLOOR_FORMAT) ?? "llama-guard";
  if (!FORMATS.includes(format as GuardFormat)) throw new Error(`ANONYMO_FLOOR_FORMAT must be one of ${FORMATS.join(", ")}`);
  const ttlHours = int(env.ANONYMO_FLOOR_HIT_TTL_HOURS, "ANONYMO_FLOOR_HIT_TTL_HOURS");
  return new AnonymoFloorGate({
    classifier: new GuardModelClient({
      url,
      model: str(env.ANONYMO_FLOOR_MODEL) ?? "",
      apiKey: str(env.ANONYMO_FLOOR_KEY),
      format: format as GuardFormat,
      timeoutMs: int(env.ANONYMO_FLOOR_TIMEOUT_MS, "ANONYMO_FLOOR_TIMEOUT_MS"),
      chunkChars: int(env.ANONYMO_FLOOR_CHUNK_CHARS, "ANONYMO_FLOOR_CHUNK_CHARS"),
      maxChunks: int(env.ANONYMO_FLOOR_MAX_CHUNKS, "ANONYMO_FLOOR_MAX_CHUNKS"),
      cacheTtlMs: minutes(env.ANONYMO_FLOOR_CACHE_MINUTES, "ANONYMO_FLOOR_CACHE_MINUTES"),
    }),
    hits: ttlHours ? new FloorHitLog(ttlHours * 3_600_000) : undefined,
  });
}

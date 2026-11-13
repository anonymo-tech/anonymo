import { creditUnavailable } from "../rush/monitor.ts"; // ON3
import { rememberRouteResult } from "./explain.ts"; // V84
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { callUpstream, type ErrorKind, upstreamBody, type UpstreamFailure } from "../providers/upstream.ts";
import type { HealthTracker } from "../services/health.ts";
import type { AciExchange } from "../providers/aci.ts";
import type { RefusalClassifier } from "../anonymo/seams.ts";

// Try providers in order, falling back on 5xx / timeout / connection / 429 / provider-auth /
// provider-side rejections / empty-200s. For streams, events are buffered until the first
// meaningful delta so that an empty or broken stream can still fall back invisibly.

/** `refused`: the call answered, but the refusal catch judged the answer a refusal (Anonymo WS03). */
export type Attempt = { provider: string; model: string; ok: boolean; error_kind?: ErrorKind; status?: number; latency_ms: number; message?: string; refused?: boolean };

/**
 * Anonymo refusal catch (spec: Backend §5). Only ever passed after the floor gate let the prompt through.
 * The first ~160 tokens of the reply (at most 1.2 s after its first token) are held back and read by the
 * classifier. A refusal is cancelled and retried once on a route whose model family differs; that answer is read
 * once more. Every refused attempt is billed 0 by the caller (api/chat.ts).
 */
export type RefusalCatch = {
  classifier: RefusalClassifier;
  /** What the caller asked, for the classifier only. Never stored. */
  prompt: string;
  familyOf: (model: ModelRow, c: Candidate) => string;
  /** Characters of reply to hold back; about 4 per token. Default 640 (≈ 160 tokens). */
  headChars?: number;
  /** Longest wait for the head after the first token, in ms. Default 1200. */
  headMs?: number;
};
export type RefusedAttempt = { candidate: Candidate; model: ModelRow; family: string; usage: unknown; outChars: number; stream: boolean };
export type RefusalOutcome = {
  /** Routes whose reply the classifier read, in order, for the per-route counts. */
  checked: { candidate: Candidate; model: ModelRow; refused: boolean }[];
  /** Attempts judged a refusal, in order (the served one last when `served` is "refused"). */
  refused: RefusedAttempt[];
  /** "refused": the answer returned is itself a refusal (the retry refused too, or nothing else could answer). */
  served: "answer" | "refused";
  /** The retry on another family refused as well. */
  double: boolean;
};
export const REFUSAL_HEAD_CHARS = 640;
export const REFUSAL_HEAD_MS = 1200;

export type RouteTarget = { model: ModelRow; ordered: Candidate[] };

/** `exchange` is set when the candidate is an attested aci/1 gateway (providers/aci.ts). */
export type RouteSuccess =
  | { ok: true; kind: "json"; candidate: Candidate; model: ModelRow; json: any; latencyMs: number; attempts: Attempt[]; dropped: string[]; exchange?: AciExchange; refusal?: RefusalOutcome }
  | {
      ok: true;
      kind: "stream";
      candidate: Candidate;
      model: ModelRow;
      buffered: any[];
      rest: AsyncGenerator<any>;
      latencyMs: number;
      attempts: Attempt[];
      abort: () => void;
      dropped: string[];
      exchange?: AciExchange;
      refusal?: RefusalOutcome;
    };
export type RouteFailure = { ok: false; attempts: Attempt[]; last?: UpstreamFailure };

/** Empty-200: content in {null, ""} with no tool calls, and finish_reason not length/content_filter. */
export function isEmptyCompletion(json: any, stopRequested = false): boolean {
  const choices = json?.choices;
  if (!Array.isArray(choices) || !choices.length) return true;
  return choices.every((ch: any) => {
    const msg = ch?.message ?? {};
    const text = ch?.text; // legacy completions
    const hasContent = (typeof msg.content === "string" && msg.content.length > 0) || (Array.isArray(msg.content) && msg.content.length > 0) || (typeof text === "string" && text.length > 0);
    const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
    const finish = ch?.finish_reason;
    // An empty answer that ended on a caller-supplied stop sequence is a legitimate answer.
    if (stopRequested && finish === "stop") return false;
    return !hasContent && !hasTools && !hasImages && finish !== "length" && finish !== "content_filter";
  });
}

export function meaningfulDelta(ev: any): boolean {
  if (ev?.error) return false;
  for (const ch of ev?.choices ?? []) {
    const d = ch?.delta ?? {};
    if (typeof d.content === "string" && d.content.length) return true;
    if (typeof ch?.text === "string" && ch.text.length) return true;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) return true;
    if ((typeof d.reasoning === "string" && d.reasoning.length) || (typeof d.reasoning_content === "string" && d.reasoning_content.length)) return true;
    if (Array.isArray(d.images) && d.images.length) return true;
    if (ch?.finish_reason === "length" || ch?.finish_reason === "content_filter") return true;
  }
  return false;
}

/** The text of a JSON completion (chat or legacy completions). */
export function completionText(json: any): string {
  return (json?.choices ?? []).map((ch: any) => (typeof ch?.message?.content === "string" ? ch.message.content : typeof ch?.text === "string" ? ch.text : "")).join("");
}

/** The answer text a stream event adds (not reasoning, not tool calls). */
export function deltaText(ev: any): string {
  let t = "";
  for (const ch of ev?.choices ?? []) {
    if (typeof ch?.delta?.content === "string") t += ch.delta.content;
    if (typeof ch?.text === "string") t += ch.text;
  }
  return t;
}

/**
 * Refusal catch: keep buffering a stream that already produced its first meaningful delta until `chars` of answer
 * text arrived, the stream ended, or `ms` passed. Returns the stream to continue from: a read still in flight at
 * the deadline, an error event or a failure is handed on to it, so nothing is lost or reordered.
 */
export async function extendHead(buffered: any[], events: AsyncGenerator<any>, chars: number, ms: number): Promise<AsyncGenerator<any>> {
  let text = buffered.map(deltaText).join("");
  const deadline = performance.now() + ms;
  let pending: Promise<IteratorResult<any>> | null = null;
  let held: IteratorResult<any> | null = null;
  let failure: { e: unknown } | null = null;
  while (text.length < chars) {
    const left = deadline - performance.now();
    if (left <= 0) break;
    pending ??= events.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = await Promise.race([
      pending.then((r) => ({ r }), (e: unknown) => ({ e })),
      new Promise<null>((res) => (timer = setTimeout(() => res(null), left))),
    ]);
    clearTimeout(timer);
    if (tick === null) break; // the read stays in flight and is handed on
    pending = null;
    if ("e" in tick) {
      failure = { e: tick.e };
      break;
    }
    if (tick.r.done || tick.r.value?.error) {
      held = tick.r; // an error event goes on to the relay, which reports it as it does any mid-stream error
      break;
    }
    buffered.push(tick.r.value);
    text += deltaText(tick.r.value);
  }
  if (!pending && !held && !failure) return events;
  return (async function* () {
    try {
      if (failure) throw failure.e;
      const first = pending ? await pending : held!;
      if (first.done) return;
      yield first.value;
      yield* events;
    } finally {
      void events.return(undefined).catch(() => undefined);
    }
  })();
}

const emptyStream = async function* (): AsyncGenerator<any> {};

export async function route(opts: {
  targets: RouteTarget[];
  path: "/chat/completions" | "/completions";
  body: Record<string, unknown>;
  stream: boolean;
  appSecret?: string;
  keyFor: (c: Candidate) => string | undefined;
  signal: AbortSignal;
  health: HealthTracker;
  maxAttempts: number;
  timeoutMs: number;
  firstTokenTimeoutMs: number;
  production: boolean;
  caller?: string | null;
  /** Anonymo refusal catch; absent = off. */
  refusal?: RefusalCatch;
}): Promise<RouteSuccess | RouteFailure> {
  const stopRequested = opts.body.stop != null && !(Array.isArray(opts.body.stop) && opts.body.stop.length === 0);
  const attempts: Attempt[] = [];
  let last: UpstreamFailure | undefined;
  // Refusal catch state: "first" reads the first answer; "retry" serves only routes of another family and reads that
  // answer once more; "done" passes answers through unread.
  const rc = opts.refusal;
  let phase: "first" | "retry" | "done" = rc ? "first" : "done";
  const outcome: RefusalOutcome = { checked: [], refused: [], served: "answer", double: false };
  const refusedFamilies = new Set<string>();
  // The refused first answer, served (billed 0) if no route of another family answers.
  let firstRefused: { result: RouteSuccess; upstream: object } | null = null;
  const familyOk = (t: RouteTarget, c: Candidate) => phase !== "retry" || !refusedFamilies.has(rc!.familyOf(t.model, c));
  const finish = (s: RouteSuccess, upstream: object): RouteSuccess => {
    const withRefusal = rc && outcome.checked.length ? { ...s, refusal: outcome } : s;
    return rememberRouteResult<RouteSuccess>(withRefusal, opts.targets);
  };
  // Reads the head of an answer. Returns the result to serve, or null to retry on another family.
  const check = async (s: RouteSuccess, target: RouteTarget, upstream: object, untried: () => boolean): Promise<RouteSuccess | null> => {
    if (!rc || phase === "done") return s;
    let head: string;
    if (s.kind === "json") head = completionText(s.json);
    else {
      s.rest = await extendHead(s.buffered, s.rest, rc.headChars ?? REFUSAL_HEAD_CHARS, rc.headMs ?? REFUSAL_HEAD_MS);
      head = s.buffered.map(deltaText).join("");
    }
    head = head.slice(0, rc.headChars ?? REFUSAL_HEAD_CHARS);
    let refused = false;
    try {
      refused = await rc.classifier.isRefusal(rc.prompt, head);
    } catch {
      refused = false; // a classifier that cannot answer lets the answer through (fails open)
    }
    outcome.checked.push({ candidate: s.candidate, model: s.model, refused });
    if (!refused) {
      phase = "done";
      return s;
    }
    const family = rc.familyOf(target.model, s.candidate);
    const a = s.attempts[s.attempts.length - 1];
    if (a) a.refused = true;
    outcome.refused.push({
      candidate: s.candidate,
      model: s.model,
      family,
      usage: s.kind === "json" ? (s.json?.usage ?? null) : null,
      outChars: s.kind === "json" ? JSON.stringify(s.json?.choices ?? []).length : s.buffered.map(deltaText).join("").length,
      stream: s.kind === "stream",
    });
    if (phase === "retry") {
      outcome.served = "refused";
      outcome.double = true;
      phase = "done";
      return s;
    }
    refusedFamilies.add(family);
    phase = "retry";
    if (!untried()) {
      // Nothing of another family to try: serve this answer as it is, billed 0.
      outcome.served = "refused";
      phase = "done";
      return s;
    }
    if (s.kind === "stream") {
      s.abort();
      firstRefused = { result: { ...s, rest: emptyStream() }, upstream };
    } else firstRefused = { result: s, upstream };
    return null;
  };
  // Retry pass: providers that failed with a response proving they never accepted the request
  // (429 / 5xx) get one more try after a short backoff. Timeouts and interrupted streams are never
  // retried — the provider may have done (and billed) the work.
  const retryable = new Set<ErrorKind>(["rate_limited", "http_5xx", "connection"]);
  const passes: RouteTarget[][] = [opts.targets];
  const tried = new Set<Candidate>();
  for (let pass = 0; pass < passes.length; pass++) {
    if (pass === 1) await new Promise((r) => setTimeout(r, 250));
  for (const target of passes[pass]) {
    for (const c of target.ordered) {
      if (creditUnavailable(opts.health, c.providerId)) continue; // ON3: also skip precomputed fallback targets.
      if (!familyOk(target, c)) continue; // refusal catch: the retry goes to another family
      if (attempts.length >= opts.maxAttempts) break;
      tried.add(c);
      const untried = () => attempts.length < opts.maxAttempts && opts.targets.some((t) => t.ordered.some((x) => !tried.has(x) && familyOk(t, x) && !creditUnavailable(opts.health, x.providerId)));
      const { body, dropped } = upstreamBody(c, opts.body, opts.stream);
      const r = await callUpstream({ health: opts.health, // ON3
        candidate: c,
        path: opts.path,
        body,
        stream: opts.stream,
        apiKey: opts.keyFor(c),
        appSecret: opts.appSecret,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        firstTokenTimeoutMs: opts.firstTokenTimeoutMs,
        production: opts.production,
      });
      const failed = (f: UpstreamFailure) => {
        last = f;
        attempts.push({ provider: c.providerId, model: target.model.id, ok: false, error_kind: f.errorKind, status: f.status, latency_ms: Math.round(f.latencyMs), message: f.message });
        opts.health.record({ modelId: c.modelId, providerId: c.providerId, ok: false, errorKind: f.errorKind, statusCode: f.status ?? null, latencyMs: f.latencyMs, empty200: f.errorKind === "empty200", source: "traffic", caller: opts.caller ?? null });
      };
      if (!r.ok) {
        failed(r);
        continue;
      }
      if (r.kind === "json") {
        if (r.json?.error && !r.json?.choices) {
          failed({ ok: false, errorKind: "http_5xx", status: r.status, message: String(r.json.error?.message ?? "provider error"), latencyMs: r.latencyMs });
          continue;
        }
        if (isEmptyCompletion(r.json, stopRequested)) {
          failed({ ok: false, errorKind: "empty200", status: 200, message: "Provider returned HTTP 200 with empty content.", latencyMs: r.latencyMs });
          continue;
        }
        attempts.push({ provider: c.providerId, model: target.model.id, ok: true, status: r.status, latency_ms: Math.round(r.latencyMs) });
        const served = await check({ ok: true, kind: "json", candidate: c, model: target.model, json: r.json, latencyMs: r.latencyMs, attempts, dropped, ...(r.exchange ? { exchange: r.exchange } : {}) }, target, r, untried);
        if (served) return finish(served, r);
        continue;
      }
      // Stream: buffer until something meaningful arrives.
      const buffered: any[] = [r.first];
      let meaningful = meaningfulDelta(r.first);
      let streamError: UpstreamFailure | null = r.first?.error
        ? { ok: false, errorKind: "http_5xx", status: 200, message: String(r.first.error?.message ?? "stream error"), latencyMs: r.latencyMs }
        : null;
      const started = performance.now();
      while (!meaningful && !streamError) {
        let next: IteratorResult<any>;
        try {
          next = await r.events.next();
        } catch (e) {
          if (opts.signal.aborted) throw e;
          streamError = { ok: false, errorKind: (e as { errorKind?: ErrorKind }).errorKind ?? "interrupted", message: "Provider stream failed before content.", latencyMs: r.latencyMs + (performance.now() - started) };
          break;
        }
        if (next.done) break;
        if (next.value?.error) {
          streamError = { ok: false, errorKind: "http_5xx", status: 200, message: String(next.value.error?.message ?? "stream error"), latencyMs: r.latencyMs };
          break;
        }
        buffered.push(next.value);
        meaningful = meaningfulDelta(next.value);
      }
      if (!meaningful && stopRequested && buffered.some((ev) => ev?.choices?.some((ch: any) => ch?.finish_reason === "stop"))) meaningful = true;
      if (!meaningful) {
        r.abort();
        failed(streamError ?? { ok: false, errorKind: "empty200", status: 200, message: "Provider stream completed with empty content.", latencyMs: r.latencyMs + (performance.now() - started) });
        continue;
      }
      const ttft = r.latencyMs + (performance.now() - started);
      attempts.push({ provider: c.providerId, model: target.model.id, ok: true, status: r.status, latency_ms: Math.round(ttft) });
      const served = await check({ ok: true, kind: "stream", candidate: c, model: target.model, buffered, rest: r.events, latencyMs: ttft, attempts, abort: r.abort, dropped, ...(r.exchange ? { exchange: r.exchange } : {}) }, target, r, untried);
      if (served) return finish(served, r);
    }
  }
    if (pass === 0 && attempts.length < opts.maxAttempts) {
      const again = opts.targets
        .map((t) => ({ model: t.model, ordered: t.ordered.filter((c) => familyOk(t, c) && attempts.some((a) => a.provider === c.providerId && a.model === t.model.id && a.error_kind && retryable.has(a.error_kind))) }))
        .filter((t) => t.ordered.length);
      if (again.length) passes.push(again);
    }
  }
  // The retry on another family found no route that answered: serve the refused first answer, billed 0.
  const fallback = firstRefused as { result: RouteSuccess; upstream: object } | null;
  if (fallback) {
    outcome.served = "refused";
    return finish({ ...fallback.result, attempts }, fallback.upstream);
  }
  return { ok: false, attempts, last };
}

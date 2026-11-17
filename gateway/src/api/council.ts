import { inheritRoutePlan, routeResponseHeaders } from "../router/explain.ts"; // V84
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow, Modifier } from "../catalog/catalog.ts";
import { fail, isApiError, ApiError } from "../lib/errors.ts";
import { type Pico, maxPico, picoToUsd, picoToUsdString, usdToPico } from "../lib/money.ts";
import { genId, log, sha256 } from "../lib/util.ts";
import { release, reserve, settle } from "../ledger/ledger.ts";
import { estimatePromptTokens, maxOutputTokens, readUsage, worstCase, type Mode, type Usage } from "../router/pricing.ts";
import { route, type Attempt, type RouteSuccess, type RouteTarget } from "../router/execute.ts";
import type { ProviderPrefs } from "../router/select.ts";
import type { DisclosureRequest } from "../router/disclosure.ts";
import { providerKey } from "../providers/upstream.ts";
import { applyGuardrails, mergeGuardrails, redactOutput, type GuardrailConfig } from "../gateway/guardrails.ts";
import { payPerCall } from "../pay/percall.ts";
import {
  COUNCIL_MODEL,
  DUAL_SEED,
  JUDGE_MAX_TOKENS,
  attestationRefOf,
  compareOutputs,
  judgeMessages,
  labelFor,
  outputText,
  parseJudgeChoice,
  transcript,
  weakestServed,
  type AttestationRef,
  ANONYMO_COUNCIL_MODEL,
  COUNCIL_MODE_HEADER,
  COUNCIL_PROPOSERS,
  COUNCIL_QUORUM,
  awaitQuorum,
  councilPremium,
  mergeMessages,
  parseCouncilMode,
  pickProposers,
  type AnonymoCouncilMode,
  RETIRED_COUNCIL_MODEL,
  familyGroups,
} from "../router/council.ts";
import { attestationFresh } from "../router/select.ts";
import { outputModalities } from "../catalog/catalog.ts";
import { trustConfig } from "../anonymo/trust/config.ts";
import { familyOf } from "../anonymo/trust/families.ts";
import { weightsHashFor } from "../anonymo/trust/stats.ts";
import { SEALED_HEADER, assertSealedSeats, candidateState, sealedFilter, sealedRequired, sealedUnavailable, type SealedClock } from "../anonymo/trust/sealed.ts";
import { floorInputOf } from "../anonymo/services.ts";
import { floorErrorReason } from "../anonymo/floor/guard-client.ts";
import { floorReplyCheck, replyTextOf } from "../anonymo/floor/reply.ts";
import { RECEIPT_HEADER, buildAnonymoReceipt, issueAnonymoReceipt, receiptRoute, type ReceiptRoute } from "../receipts/anonymo.ts";
import type { KeyRow } from "./auth.ts";
import { generationHeaders, sharedPolicyHash } from "./common.ts";
import type * as Chat from "./chat.ts";

// Council mode (`model: "anonymo/council"`) and dual verification (`verify: "dual"`).
//
// Both fan one request out into several ordinary provider calls. Every call goes through the same
// routing, hold, settle and receipt path as a single request (`finalize` in chat.ts), so each one is
// billed and receipted on its own. The worst case of all calls is held before anything is sent, so the
// caller's balance and key budget bound the whole request, and every hold that is not settled is
// released on every exit.
//
// Attested mode (`council.attested: true`, or lane "attested" on either request): every call, the judge included, goes
// only to providers whose retention is declared "attested" and whose attestation the router holds fresh (the same test
// as the attested lane). Nothing is downgraded or dropped: a council with any member, or a judge, that has no attested
// provider, or a dual verification without two different attested providers of the model, is refused with a 409 before
// anything is held or sent. Each call's receipt records the attestation reference the router verified for its provider.

export { COUNCIL_MODEL };
export type Toolkit = typeof Chat.toolkit;
type Fin = Awaited<ReturnType<Toolkit["finalize"]>>;
type JsonSuccess = Extract<RouteSuccess, { kind: "json" }>;

type Base = {
  ctx: Ctx;
  c: Context;
  kind: Chat.Kind;
  body: Record<string, unknown>;
  bodySha: string;
  t0: number;
  key: KeyRow | null;
  wallet: { accountId: string; wallet: string } | null;
  /** Routing preferences with the disclosure ceiling and lane already folded in. */
  prefs: ProviderPrefs;
  disc: DisclosureRequest;
};

// ---- Request checks --------------------------------------------------------------------------------

/**
 * Checks shared by both modes. Runs before the caller is known (and again once key aliases have been
 * applied), so it only reads the body. Without the feature flag `anonymo/council` is an ordinary
 * unknown model, and `verify` is refused rather than silently ignored.
 */
export function validateMulti(ctx: Ctx, kind: Chat.Kind, body: Record<string, unknown>) {
  refuseRetiredCouncil(body);
  const council = ctx.cfg.features.council && body.model === COUNCIL_MODEL;
  const verify = body.verify != null;
  if (verify && !ctx.cfg.features.council) fail(400, "`verify` is not enabled on this router.", "feature_disabled");
  if (!council && !verify) return;
  if (verify && body.verify !== "dual") fail(400, "`verify` must be \"dual\".", "invalid_verify");
  if (council && verify) fail(400, `\`verify\` cannot be combined with model ${COUNCIL_MODEL}.`, "invalid_request");
  const what = council ? "Council mode" : "Dual verification";
  const type = council ? "invalid_council" : "invalid_verify";
  if (body.stream === true) fail(400, `${what} does not support streaming. Send stream: false.`, "streaming_unsupported");
  if (council && kind !== "chat") fail(400, "Council mode is available on /chat/completions only.", type);
  for (const k of ["n", "best_of"]) if (body[k] != null && body[k] !== 1) fail(400, `${what} needs \`${k}\` to be 1.`, type);
  if (Array.isArray(body.models) && body.models.length) fail(400, `${what} uses ${council ? "\`council.models\`" : "one model"}; \`models\` is not supported.`, type);
  if (body.cache != null) fail(400, `\`cache\` cannot be combined with ${council ? "council mode" : "\`verify\`"}.`, type);
  if (council && Array.isArray(body.transforms) && body.transforms.includes("middle-out")) fail(400, "The middle-out transform is not supported in council mode.", type);
}

/** Dual verification decodes deterministically: temperature 0 and a fixed seed (the caller's `seed` wins). */
export function applyDualDecoding(body: Record<string, unknown>) {
  if (body.temperature != null && body.temperature !== 0) fail(400, "`verify: \"dual\"` decodes at temperature 0; omit `temperature` or set it to 0.", "invalid_verify");
  if (body.seed != null && !Number.isInteger(body.seed)) fail(400, "`seed` must be an integer.", "invalid_verify");
  body.temperature = 0;
  body.seed ??= DUAL_SEED;
}

// ---- Shared pieces -----------------------------------------------------------------------------------

type Leg = {
  label: string;
  model: ModelRow;
  requested: string;
  body: Record<string, unknown>;
  targets: RouteTarget[];
  promptTokens: number;
  holdId: string;
  hold: Pico;
};

type LegResult =
  | { ok: true; r: JsonSuccess; doneAt: number }
  | { ok: false; attempts: Attempt[]; last?: Parameters<Toolkit["allFailed"]>[1]; thrown?: unknown };

/** A finished call, ready to be settled: usage read, output redacted (when the key asks), text taken. */
type Done = { leg: Leg; r: JsonSuccess; json: any; usage: Usage; text: string; redactions: number; doneAt: number };

/** The hold for a request: the dearest worst case over the providers that may be tried. */
function holdFor(ctx: Ctx, targets: RouteTarget[], body: Record<string, unknown>, promptTokens: number, mode: Mode, byok: Map<string, string>): Pico {
  const fees = { royaltyBps: 0, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const attemptable = targets.flatMap((t) => t.ordered.map((cand) => ({ cand, model: t.model }))).slice(0, ctx.cfg.routing.maxAttempts);
  return maxPico(...attemptable.map(({ cand, model }) => worstCase(cand, model, body, promptTokens, mode, fees, byok.has(cand.providerId))));
}

/** The most output tokens any provider that may be tried could produce for this request. */
function maxOutFor(ctx: Ctx, targets: RouteTarget[], body: Record<string, unknown>, promptTokens: number): number {
  const attemptable = targets.flatMap((t) => t.ordered.map((cand) => ({ cand, model: t.model }))).slice(0, ctx.cfg.routing.maxAttempts);
  return Math.max(1, ...attemptable.map(({ cand, model }) => maxOutputTokens(body, cand, model, promptTokens)));
}

/** Reserve every hold or none: a failure part-way releases what was already held. */
async function reserveAll(ctx: Ctx, billing: Chat.Billing, holds: { holdId: string; hold: Pico; targets: RouteTarget[]; body: Record<string, unknown>; promptTokens: number }[], paywithNote: string | undefined, _lane: "public" | "attested" | "unlinkable") {
  const held: string[] = [];
  try {
    for (const h of holds) {
      await reserve(ctx.db, {
        id: h.holdId,
        accountId: billing.accountId,
        keyHash: billing.key?.keyHash ?? null,
        amount: h.hold,
        kind: "usage",
        ttlMs: ctx.cfg.routing.providerTimeoutMs * (ctx.cfg.routing.maxAttempts + 1) * 2,
      });
      held.push(h.holdId);
    }
  } catch (e) {
    await Promise.all(held.map((id) => release(ctx.db, id)));
    if (isApiError(e) && e.type === "insufficient_credits" && paywithNote) e.metadata = { ...e.metadata, pay_with: paywithNote };
    throw e;
  }
}

async function callLeg(tk: Toolkit, p: { ctx: Ctx; kind: Chat.Kind; billing: Chat.Billing; byok: Map<string, string>; signal: AbortSignal }, leg: Leg): Promise<LegResult> {
  const { ctx } = p;
  try {
    const result = await route({
      appSecret: ctx.cfg.appSecret,
      targets: leg.targets,
      path: p.kind === "chat" ? "/chat/completions" : "/completions",
      body: leg.body,
      stream: false,
      keyFor: (cand: Candidate) => providerKey(cand, ctx.cfg.appSecret, p.byok.get(cand.providerId)),
      signal: p.signal,
      health: ctx.health,
      maxAttempts: ctx.cfg.routing.maxAttempts,
      timeoutMs: ctx.cfg.routing.providerTimeoutMs,
      firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs,
      production: ctx.cfg.production,
      caller: sha256(p.billing.accountId).slice(0, 16),
    });
    if (!result.ok) return { ok: false, attempts: result.attempts, last: result.last };
    return { ok: true, r: result as JsonSuccess, doneAt: Date.now() };
  } catch (e) {
    return { ok: false, attempts: [], thrown: e };
  }
}

/** Why a call failed, as a stable error type. */
function reasonOf(tk: Toolkit, out: Extract<LegResult, { ok: false }>): string {
  if (out.thrown) return isApiError(out.thrown) ? out.thrown.type : "internal";
  return tk.allFailed(out.attempts, out.last).type;
}

/** A call's output, redacted the way a normal response would be before it is hashed or shown to anyone. */
function prepare(leg: Leg, out: Extract<LegResult, { ok: true }>, guardCfg: GuardrailConfig | null): Done {
  const json = out.r.json;
  const usage = readUsage(json.usage, { prompt: leg.promptTokens, completion: Math.ceil(JSON.stringify(json.choices ?? []).length / 4) });
  const redactions = guardCfg?.redact_output ? redactOutput(json) : 0;
  const text = (json.choices ?? []).map((ch: any) => (typeof ch?.message?.content === "string" ? ch.message.content : (ch?.text ?? ""))).join("");
  return { leg, r: out.r, json, usage, text, redactions, doneAt: out.doneAt };
}

/** The attestation reference of the provider that served a call (the router's own record of it), or null when it holds none. */
const refOf = (cand: Candidate): AttestationRef | null =>
  attestationRefOf({ id: cand.providerId, teeKind: cand.provider.teeKind, attestationHash: cand.provider.attestationHash, attestedAt: cand.provider.attestedAt, tlsPin: cand.provider.tlsPin });

/** A call's receipt field for its provider's attestation reference: only in attested mode, so other receipts are unchanged. */
const refPayload = (attested: boolean, cand: Candidate) => {
  const ref = attested ? refOf(cand) : null;
  return ref ? { attestation_ref: ref } : {};
};

/** What the caller was billed across all calls, in the shape of a normal `usage` object. */
function aggregateUsage(fins: Fin[]) {
  const n = (f: (x: Fin) => number) => fins.reduce((s, x) => s + f(x), 0);
  const p = (f: (x: Fin) => Pico) => fins.reduce((s, x) => s + f(x), 0n);
  const prompt = n((x) => x.usageJson.prompt_tokens);
  const completion = n((x) => x.usageJson.completion_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cost: picoToUsd(p((x) => x.charged)),
    is_byok: fins.some((x) => x.isByok),
    cost_details: {
      upstream_inference_cost: picoToUsd(p((x) => x.cost.upstream)),
      royalty: picoToUsd(p((x) => x.cost.royalty)),
      margin: picoToUsd(p((x) => x.cost.margin)),
    },
    prompt_tokens_details: { cached_tokens: n((x) => x.usageJson.prompt_tokens_details.cached_tokens), cache_write_tokens: n((x) => x.usageJson.prompt_tokens_details.cache_write_tokens) },
    completion_tokens_details: { reasoning_tokens: n((x) => x.usageJson.completion_tokens_details.reasoning_tokens) },
    calls: fins.length,
  };
}

const firstFinish = (json: any) => ({ finish: json?.choices?.[0]?.finish_reason ?? null, native: json?.choices?.[0]?.native_finish_reason ?? json?.choices?.[0]?.finish_reason ?? null });

// ---- Council -------------------------------------------------------------------------------------------

const FREE_TEXT_ONLY = ["tools", "tool_choice", "response_format", "structured_outputs"];

/** chat.ts sends every council request here: `anonymo-council` (Backend §6). */
export async function runCouncil(tk: Toolkit, p: Base): Promise<Response> {
  return runAnonymoCouncil(tk, p);
}

// ---- Dual verification ------------------------------------------------------------------------------------

type DualInput = Base & {
  billing: Chat.Billing | null;
  paywithNote?: string;
  resolved: { model: ModelRow; modifiers: Set<Modifier>; requested: string }[];
  targets: RouteTarget[];
  excluded: { model: string; provider: string; reason: string }[];
  promptTokens: number;
  byok: Map<string, string>;
  guard: ReturnType<typeof applyGuardrails>;
  guardCfg: GuardrailConfig | null;
  middle: { removed: number; truncated: number } | null;
  savedRoute: string | null;
  preset?: { name: string; version: number; hash: string } | null;
};

/** Providers that can honour temperature and seed (or do not say either way, so both are sent). */
const decodesDeterministically = (cand: Candidate) => {
  const sp = cand.supportedParameters ?? [];
  return !sp.length || (sp.includes("seed") && sp.includes("temperature"));
};

export async function runDual(tk: Toolkit, p: DualInput): Promise<Response> {
  const { ctx, c, kind, body, bodySha, t0, disc, resolved, targets, promptTokens, byok, guard, guardCfg, middle, savedRoute, paywithNote } = p;
  let { billing } = p;
  validateMulti(ctx, kind, body);
  if (resolved.length !== 1 || targets.length !== 1) fail(400, "`verify: \"dual\"` works on exactly one model; remove `models`.", "invalid_verify");
  const target = targets[0];
  // Lane "attested": `disc` already limits every candidate to providers that are attested now (retention declared attested,
  // fresh attestation); the two legs must also be two different providers, and each receipt records its provider's attestation.
  const attested = disc.lane === "attested";

  // Two providers of the same model, taken alternately from the routing order so each call keeps its own fallbacks.
  const eligible = target.ordered.filter(decodesDeterministically).filter((cand, i, all) => !attested || all.findIndex((x) => x.providerId === cand.providerId) === i);
  if (eligible.length < 2)
    fail(
      409,
      attested
        ? `Dual verification on lane "attested" needs two different attested providers of ${target.model.id} (retention declared "attested" and a fresh attestation) that support temperature and seed; ${eligible.length} found. Nothing was sent to any provider, no provider that is not attested was substituted, and nothing was charged. See GET /api/v1/models?lane=attested.`
        : `Dual verification needs two providers of ${target.model.id} that support temperature and seed; ${eligible.length} found under this request's routing preferences.`,
      "verification_unavailable",
      {
        model: target.model.id,
        eligible: eligible.map((cand) => cand.providerId),
        excluded: [...p.excluded, ...target.ordered.filter((cand) => !decodesDeterministically(cand)).map((cand) => ({ model: target.model.id, provider: cand.providerId, reason: "does not support temperature and seed" }))].slice(0, 50),
        ...(attested ? { requested: { lane: "attested", disclosure: "none" } } : {}),
      },
    );
  const modeForPrice: Mode = billing?.mode ?? "per_call";
  const legs: Leg[] = [0, 1].map((i) => {
    const targetsOf = [{ model: target.model, ordered: inheritRoutePlan(target.ordered, eligible.filter((_, j) => j % 2 === i)) }];
    return { label: labelFor(i), model: target.model, requested: resolved[0].requested, body, targets: targetsOf, promptTokens, holdId: genId(), hold: holdFor(ctx, targetsOf, body, promptTokens, modeForPrice, byok) };
  });
  const total = legs[0].hold + legs[1].hold;

  if (!billing) {
    const r = await payPerCall(ctx, c, { pricePico: total, bodySha, modelId: target.model.id });
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash, paymentResponse: r.paymentResponse };
  }
  if (billing.key?.tpm) await tk.limitOrThrow(ctx, `kt:${billing.key.keyHash}`, promptTokens * 2, billing.key.tpm, "tokens");
  const bill: Chat.Billing = billing;

  await reserveAll(ctx, bill, legs, paywithNote, disc.lane);
  const open = new Set(legs.map((l) => l.holdId));
  const abort = new AbortController();
  c.req.raw.signal?.addEventListener("abort", () => abort.abort(new DOMException("client disconnected", "AbortError")), { once: true });
  const call = { ctx, kind, billing: bill, byok, signal: abort.signal };
  const meta = { guard, middle, paywithNote, cacheMode: null, excluded: p.excluded, route: savedRoute, preset: p.preset ?? null };
  // Each answer's gateway receipt check (providers/aci.ts), made once: it decides the attested block and goes into the receipt.
  const checkedUpstream = new WeakMap<Done, Awaited<ReturnType<Toolkit["upstreamAttestationOf"]>>>();
  const settle = (leg: Leg, done: Done, verification: unknown) => {
    const f = firstFinish(done.json);
    return tk.finalize({
      ctx, c, body, billing: bill, holdId: leg.holdId, t0, bodySha, stream: false, kind, byok, meta, guardCfg, promptTokens, disc, planned: null,
      r: done.r, usage: done.usage, responseText: done.text, finishReason: f.finish, nativeFinish: f.native, generationMs: done.doneAt - t0, cancelled: false,
      extra: { payload: { verification, ...refPayload(attested, done.r.candidate) } },
      ...(checkedUpstream.has(done) ? { upstreamAttestation: checkedUpstream.get(done) } : {}),
    });
  };
  // What the router checked for the providers that answered, for the `verification` block (attested lane only).
  const attestedBlock = (ran: { label: string; receiptId: string; done: Done }[]) => {
    if (!attested) return {};
    const refs = ran.flatMap((x) => {
      const ref = refOf(x.done.r.candidate);
      return ref ? [{ label: x.label, receipt_id: x.receiptId, ...ref }] : [];
    });
    const every = ran.every((x) => tk.servedWith(ctx, x.done.r.candidate, checkedUpstream.get(x.done)).class === "attested");
    return { attested: every && refs.length === ran.length, attestation_refs: refs };
  };

  try {
    const outcomes = await Promise.all(legs.map((leg) => callLeg(tk, call, leg)));
    if (abort.signal.aborted) throw abort.signal.reason;
    const done = outcomes.map((o, i) => (o.ok ? prepare(legs[i], o, guardCfg) : null));
    for (const d of done) if (d) checkedUpstream.set(d, await tk.upstreamAttestationOf(ctx, d.r, byok));
    const ids = [legs[0].holdId, legs[1].holdId];

    // One call failed: the other still ran, so it is billed and receipted, but nothing is verified.
    if (!done[0] || !done[1]) {
      const fins: Fin[] = [];
      for (const [i, d] of done.entries()) {
        if (!d) continue;
        fins.push(await settle(legs[i], d, { mode: "dual", agree: null, complete: false, receipts: ids, ...attestedBlock([{ label: legs[i].label, receiptId: ids[i], done: d }]) }));
        open.delete(legs[i].holdId);
      }
      const failed = outcomes.flatMap((o, i) => (o.ok ? [] : [{ leg: legs[i].label, providers: legs[i].targets[0].ordered.map((cand) => cand.providerId), error: reasonOf(tk, o) }]));
      if (!fins.length) {
        const first = outcomes.find((o) => !o.ok) as Extract<LegResult, { ok: false }>;
        if (first.thrown) throw first.thrown;
        throw tk.allFailed(outcomes.flatMap((o) => (o.ok ? [] : o.attempts)), first.last);
      }
      throw new ApiError(502, "One of the two providers failed, so the output could not be verified. The call that ran was billed; its receipt is listed.", "verification_failed", { failed, receipts: fins.map((f) => f.id) });
    }

    const [a, b] = done;
    const cmp = compareOutputs(outputText(a.json), outputText(b.json));
    const seed = body.seed as number;
    const verification = {
      mode: "dual",
      providers: [a.r.candidate.providerId, b.r.candidate.providerId],
      agree: cmp.agree,
      match: cmp.match,
      receipts: ids,
      seed,
      temperature: 0,
      quantizations: [a.r.candidate.quant, b.r.candidate.quant],
      ...attestedBlock([
        { label: legs[0].label, receiptId: ids[0], done: a },
        { label: legs[1].label, receiptId: ids[1], done: b },
      ]),
    };
    const finA = await settle(legs[0], a, verification);
    open.delete(legs[0].holdId);
    const finB = await settle(legs[1], b, verification);
    open.delete(legs[1].holdId);

    const dropped = [...new Set([...a.r.dropped, ...b.r.dropped])];
    const extras = (finA.extras(a.redactions) ?? {}) as Record<string, unknown>;
    delete extras.dropped_parameters;
    if (dropped.length) extras.dropped_parameters = dropped;
    const { mode: _mode, ...shown } = verification;
    const out = {
      ...a.json,
      id: finA.id,
      model: a.r.model.id,
      provider: a.r.candidate.provider.name,
      object: kind === "chat" ? "chat.completion" : "text_completion",
      usage: aggregateUsage([finA, finB]),
      receipt: finA.receiptJson,
      verification: shown,
      ...extras,
    };
    // The header speaks for both calls, so it shows the weaker of the two; each receipt carries its own call's class.
    const served = weakestServed([finA, finB].map((f) => ({ class: f.disclosure, simulated: f.simulated })));
    return c.json(out, 200, { ...routeResponseHeaders(ctx.cfg.routeExplain, a.r), ...generationHeaders(finA.id, disc.lane, sharedPolicyHash([finA.policyHash, finB.policyHash])), "x-anonymo-disclosure": served.class, ...tk.paymentHeaders(bill) });
  } finally {
    await Promise.all([...open].map((id) => release(ctx.db, id)));
  }
}

// ---- Anonymo council (`anonymo-council`, Backend §6) -------------------------------------------------------------------
//
// chat.ts dispatches a council for `body.model === COUNCIL_MODEL` ("anonymo-council") when the council feature is on,
// before key aliases and before its floor check. runAnonymoCouncil therefore runs the floor gate itself, first, so a
// council request is never sent anywhere when the floor blocks it.

/** WS01 retired the Anonymo council id; a request that still sends it is told the new one. */
function refuseRetiredCouncil(body: Record<string, unknown>) {
  if (body.model === RETIRED_COUNCIL_MODEL)
    fail(404, `The model \`${RETIRED_COUNCIL_MODEL}\` was renamed: send \`${COUNCIL_MODEL}\` (council.models and council.judge still choose the seats).`, "model_not_found");
}

/** The same check and error shapes as the chat floor hook: 451 floor_blocked, 503 floor_unavailable, nothing sent or charged. */
async function councilFloorCheck(ctx: Ctx, body: Record<string, unknown>) {
  let verdict;
  try {
    verdict = await ctx.anonymo.floor.check(floorInputOf(body));
  } catch (e) {
    log.warn("floor check unavailable", { reason: floorErrorReason(e) });
    throw new ApiError(503, "The safety check is unavailable. Nothing was sent or charged; try again shortly.", "floor_unavailable");
  }
  if (!verdict.ok) throw new ApiError(451, "This request crosses a line Anonymo blocks for everyone. Nothing was sent or charged.", "floor_blocked", { category: verdict.category });
}

type AnonymoSpec = { models: string[] | null; aggregator: string | null; judge: string | null; mode: unknown; sealed: boolean; maxCostUsd: number | null };
const ANONYMO_SPEC_KEYS = new Set(["models", "aggregator", "judge", "mode", "sealed", "max_cost_usd"]);

/** `council` on an anonymo-council request is optional; every field in it is checked, nothing is guessed. */
function parseAnonymoSpec(raw: unknown): AnonymoSpec {
  const bad = (m: string): never => fail(400, m, "invalid_council");
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) bad("`council` must be an object.");
  const c = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!ANONYMO_SPEC_KEYS.has(k)) bad(`Unknown council option \`${k}\`. Supported: ${[...ANONYMO_SPEC_KEYS].join(", ")}.`);
  let models: string[] | null = null;
  if (c.models != null) {
    if (!Array.isArray(c.models) || c.models.some((m) => typeof m !== "string" || !m.trim())) bad("`council.models` must be an array of model ids.");
    models = (c.models as string[]).map((m) => m.trim());
    if (models.length < COUNCIL_PROPOSERS || models.length > 8) bad(`\`council.models\` must list ${COUNCIL_PROPOSERS} to 8 model ids (the first ${COUNCIL_PROPOSERS} usable ones from different families answer).`);
    if (new Set(models).size !== models.length) bad("`council.models` must not repeat a model id.");
    if (models.includes(ANONYMO_COUNCIL_MODEL) || models.includes(RETIRED_COUNCIL_MODEL)) bad("A council cannot include itself.");
  }
  const id = (v: unknown, name: string) => {
    if (v == null) return null;
    if (typeof v !== "string" || !v.trim()) bad(`\`council.${name}\` must be a model id.`);
    if (v === ANONYMO_COUNCIL_MODEL || v === RETIRED_COUNCIL_MODEL) bad(`A council cannot be its own ${name}.`);
    return (v as string).trim();
  };
  if (c.sealed != null && typeof c.sealed !== "boolean") bad("`council.sealed` must be true or false.");
  let maxCostUsd: number | null = null;
  if (c.max_cost_usd != null) {
    if (typeof c.max_cost_usd !== "number" || !Number.isFinite(c.max_cost_usd) || c.max_cost_usd <= 0) bad("`council.max_cost_usd` must be a positive number of US dollars.");
    maxCostUsd = c.max_cost_usd as number;
  }
  return { models, aggregator: id(c.aggregator, "aggregator"), judge: id(c.judge, "judge"), mode: c.mode, sealed: c.sealed === true, maxCostUsd };
}

type Seat = { model: ModelRow; modifiers: Set<Modifier>; requested: string };
type PlannedSeat = Seat & { targets: RouteTarget[]; excluded: { model: string; provider: string; reason: string }[] };
type ProposerRun = (LegResult & { refused?: false }) | { ok: true; r: JsonSuccess; doneAt: number; refused: true };

/** Every candidate route() may attempt for a set of targets (it stops after maxAttempts). */
const attemptable = (ctx: Ctx, targets: RouteTarget[]) => targets.flatMap((t) => t.ordered).slice(0, ctx.cfg.routing.maxAttempts);

async function runAnonymoCouncil(tk: Toolkit, p: Base): Promise<Response> {
  const { ctx, c, kind, body, bodySha, t0, key, wallet } = p;
  let { prefs, disc } = p;
  validateMulti(ctx, kind, body);
  const spec = parseAnonymoSpec(body.council);
  const mode: AnonymoCouncilMode = parseCouncilMode(c.req.header(COUNCIL_MODE_HEADER), spec.mode, "merge");
  const sealed = sealedRequired({ header: c.req.header(SEALED_HEADER), key, councilSealed: spec.sealed }) || disc.lane === "attested";
  // The floor gate first: a blocked prompt is never priced, held, sent or rerouted.
  await councilFloorCheck(ctx, body);
  if (sealed && disc.lane === "public") {
    disc = { max: "none", lane: "attested" };
    prefs = { ...prefs, disclosure: "none", lane: "attested" };
  }
  if (mode === "merge") for (const k of FREE_TEXT_ONLY) if (body[k] != null) fail(400, `Merge mode writes free text, so \`${k}\` is not supported; use ${COUNCIL_MODE_HEADER}: select.`, "invalid_council");
  const cfg = trustConfig(ctx);
  const clock: SealedClock = { now: Date.now(), maxAgeMs: ctx.cfg.attestation.intervalMs * 3, production: ctx.cfg.production };

  // ---- Who may sit: the pool of proposer models, in preference order ----------------------------------------------
  await ctx.catalog.ensureFresh();
  const allowed = new Set(key?.allowedModels ?? []);
  const explicit = spec.models != null;
  const poolIds = spec.models ?? (ctx.cfg.council.models.length ? ctx.cfg.council.models : autoPool(ctx));
  const resolveSeat = (id: string, must: boolean): Seat | null => {
    const r = ctx.catalog.resolve(id);
    if (!r) return must ? fail(404, `Council model ${id} is not available. See GET /v1/models.`, "model_not_found") : null;
    if (allowed.size && !allowed.has(r.model.id)) return must ? fail(403, `This key may only use: ${[...allowed].join(", ")}.`, "model_not_allowed") : null;
    return { ...r, requested: id };
  };
  const pool = poolIds.map((id) => resolveSeat(id, explicit)).filter((x): x is Seat => !!x);

  const guardCfg = mergeGuardrails(key?.guardrails as GuardrailConfig | null, key ? (body.guardrails as GuardrailConfig | undefined) : undefined);
  const guard = applyGuardrails(body, guardCfg);
  const { billing: resolvedBilling, paywithNote } = await tk.resolveBilling(ctx, c, key, wallet);
  let billing = resolvedBilling;
  const byok = await tk.byokFor(ctx, billing?.accountId);
  const modeForPrice: Mode = billing?.mode ?? "per_call";

  // ---- Plan: each seat's routes. Under sealed only attested, fresh routes are kept, and a seat without one is unusable.
  const { council: _council, model: _model, ...shared } = body;
  const cap = cfg.proposerMaxTokens;
  const capped = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(v, cap) : cap);
  const proposerBase = { ...shared, max_tokens: capped(shared.max_tokens), ...(shared.max_completion_tokens != null ? { max_completion_tokens: capped(shared.max_completion_tokens) } : {}) };
  const promptTokens = estimatePromptTokens(shared);
  const planCache = new Map<string, PlannedSeat | null>();
  const planSeat = (s: Seat, seatBody: Record<string, unknown>, tokens: number): PlannedSeat | null => {
    try {
      const planned = tk.selectTargets(ctx, { resolved: [s], prefs, params: tk.requestParams(seatBody), promptTokens: tokens, byok, disc });
      let targets = planned.targets;
      if (sealed) targets = targets.map((t) => ({ ...t, ordered: sealedFilter(t.ordered, candidateState, clock) })).filter((t) => t.ordered.length > 0);
      return targets.length ? { ...s, targets, excluded: planned.excluded } : null;
    } catch (e) {
      if (isApiError(e) && e.status < 500 && e.status !== 409 && e.status !== 404) throw e; // a malformed request, not an unavailable seat
      return null;
    }
  };
  const planProposer = (s: Seat) => {
    if (!planCache.has(s.model.id)) planCache.set(s.model.id, planSeat(s, { ...proposerBase, model: s.requested }, promptTokens));
    return planCache.get(s.model.id) ?? null;
  };
  // WS04 registers `anonymo-council` as a catalog model whose routes span several families: with no pool configured,
  // each family among its routes is one proposer seat (failing over within that family). Otherwise the pool is models.
  const routePool = !explicit && !ctx.cfg.council.models.length ? resolveSeat(ANONYMO_COUNCIL_MODEL, false) : null;
  type Proposer = { seat: Seat; targets: RouteTarget[]; family: string };
  let chosen: Proposer[];
  if (routePool) {
    const planned = planSeat(routePool, { ...proposerBase, model: routePool.requested }, promptTokens);
    const ordered = planned ? planned.targets.flatMap((t) => t.ordered) : [];
    chosen = familyGroups(ordered, (cand) => familyOf(routePool.model, cand as unknown as Record<string, unknown>))
      .slice(0, COUNCIL_PROPOSERS)
      .map((g) => ({ seat: routePool, targets: [{ model: routePool.model, ordered: g.routes }], family: g.family }));
  } else {
    const famOf = (s: Seat) => familyOf(s.model, ctx.catalog.offers(s.model.id)[0] as unknown as Record<string, unknown> | undefined);
    chosen = pickProposers(pool, famOf, (s) => !!planProposer(s)).map((s) => ({ seat: s, targets: planProposer(s)!.targets, family: famOf(s) }));
  }
  if (chosen.length < COUNCIL_PROPOSERS) {
    const families = chosen.map((p) => p.family);
    const detail = { needed: COUNCIL_PROPOSERS, families_available: families, pool: pool.map((s) => s.model.id) };
    if (sealed) throw sealedUnavailable(`A sealed council needs attested, fresh routes for proposers from ${COUNCIL_PROPOSERS} different model families; ${families.length} found. Nothing was sent or charged.`, { seat: "proposers", reason: "not_enough_attested_families", ...detail });
    fail(503, `The council needs proposers from ${COUNCIL_PROPOSERS} different model families that can serve now; ${families.length} found. Nothing was sent or charged.`, "council_unavailable", detail);
  }
  const legFamily = new Map<Leg, string>();
  const legs: Leg[] = chosen.map((p, i) => {
    const legBody = { ...proposerBase, model: p.seat.requested };
    const leg = { label: labelFor(i), model: p.seat.model, requested: p.seat.requested, body: legBody, targets: p.targets, promptTokens, holdId: genId(), hold: holdFor(ctx, p.targets, legBody, promptTokens, modeForPrice, byok) };
    legFamily.set(leg, p.family);
    return leg;
  });

  // The aggregator (merge) or judge (select): a strong model reads every reply. Its hold assumes each proposer fills its cap.
  const aggId = (mode === "merge" ? (spec.aggregator ?? spec.judge) : (spec.judge ?? spec.aggregator)) ?? ctx.cfg.council.judge ?? chosen[0].seat.requested;
  const aggSeat = resolveSeat(aggId, true)!;
  const conversation = transcript(shared.messages);
  const tag = randomBytes(8).toString("hex");
  const skeleton = mode === "merge" ? mergeMessages(conversation, [], tag) : judgeMessages("judge", conversation, [], tag);
  const aggBase: Record<string, unknown> = {
    model: aggId,
    ...(mode === "select" ? { max_tokens: JUDGE_MAX_TOKENS } : Object.fromEntries(["max_tokens", "max_completion_tokens"].filter((k) => body[k] != null).map((k) => [k, body[k]]))),
    ...(body.user !== undefined ? { user: body.user } : {}),
    ...(body.provider !== undefined ? { provider: body.provider } : {}),
  };
  const answerTokens = legs.reduce((sum, l) => sum + Math.ceil((maxOutFor(ctx, l.targets, l.body, l.promptTokens) * 4) / 3) + 40, 0);
  const aggWorstTokens = estimatePromptTokens({ messages: skeleton }) + answerTokens;
  const aggPlan = planSeat(aggSeat, { ...aggBase, messages: skeleton }, aggWorstTokens);
  const aggRole = mode === "merge" ? "aggregator" : "judge";
  if (!aggPlan) {
    if (sealed) throw sealedUnavailable(`No attested route with a fresh verified attestation can serve the council ${aggRole} (${aggSeat.model.id}). Nothing was sent or charged.`, { seat: aggRole, reason: "none_attested", model: aggSeat.model.id });
    fail(503, `No provider can serve the council ${aggRole} ${aggSeat.model.id} now. Nothing was sent or charged.`, "council_unavailable", { seat: aggRole, model: aggSeat.model.id });
  }
  const aggHoldId = genId();
  const aggHold = holdFor(ctx, aggPlan.targets, { ...aggBase, messages: skeleton }, aggWorstTokens, modeForPrice, byok);
  // Belt and braces: every route that could be attempted for any seat is attested and fresh, or nothing is sent.
  if (sealed)
    assertSealedSeats(
      [...legs.map((l) => ({ seat: `proposer ${l.label}`, routes: attemptable(ctx, l.targets) })), { seat: aggRole, routes: attemptable(ctx, aggPlan.targets) }],
      candidateState,
      clock,
    );

  // ---- Budget: proposers, aggregator and the council premium, held before anything is sent ---------------------------
  const premiumHoldId = genId();
  const premiumHold = councilPremium({ charges: [], baseline: maxPico(...legs.map((l) => l.hold)), multiplier: cfg.councilMultiplier }).target;
  const total = legs.reduce((sum, l) => sum + l.hold, aggHold + premiumHold);
  const budgetCap = spec.maxCostUsd != null ? usdToPico(spec.maxCostUsd, "floor") : null;
  const worst = maxPico(legs.reduce((sum, l) => sum + l.hold, aggHold), premiumHold);
  if (budgetCap != null && worst > budgetCap)
    fail(402, `The worst case for this council is $${picoToUsd(worst)}, above council.max_cost_usd of $${spec.maxCostUsd}. Lower max_tokens.`, "council_budget_exceeded", { max_cost_usd: spec.maxCostUsd, worst_case_usd: picoToUsd(worst) });
  if (!billing) {
    const r = await payPerCall(ctx, c, { pricePico: total, bodySha, modelId: ANONYMO_COUNCIL_MODEL });
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash, paymentResponse: r.paymentResponse };
  }
  if (billing.key?.tpm) await tk.limitOrThrow(ctx, `kt:${billing.key.keyHash}`, legs.reduce((s, l) => s + l.promptTokens, aggWorstTokens), billing.key.tpm, "tokens");
  const bill: Chat.Billing = billing;
  await reserveAll(
    ctx,
    bill,
    [...legs, { holdId: aggHoldId, hold: aggHold, targets: aggPlan.targets, body: aggBase, promptTokens: aggWorstTokens }, { holdId: premiumHoldId, hold: premiumHold, targets: [], body: {}, promptTokens: 0 }],
    paywithNote,
    disc.lane,
  );
  const open = new Set([...legs.map((l) => l.holdId), aggHoldId, premiumHoldId]);
  const abort = new AbortController();
  c.req.raw.signal?.addEventListener("abort", () => abort.abort(new DOMException("client disconnected", "AbortError")), { once: true });
  const meta = { guard, middle: null, paywithNote, cacheMode: null, excluded: [...new Set(legs.flatMap((l) => planCache.get(l.model.id)?.excluded.slice(0, 10) ?? []))], route: null };
  const common = (leg: Leg, sha: string) => ({ ctx, c, body: leg.body, billing: bill, holdId: leg.holdId, t0, bodySha: sha, stream: false, kind, byok, meta, guardCfg, promptTokens: leg.promptTokens, disc, planned: null });
  const budget = (l: { hold: Pico }) => (budgetCap != null ? l.hold : undefined);
  const promptText = transcript(shared.messages);
  const refusedHead = async (json: any) => {
    try {
      return await ctx.anonymo.refusal.isRefusal(promptText, outputText(json).slice(0, 2000));
    } catch {
      return false; // a classifier that cannot answer never turns an answer into a refusal
    }
  };
  const dropHold = async (id: string) => {
    open.delete(id);
    await release(ctx.db, id);
  };

  try {
    // ---- Proposers: concurrently; go on once two have answered, the third gets the grace period ---------------------
    const legAborts = legs.map(() => new AbortController());
    const runs = legs.map((leg, i) =>
      callLeg(tk, { ctx, kind, billing: bill, byok, signal: AbortSignal.any([abort.signal, legAborts[i].signal]) }, leg).then(async (out): Promise<ProposerRun> => {
        if (!out.ok) return out;
        return (await refusedHead(out.r.json)) ? { ...out, refused: true } : out;
      }),
    );
    const { results, late } = await awaitQuorum<ProposerRun>(runs, (r) => r.ok && !r.refused, { quorum: COUNCIL_QUORUM, graceMs: cfg.graceMs, onError: (e) => ({ ok: false, attempts: [], thrown: e }) });
    for (const i of late) legAborts[i].abort(new DOMException("council moved on", "AbortError"));
    if (abort.signal.aborted) throw abort.signal.reason;
    const answered = legs.flatMap((leg, i) => {
      const r = results[i];
      return r && r.ok && !r.refused ? [{ leg, done: prepare(leg, r, guardCfg) }] : [];
    });
    // Refused, failed and late proposers are billed nothing.
    for (const [i, leg] of legs.entries()) if (!answered.some((a) => a.leg === leg)) await dropHold(leg.holdId);
    const statusOf = (i: number) => {
      const r = results[i];
      return r === undefined ? ("late" as const) : !r.ok ? ("failed" as const) : r.refused ? ("refused" as const) : ("ok" as const);
    };
    if (answered.length < COUNCIL_QUORUM)
      throw new ApiError(502, `Only ${answered.length} of ${legs.length} council proposers answered (${COUNCIL_QUORUM} needed). Nothing was charged.`, "council_quorum", {
        needed: COUNCIL_QUORUM,
        proposers: legs.map((l, i) => ({ label: l.label, model: l.model.id, family: legFamily.get(l), status: statusOf(i), ...(results[i] && !results[i]!.ok ? { error: reasonOf(tk, results[i] as Extract<LegResult, { ok: false }>) } : {}) })),
      });

    // ---- Aggregator (merge) or judge (select) ---------------------------------------------------------------------
    const candidates = answered.map((a) => ({ label: a.leg.label, text: outputText(a.done.json) }));
    const aggBody = { ...aggBase, messages: mode === "merge" ? mergeMessages(conversation, candidates, tag) : judgeMessages("judge", conversation, candidates, tag) };
    const aggLeg: Leg = { label: aggRole, model: aggSeat.model, requested: aggId, body: aggBody, targets: aggPlan.targets, promptTokens: estimatePromptTokens(aggBody), holdId: aggHoldId, hold: aggHold };
    const ao = await callLeg(tk, { ctx, kind, billing: bill, byok, signal: abort.signal }, aggLeg);
    if (abort.signal.aborted) throw abort.signal.reason;
    if (!ao.ok) throw new ApiError(502, `The council ${aggRole} could not be reached. Nothing was charged.`, "council_aggregator_failed", { [aggRole]: { model: aggSeat.model.id, error: reasonOf(tk, ao) } });
    const agg = prepare(aggLeg, ao, guardCfg);

    // What the caller receives: the merged answer, or the reply the judge picked. A merge that comes back as a refusal,
    // or a judge that names no valid reply, falls back to proposer A's reply rather than leaving the caller with nothing.
    let source: Done = agg;
    let selected: string | null = null;
    let reason: string | null = null;
    let outcome: "merged" | "selected" | "aggregator_refused" | "invalid_verdict" = mode === "merge" ? "merged" : "selected";
    let aggStatus: "ok" | "refused" = "ok";
    if (mode === "select") {
      const choice = parseJudgeChoice(outputText(agg.json), answered.map((a) => a.leg.label));
      const pick = choice ? answered.find((a) => a.leg.label === choice.label)! : answered[0];
      source = pick.done;
      selected = pick.leg.label;
      reason = choice?.reason ?? null;
      if (!choice) outcome = "invalid_verdict";
    } else if (await refusedHead(agg.json)) {
      source = answered[0].done;
      selected = answered[0].leg.label;
      outcome = "aggregator_refused";
      aggStatus = "refused";
    }

    // ---- The floor's reply check on what the caller would receive; a block or an unreachable guard throws, and the
    // finally below releases every hold, so nothing is charged (anonymo/floor/reply.ts).
    await floorReplyCheck(ctx.anonymo.floor, replyTextOf(source.json), abort.signal);

    // ---- Settle: proposers that answered, the aggregator (unless it refused), then the premium -----------------------
    const fins: Fin[] = [];
    const finOf = new Map<Leg, Fin>();
    for (const a of answered) {
      const f = firstFinish(a.done.json);
      const fin = await tk.finalize({
        ...common(a.leg, tk.requestHash(a.leg.body)),
        r: a.done.r,
        usage: a.done.usage,
        responseText: a.done.text,
        finishReason: f.finish,
        nativeFinish: f.native,
        generationMs: a.done.doneAt - t0,
        cancelled: false,
        extra: { payload: { council: { role: "proposer", label: a.leg.label, mode, parent: aggHoldId } }, budget: budget(a.leg) },
      });
      open.delete(a.leg.holdId);
      fins.push(fin);
      finOf.set(a.leg, fin);
    }
    let aggFin: Fin | null = null;
    if (aggStatus === "ok") {
      const f = firstFinish(source.json);
      aggFin = await tk.finalize({
        ...common(aggLeg, bodySha),
        r: agg.r,
        usage: agg.usage,
        responseText: source.text,
        finishReason: f.finish,
        nativeFinish: f.native,
        generationMs: Date.now() - t0,
        cancelled: false,
        extra: { payload: { council: { role: aggRole, mode, selected, outcome, proposers: answered.map((a) => ({ label: a.leg.label, receipt_id: finOf.get(a.leg)!.id })), answer_sha256: sha256(source.text) } }, budget: budget(aggLeg) },
      });
      open.delete(aggHoldId);
      fins.push(aggFin);
    } else await dropHold(aggHoldId);

    const proposerCharges = answered.map((a) => finOf.get(a.leg)!.charged);
    const price = councilPremium({ charges: fins.map((f) => f.charged), baseline: maxPico(...proposerCharges), multiplier: cfg.councilMultiplier });
    const premium = (await settle(ctx.db, premiumHoldId, price.premium, { description: `${ANONYMO_COUNCIL_MODEL} premium (${cfg.councilMultiplier}x one call)`, generationId: aggFin?.id ?? null })).charged;
    open.delete(premiumHoldId);
    const charged = fins.reduce((s, f) => s + f.charged, 0n) + premium;

    // ---- The Anonymo receipt: every proposer (answered, refused, failed or late), the aggregator, and each one's cost
    const firstCand = (leg: Leg) => leg.targets[0].ordered[0];
    const attestedNow = (cand: Candidate) => sealed || attestationFresh(cand, clock.maxAgeMs, clock.production);
    const routes: ReceiptRoute[] = legs.map((leg, i) => {
      const r = results[i];
      const status = statusOf(i);
      const cand = r && r.ok ? r.r.candidate : firstCand(leg);
      const model = r && r.ok ? r.r.model : leg.model;
      const fin = finOf.get(leg);
      const usage = r && r.ok && fin ? { in: fin.usageJson.prompt_tokens, out: fin.usageJson.completion_tokens } : { in: 0, out: 0 };
      return receiptRoute({ candidate: cand as never, model, role: "proposer", status, attested: attestedNow(cand), sealed, tokens: usage, charged: fin?.charged ?? 0n, callReceiptId: fin?.id ?? null, weightsHash: weightsHashFor(ctx, model, cand) });
    });
    routes.push(
      receiptRoute({
        candidate: agg.r.candidate as never,
        model: agg.r.model,
        role: aggRole,
        status: aggStatus,
        attested: attestedNow(agg.r.candidate),
        sealed,
        tokens: aggFin ? { in: aggFin.usageJson.prompt_tokens, out: aggFin.usageJson.completion_tokens } : { in: 0, out: 0 },
        charged: aggFin?.charged ?? 0n,
        callReceiptId: aggFin?.id ?? null,
        weightsHash: weightsHashFor(ctx, agg.r.model, agg.r.candidate),
      }),
    );
    const requestId = aggFin?.id ?? aggHoldId;
    const receipt = await issueAnonymoReceipt(
      ctx,
      buildAnonymoReceipt({
        requestId,
        modelId: ANONYMO_COUNCIL_MODEL,
        routes,
        charged,
        costDetails: { compute: picoToUsdString(price.compute), premium: picoToUsdString(premium), multiplier: String(cfg.councilMultiplier) },
        refused: false,
        sealed,
        council: { mode, outcome, selected, proposers: legs.length, answered: answered.length, grace_ms: cfg.graceMs, max_tokens: cap },
      }),
    );

    const dropped = [...new Set([...answered.flatMap((a) => a.done.r.dropped), ...agg.r.dropped])];
    const redactions = answered.reduce((s, a) => s + a.done.redactions, 0) + (mode === "merge" ? agg.redactions : 0);
    const extras = ((aggFin ?? fins[0]).extras(redactions) ?? {}) as Record<string, unknown>;
    delete extras.dropped_parameters;
    if (dropped.length) extras.dropped_parameters = dropped;
    const usage = aggregateUsage(fins);
    const out = {
      ...source.json,
      id: requestId,
      model: ANONYMO_COUNCIL_MODEL,
      object: "chat.completion",
      usage: { ...usage, cost: picoToUsd(charged), cost_details: { ...usage.cost_details, council_premium: picoToUsd(premium) } },
      receipt: (aggFin ?? fins[0]).receiptJson,
      anonymo_receipt: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id, alg: receipt.alg, leaf: receipt.leaf },
      council: {
        mode,
        outcome,
        selected,
        ...(reason ? { reason } : {}),
        sealed,
        proposers: routes.filter((r) => r.role === "proposer").map((r, i) => ({ label: labelFor(i), model: r.model, provider: r.provider, family: r.family, status: r.status, cost: r.cost, receipt_id: r.call_receipt_id ?? null })),
        [aggRole]: { model: agg.r.model.id, provider: agg.r.candidate.providerId, status: aggStatus, cost: picoToUsdString(aggFin?.charged ?? 0n), receipt_id: aggFin?.id ?? null },
        premium: picoToUsdString(premium),
        total_cost: picoToUsdString(charged),
      },
      ...extras,
    };
    return c.json(out, 200, {
      ...routeResponseHeaders(ctx.cfg.routeExplain, agg.r),
      ...generationHeaders(requestId, disc.lane, sharedPolicyHash(fins.map((f) => f.policyHash))),
      "x-anonymo-disclosure": weakestServed(fins.map((f) => ({ class: f.disclosure, simulated: f.simulated }))).class,
      [RECEIPT_HEADER]: receipt.header,
      [COUNCIL_MODE_HEADER]: mode,
      ...(sealed ? { [SEALED_HEADER]: "true" } : {}),
      ...tk.paymentHeaders(bill),
    });
  } finally {
    await Promise.all([...open].map((id) => release(ctx.db, id)));
  }
}

/** Without a configured pool: every listed text model with a live route, newest first (the same order as GET /v1/models). */
function autoPool(ctx: Ctx): string[] {
  return [...ctx.catalog.models.values()]
    .filter((m) => !m.hidden && !m.id.startsWith("anonymo-") && outputModalities(m).includes("text") && ctx.catalog.offers(m.id).some((o) => o.status === "live" && o.provider.status === "live"))
    .sort((a, b) => b.createdUnix - a.createdUnix || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

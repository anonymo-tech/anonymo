import type { Context } from "hono";
import type { Ctx } from "../../context.ts";
import type { Candidate, ModelRow } from "../../catalog/catalog.ts";
import type { RouteTarget } from "../../router/execute.ts";
import { isApiError } from "../../lib/errors.ts";
import type { Pico } from "../../lib/money.ts";
import { attestationFresh } from "../../router/select.ts";
import { RECEIPT_HEADER, buildAnonymoReceipt, issueAnonymoReceipt, receiptRoute, type RouteRole, type RouteStatus } from "../../receipts/anonymo.ts";
import { SEALED_HEADER, assertSealedSeats, candidateState, keySealedOnly, sealedFilter, sealedRequired, sealedUnavailable, type SealedClock } from "./sealed.ts";
import { weightsHashFor } from "./stats.ts";

// Hooks for the single-call path in api/chat.ts and router/execute.ts (WS03 owns both). WS09 cannot edit them, so each
// hook is one call the owner adds; the council path (api/council.ts) already uses the same pieces.
//
//   1. Before selection:      const sealed = await sealedForRequest(ctx, c, key, body);
//                             then, when sealed, route with prefs.lane = "attested" (as the council does).
//   2. After selectTargets:   if (sealed) targets = sealedTargets(ctx, targets);           // 409 sealed_unavailable
//      and map a lane refusal: catch (e) { throw sealed ? asSealedError(e) : e }
//   3. After finalize:        headers[RECEIPT_HEADER] = (await singleCallReceipt(ctx, {...})).header;

export { RECEIPT_HEADER, SEALED_HEADER };

const clockOf = (ctx: Ctx): SealedClock => ({ now: Date.now(), maxAgeMs: ctx.cfg.attestation.intervalMs * 3, production: ctx.cfg.production });

/** Whether this request is sealed: model `anonymo-sealed`, `x-anonymo-sealed: required`, or a `sealed_only` key. */
export async function sealedForRequest(ctx: Ctx, c: Context, key: { keyHash: string } | null, body: Record<string, unknown>): Promise<boolean> {
  const explicit = sealedRequired({ model: body.model, models: body.models, header: c.req.header(SEALED_HEADER) });
  return explicit || await keySealedOnly(ctx.db, key?.keyHash);
}

/** Keep only attested, fresh routes; 409 sealed_unavailable when none is left. Never adds a route. */
export function sealedTargets(ctx: Ctx, targets: RouteTarget[]): RouteTarget[] {
  const clock = clockOf(ctx);
  const kept = targets.map((t) => ({ ...t, ordered: sealedFilter(t.ordered, candidateState, clock) })).filter((t) => t.ordered.length > 0);
  assertSealedSeats([{ seat: "request", routes: kept.flatMap((t) => t.ordered) }], candidateState, clock);
  return kept;
}

/** A lane refusal (no attested endpoint) on a sealed request, reported as 409 sealed_unavailable. */
export function asSealedError(e: unknown): unknown {
  if (isApiError(e) && (e.status === 409 || e.status === 503) && e.type !== "sealed_unavailable")
    return sealedUnavailable("No attested route with a fresh verified attestation can serve this sealed request. Nothing was sent or charged.", { reason: e.type, ...(e.metadata ?? {}) });
  return e;
}

/**
 * Issue the Anonymo receipt for a single call (and its refusal retry, if any): every route touched, in order, each with
 * what it was charged. Returns the header value for `x-anonymo-receipt`.
 */
export async function singleCallReceipt(
  ctx: Ctx,
  o: {
    requestId: string;
    modelId: string;
    sealed: boolean;
    refused: boolean;
    attempts: { candidate: Candidate; model: ModelRow; role?: RouteRole; status: RouteStatus; tokens: { in: number; out: number }; charged: Pico; callReceiptId?: string | null }[];
  },
) {
  const clock = clockOf(ctx);
  const routes = o.attempts.map((a, i) =>
    receiptRoute({
      candidate: a.candidate as never,
      model: a.model,
      role: a.role ?? (i === 0 ? "single" : "retry"),
      status: a.status,
      attested: attestationFresh(a.candidate, clock.maxAgeMs, clock.production),
      sealed: o.sealed,
      tokens: a.tokens,
      charged: a.charged,
      callReceiptId: a.callReceiptId,
      weightsHash: weightsHashFor(ctx, a.model, a.candidate),
    }),
  );
  const charged = o.attempts.reduce((s, a) => s + a.charged, 0n);
  return issueAnonymoReceipt(ctx, buildAnonymoReceipt({ requestId: o.requestId, modelId: o.modelId, routes, charged, refused: o.refused, sealed: o.sealed }));
}

// ---- Wiring for api/chat.ts (single calls) -------------------------------------------------------------------------

/** A sealed request is served on the attested lane (attested retention, fresh attestation), never on the public one. */
export function sealedLane<D extends { max: string; lane: string }>(sealed: boolean, disc: D): D {
  return sealed && disc.lane === "public" ? { ...disc, max: "none", lane: "attested" } : disc;
}

/**
 * Selection for a sealed request: a lane refusal becomes 409 sealed_unavailable, and only attested, fresh routes are
 * kept (409 when none is left). Not sealed: the selection unchanged.
 */
export function sealedSelection<T extends { targets: RouteTarget[] }>(ctx: Ctx, sealed: boolean, plan: () => T): T {
  if (!sealed) return plan();
  let sel: T;
  try {
    sel = plan();
  } catch (e) {
    throw asSealedError(e);
  }
  return { ...sel, targets: sealedTargets(ctx, sel.targets) };
}

/**
 * The Anonymo receipt for a finished single call: every refused attempt (billed 0), then the route that served it with
 * what it was charged. Returns the signed receipt, its `x-anonymo-receipt` header value and the body field.
 */
export async function receiptForCall(
  ctx: Ctx,
  o: {
    r: { candidate: Candidate; model: ModelRow; refusal?: { refused: { candidate: Candidate; model: ModelRow }[]; served: "answer" | "refused" } };
    fin: { id: string; charged: Pico; usageJson: { prompt_tokens: number; completion_tokens: number } };
    modelId: string;
    sealed: boolean;
  },
) {
  const servedRefused = o.r.refusal?.served === "refused";
  const before = (o.r.refusal?.refused ?? []).slice(0, servedRefused ? -1 : undefined);
  const receipt = await singleCallReceipt(ctx, {
    requestId: o.fin.id,
    modelId: o.modelId,
    sealed: o.sealed,
    refused: servedRefused,
    attempts: [
      ...before.map((a) => ({ candidate: a.candidate, model: a.model, status: "refused" as const, tokens: { in: 0, out: 0 }, charged: 0n })),
      { candidate: o.r.candidate, model: o.r.model, status: servedRefused ? ("refused" as const) : ("ok" as const), tokens: { in: o.fin.usageJson.prompt_tokens, out: o.fin.usageJson.completion_tokens }, charged: o.fin.charged, callReceiptId: o.fin.id },
    ],
  });
  return { header: { [RECEIPT_HEADER]: receipt.header }, body: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id, alg: receipt.alg, leaf: receipt.leaf }, header_value: receipt.header };
}

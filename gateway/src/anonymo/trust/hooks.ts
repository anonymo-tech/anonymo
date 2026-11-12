import type { Context } from "hono";
import type { Ctx } from "../../context.ts";
import type { Candidate, ModelRow } from "../../catalog/catalog.ts";
import type { RouteTarget } from "../../router/execute.ts";
import { isApiError } from "../../lib/errors.ts";
import type { Pico } from "../../lib/money.ts";
import { attestationFresh } from "../../router/select.ts";
import { RECEIPT_HEADER, buildAnonymoReceipt, issueAnonymoReceipt, receiptRoute, type RouteRole, type RouteStatus } from "../../receipts/anonymo.ts";
import { SEALED_HEADER, assertSealedSeats, candidateState, sealedFilter, sealedRequired, sealedUnavailable, type SealedClock } from "./sealed.ts";
import { weightsHashFor } from "./stats.ts";

// Hooks for the single-call path in api/chat.ts and router/execute.ts (WS03 owns both). WS09 cannot edit them, so each
// hook is one call the owner adds; the council path (api/council.ts) already uses the same pieces.
//
//   1. Before selection:      const sealed = sealedForRequest(ctx, c, key, body);
//                             then, when sealed, route with prefs.lane = "attested" (as the council does).
//   2. After selectTargets:   if (sealed) targets = sealedTargets(ctx, targets);           // 409 sealed_unavailable
//      and map a lane refusal: catch (e) { throw sealed ? asSealedError(e) : e }
//   3. After finalize:        headers[RECEIPT_HEADER] = (await singleCallReceipt(ctx, {...})).header;

export { RECEIPT_HEADER, SEALED_HEADER };

const clockOf = (ctx: Ctx): SealedClock => ({ now: Date.now(), maxAgeMs: ctx.cfg.attestation.intervalMs * 3, production: ctx.cfg.production });

/** Whether this request is sealed: model `anonymo-sealed`, `x-anonymo-sealed: required`, or a `sealed_only` key. */
export function sealedForRequest(_ctx: Ctx, c: Context, key: object | null, body: Record<string, unknown>): boolean {
  return sealedRequired({ model: body.model, header: c.req.header(SEALED_HEADER), key });
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

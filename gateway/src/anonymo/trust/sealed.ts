// Sealed (Backend §4, §6, §8; AGENTS.md product rules): `anonymo-sealed`, the `x-anonymo-sealed: required` header, or a
// key with `sealed_only` runs ONLY on routes whose enclave attestation the router verified and still holds fresh.
// Every route a sealed request could touch is checked here: each council proposer and the aggregator included. When a
// seat has no such route the whole request fails with 409 sealed_unavailable before anything is held, sent or charged.
// Nothing is ever downgraded to a route that is not attested.
//
// The rule is a pure filter over route state (`sealedEligible`), so it can be property-tested against random
// provider states. services/attestor.ts re-verifies every attested route every ATTESTATION_INTERVAL_MS (10 minutes by
// default) and clears `attested` on a failure, which takes the route out of this filter at once.

import { createHash } from "node:crypto";
import { ApiError, fail } from "../../lib/errors.ts";

export const SEALED_MODEL = "anonymo-sealed";
export const SEALED_HEADER = "x-anonymo-sealed";
export const SEALED_UNAVAILABLE = "sealed_unavailable";

/** The state of one route that decides whether a sealed request may use it. */
export type SealedRouteState = {
  /** The provider claims an attested enclave and the router's last verification succeeded. */
  attested: boolean;
  /** Hash of the attestation report (quote) the router verified; null when it holds none. */
  attestationHash: string | null;
  attestedAt: Date | null;
  /** "tdx", "sev-snp", "nvidia-cc", ... or "dev" for development evidence. */
  teeKind: string | null;
  /** The offer and its provider are live. */
  live: boolean;
};

export type SealedClock = { now: number; maxAgeMs: number; production: boolean };

/**
 * True only for a live route with a verified, fresh, non-simulated (in production) attestation. Any missing piece is a
 * no: a route is never assumed attested.
 */
export function sealedEligible(r: SealedRouteState, clock: SealedClock): boolean {
  if (!r.live || r.attested !== true) return false;
  if (!r.attestationHash || !r.teeKind || !(r.attestedAt instanceof Date)) return false;
  if (clock.production && r.teeKind === "dev") return false;
  const age = clock.now - r.attestedAt.getTime();
  return Number.isFinite(age) && age >= 0 && age <= clock.maxAgeMs;
}

/** The routes of `routes` a sealed request may use, in their original order. */
export function sealedFilter<T>(routes: readonly T[], state: (t: T) => SealedRouteState, clock: SealedClock): T[] {
  return routes.filter((t) => sealedEligible(state(t), clock));
}

export function sealedUnavailable(message: string, metadata: Record<string, unknown> = {}): ApiError {
  return new ApiError(409, message, SEALED_UNAVAILABLE, { sealed: true, ...metadata });
}

/**
 * Throws 409 sealed_unavailable unless every seat (a proposer, the aggregator, or a single call) has at least one sealed
 * route AND every route listed for it is sealed. Callers pass every route that may be attempted for each seat.
 */
export function assertSealedSeats<T>(seats: { seat: string; routes: readonly T[] }[], state: (t: T) => SealedRouteState, clock: SealedClock): void {
  for (const s of seats) {
    if (!s.routes.length) throw sealedUnavailable(`No attested route with a fresh verified attestation can serve the ${s.seat} of this sealed request. Nothing was sent or charged.`, { seat: s.seat, reason: "none_attested" });
    if (!s.routes.every((r) => sealedEligible(state(r), clock)))
      throw sealedUnavailable(`A route planned for the ${s.seat} of this sealed request is not attested and fresh. Nothing was sent or charged.`, { seat: s.seat, reason: "not_attested" });
  }
}

/** The attested state of a catalog candidate (an offer with its provider row). */
export function candidateState(c: { status?: string | null; provider: { status?: string | null; attested?: boolean | null; attestationHash?: string | null; attestedAt?: Date | null; teeKind?: string | null } }): SealedRouteState {
  return {
    attested: c.provider.attested === true,
    attestationHash: c.provider.attestationHash ?? null,
    attestedAt: c.provider.attestedAt ?? null,
    teeKind: c.provider.teeKind ?? null,
    live: (c.status ?? "live") === "live" && (c.provider.status ?? "live") === "live",
  };
}

type KeyLike = object | null | undefined;

/** Whether the key carries `sealed_only` (WS05 keeps it on the key row or in its caps). Absent means no. */
export function keySealedOnly(key: KeyLike): boolean {
  if (!key) return false;
  const k = key as Record<string, unknown>;
  const caps = (k.caps && typeof k.caps === "object" ? k.caps : {}) as Record<string, unknown>;
  return k.sealedOnly === true || k.sealed_only === true || caps.sealed_only === true || caps.sealedOnly === true;
}

/**
 * Whether this request must be sealed. The header accepts only "required" (any other value is a 400, so a typo never
 * silently runs unsealed).
 */
export function sealedRequired(o: { model?: unknown; header?: string | null; key?: KeyLike; councilSealed?: unknown }): boolean {
  const h = o.header?.trim().toLowerCase();
  if (h && h !== "required") fail(400, `\`${SEALED_HEADER}\` accepts only "required".`, "invalid_request");
  return o.model === SEALED_MODEL || h === "required" || keySealedOnly(o.key) || o.councilSealed === true;
}

/**
 * The receipt's `attestation_quote_hash` for the routes a sealed call used: the verified quote hash itself for one
 * route, else sha256 over the routes' quote hashes in receipt order (each is also listed on its route).
 */
export function attestationQuoteHash(hashes: string[]): string | null {
  if (!hashes.length || hashes.some((h) => !h)) return null;
  if (hashes.length === 1) return hashes[0];
  return createHash("sha256").update(hashes.join("\n")).digest("hex");
}

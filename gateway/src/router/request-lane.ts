import type { Context } from "hono";
import { resolveDisclosureRequest, type DisclosureRequest } from "./disclosure.ts";

// The lanes a request can be served on. Anonymo serves two:
//
//   public    any endpoint
//   attested  only endpoints with a fresh, verified attestation (the sealed tier builds on this)
//
// Anonymo's third lane, "unlinkable" (Oblivious HTTP or Tor plus blind tokens), was removed with those modules.
// Asking for it is refused with 501 lane_not_available before anything is priced or sent (router/disclosure.ts).

/**
 * Resolve the lane and disclosure ceiling of a request from `provider.lane`, `provider.disclosure` and the lane and
 * disclosure-max headers, the stricter winning.
 */
export function requestLane(c: Context, provider: Record<string, unknown> | undefined): DisclosureRequest {
  return resolveDisclosureRequest(provider, { disclosureMax: c.req.header("x-anonymo-disclosure-max"), lane: c.req.header("x-anonymo-lane") }, { unlinkable: false });
}

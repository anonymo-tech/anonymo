// Edge glue for region rules. The edge (Cloudflare or our own proxy) sets the visitor's region in request headers and
// MUST overwrite any client-supplied copy of them; the gateway trusts them only behind that edge (origin lock:
// ORIGIN_LOCK_ENABLED and ORIGIN_LOCK_SECRET, src/hardening, refuse requests that skipped the edge).
// Cloudflare's headers win over `x-anonymo-region`: Cloudflare overwrites cf-ipcountry but passes a client's own
// x-anonymo-region through untouched, so that header is read only when no Cloudflare country is present. Our own edge,
// if used instead of Cloudflare, must strip cf-* headers.
// Only the region code is read here. No IP address is read, stored or logged.
//
// Mounting: `app.use("*", regionMiddleware(rules))` must run before the chat and media routes, so it belongs in
// src/app.ts (WS01). WS06 calls `regionPolicyOf(c, rules).explicitMediaAllowed` before any explicit image or video.

import type { Context, MiddlewareHandler } from "hono";
import type { RegionPolicy, RegionRules } from "../seams.ts";

export type RegionHeaders = { country: string; subdivision: string };
/** Cloudflare's visitor-location headers. `x-anonymo-region` ("US-TX") is accepted from our own edge, only when no
 *  Cloudflare country is present. */
export const DEFAULT_REGION_HEADERS: RegionHeaders = { country: "cf-ipcountry", subdivision: "cf-region-code" };

export function regionCodeOf(headers: Headers, names: RegionHeaders = DEFAULT_REGION_HEADERS): string | null {
  const country = headers.get(names.country)?.trim();
  if (!country) return headers.get("x-anonymo-region")?.trim() || null;
  const sub = headers.get(names.subdivision)?.trim();
  return sub && /^[A-Za-z0-9]{1,3}$/.test(sub) ? `${country}-${sub}` : country;
}

export const regionPolicyOf = (c: Context, rules: RegionRules, names?: RegionHeaders): RegionPolicy => rules.forCountry(regionCodeOf(c.req.raw.headers, names));

/** Liveness and readiness checks carry no location (Railway's health check comes from inside), and serve no content. */
const UNGATED = new Set(["/health", "/ready"]);

/** Refuses requests from blocked regions with 451 before any route runs. Nothing about the request is recorded. */
export function regionMiddleware(rules: RegionRules, names?: RegionHeaders): MiddlewareHandler {
  return async (c, next) => {
    if (!UNGATED.has(c.req.path) && regionPolicyOf(c, rules, names).blocked)
      return c.json({ error: { code: 451, message: "Anonymo is not available in this region.", type: "region_blocked" } }, 451);
    await next();
  };
}

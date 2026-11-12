// Region rules for media. WS02 owns the real RegionRules (gateway/src/anonymo/region/) and is writing it in
// parallel; until it lands on ctx.anonymo, media uses this placeholder, which is injectable and conservative:
//   - OFAC comprehensively sanctioned regions are blocked outright (list below, plus ANONYMO_REGION_BLOCKED);
//   - explicit images and video are off in countries listed in ANONYMO_EXPLICIT_MEDIA_OFF (default GB), and off when
//     the edge sent no country at all. US states that require age verification cannot be told apart from an ISO
//     country code alone; WS02's rules decide that, from whatever the edge passes.
// The edge passes a country code only (header below); the client address is never read or stored here. The header
// must be set by the edge and stripped from client requests (WS10), or a client could pick its own region.

import type { Context } from "hono";
import type { RegionPolicy, RegionRules } from "../seams.ts";

export const COUNTRY_HEADER = "x-anonymo-country";
// Cuba, Iran, North Korea, Syria; Crimea and the other occupied regions of Ukraine have no ISO code of their own, so
// the edge must map them (WS02).
const OFAC_DEFAULT = ["CU", "IR", "KP", "SY"];
const EXPLICIT_OFF_DEFAULT = ["GB"];

const list = (v: string | undefined, fallback: string[]) =>
  new Set((v ? v.split(",") : fallback).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s)));

export function placeholderRegionRules(env: Record<string, string | undefined> = {}): RegionRules {
  const blocked = new Set([...OFAC_DEFAULT, ...list(env.ANONYMO_REGION_BLOCKED, [])]);
  const explicitOff = list(env.ANONYMO_EXPLICIT_MEDIA_OFF, EXPLICIT_OFF_DEFAULT);
  return {
    forCountry(iso2): RegionPolicy {
      const cc = iso2?.trim().toUpperCase() ?? null;
      if (!cc || !/^[A-Z]{2}$/.test(cc)) return { blocked: false, explicitMediaAllowed: false };
      return { blocked: blocked.has(cc), explicitMediaAllowed: !blocked.has(cc) && !explicitOff.has(cc) };
    },
  };
}

export const countryOf = (c: Context): string | null => {
  const v = c.req.header(COUNTRY_HEADER)?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) ? v : null;
};

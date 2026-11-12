// Region rules (Overview §6, Backend §10): block OFAC-sanctioned regions, and switch explicit images and video off
// where adult-content age verification is legally required, instead of adding KYC. Text stays available there.
//
// The input is a region code only: ISO 3166-1 alpha-2 ("GB") or ISO 3166-2 ("US-TX", "UA-43"), as the edge reports it.
// This module never sees an IP address.
//
// The default lists are a starting point for counsel, not legal advice. Override them per deployment:
//   ANONYMO_OFAC_REGIONS               comma list replacing DEFAULT_OFAC_REGIONS
//   ANONYMO_AGE_VERIFICATION_REGIONS   comma list replacing DEFAULT_AGE_VERIFICATION_REGIONS
//   ANONYMO_REGION_UNKNOWN             restrict (default) | allow: explicit media when the region is unknown

import type { RegionPolicy, RegionRules } from "../seams.ts";

/** Comprehensively sanctioned jurisdictions and occupied regions. SY is kept conservatively although the US program
 *  was lifted in 2025; drop it only on counsel's advice. */
export const DEFAULT_OFAC_REGIONS = ["CU", "IR", "KP", "SY", "UA-43", "UA-40", "UA-14", "UA-09"] as const;

/** The UK (Online Safety Act) and US states with adult-content age-verification laws in force. A country entry ("GB")
 *  covers all of it; a subdivision entry ("US-TX") covers that state. For a country that has subdivision entries, a
 *  request without a known subdivision is treated as covered (fail closed). */
export const DEFAULT_AGE_VERIFICATION_REGIONS = [
  "GB",
  ...["AL", "AR", "AZ", "FL", "GA", "ID", "IN", "KS", "KY", "LA", "MO", "MS", "MT", "NC", "ND", "NE", "OH", "OK", "SC", "SD", "TN", "TX", "UT", "VA", "WY"].map((s) => `US-${s}`),
] as const;

const CODE = /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?$/;
const UNKNOWN = new Set(["XX", "T1", "ZZ"]); // Cloudflare's unknown and Tor markers

export type RegionConfig = { ofac: readonly string[]; ageVerification: readonly string[]; unknownExplicitMedia: "restrict" | "allow" };

export function parseRegion(code: string | null | undefined): { country: string; subdivision: string | null } | null {
  if (typeof code !== "string") return null;
  const m = CODE.exec(code.trim().toUpperCase());
  if (!m || UNKNOWN.has(m[1])) return null;
  return { country: m[1], subdivision: m[2] ?? null };
}

const parseList = (v: unknown, name: string): string[] | undefined => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const items = v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const i of items) if (!CODE.test(i)) throw new Error(`${name}: "${i}" is not an ISO 3166 code`);
  return items;
};

export function regionConfigFromEnv(env: Record<string, unknown>): RegionConfig {
  const unknown = typeof env.ANONYMO_REGION_UNKNOWN === "string" ? env.ANONYMO_REGION_UNKNOWN.trim().toLowerCase() : "";
  if (unknown && unknown !== "restrict" && unknown !== "allow") throw new Error("ANONYMO_REGION_UNKNOWN must be restrict or allow");
  return {
    ofac: parseList(env.ANONYMO_OFAC_REGIONS, "ANONYMO_OFAC_REGIONS") ?? [...DEFAULT_OFAC_REGIONS],
    ageVerification: parseList(env.ANONYMO_AGE_VERIFICATION_REGIONS, "ANONYMO_AGE_VERIFICATION_REGIONS") ?? [...DEFAULT_AGE_VERIFICATION_REGIONS],
    unknownExplicitMedia: (unknown || "restrict") as RegionConfig["unknownExplicitMedia"],
  };
}

export function createRegionRules(config: RegionConfig): RegionRules {
  const ofac = new Set(config.ofac);
  const av = new Set(config.ageVerification);
  const avCountriesWithStates = new Set([...av].filter((c) => c.includes("-")).map((c) => c.slice(0, 2)));
  return {
    forCountry(code: string | null): RegionPolicy {
      const r = parseRegion(code);
      if (!r) return { blocked: false, explicitMediaAllowed: config.unknownExplicitMedia === "allow" };
      const full = r.subdivision ? `${r.country}-${r.subdivision}` : null;
      const blocked = ofac.has(r.country) || (full !== null && ofac.has(full));
      const ageGated = av.has(r.country) || (full !== null ? av.has(full) : avCountriesWithStates.has(r.country));
      return { blocked, explicitMediaAllowed: !blocked && !ageGated };
    },
  };
}

export const regionRulesFromEnv = (env: Record<string, unknown>) => createRegionRules(regionConfigFromEnv(env));

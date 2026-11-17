// Region rules (Overview §6, Backend §10): block OFAC-sanctioned regions, and switch explicit images and video off
// where adult-content age verification is legally required, instead of adding KYC. Text stays available there.
//
// The input is a region code only: ISO 3166-1 alpha-2 ("GB") or ISO 3166-2 ("US-TX", "UA-43"), as the edge reports it.
// This module never sees an IP address.
//
// The default lists are a starting point for counsel, not legal advice. They err on the side of caution: with no age
// verification at all, every region whose rules plausibly reach explicit adult text or AI chat is blocked outright
// (the age-verification list only switches explicit images and video off, which does nothing for text). Research
// behind the lists: docs/legal/region-defaults.md. Override them per deployment:
//   ANONYMO_OFAC_REGIONS               comma list replacing DEFAULT_OFAC_REGIONS
//   ANONYMO_REGION_BLOCKED             comma list replacing DEFAULT_BLOCKED_REGIONS ("none" for an empty list)
//   ANONYMO_AGE_VERIFICATION_REGIONS   comma list replacing DEFAULT_AGE_VERIFICATION_REGIONS
//   ANONYMO_REGION_UNKNOWN             restrict (default) | allow: explicit media when the region is unknown
//   ANONYMO_REGION_UNKNOWN_TEXT        block | allow: everything when the region is unknown (no header, Tor). Default
//                                      block in production, allow elsewhere

import type { RegionPolicy, RegionRules } from "../seams.ts";

/** Comprehensively sanctioned jurisdictions and occupied regions. SY is kept conservatively although the US program
 *  was lifted in 2025; drop it only on counsel's advice. */
export const DEFAULT_OFAC_REGIONS = ["CU", "IR", "KP", "SY", "UA-43", "UA-40", "UA-14", "UA-09", "UA-23", "UA-65"] as const;

/** Blocked for legal caution while there is no age verification (research, November 2026):
 *  - sanctions exposure and pornography bans: RU, BY;
 *  - pornography illegal or blocked nationally (several entries weakly sourced, kept out of caution);
 *  - rules that plausibly cover adult text or AI chat without real age checks: GB, FR, DE, AU, BR;
 *  - US states with adult-content age-verification laws (27), plus CA and CO, whose companion-chatbot laws require
 *    age determination or estimation from 1 January 2027. */
export const DEFAULT_BLOCKED_REGIONS = [
  "RU", "BY",
  "SA", "AE", "QA", "OM", "KW", "BH", "YE", "IQ", "ID", "BD", "TR", "MA", "DJ", "UG", "TZ", "BW", "PK", "IN", "KR", "CN",
  "EG", "LY", "SD", "SO", "ER", "ET", "BF", "GQ", "AF", "NP", "VN", "TH", "UZ", "MY", "BN", "TM", "TJ", "MM",
  "GB", "FR", "DE", "AU", "BR",
  ...["AL", "AR", "AZ", "FL", "GA", "IA", "ID", "IN", "KS", "KY", "LA", "MO", "MS", "MT", "NC", "ND", "NE", "OH", "OK", "SC", "SD", "TN", "TX", "UT", "VA", "WV", "WY", "CA", "CO"].map((s) => `US-${s}`),
] as const;

/** The UK (Online Safety Act) and US states with adult-content age-verification laws in force. A country entry ("GB")
 *  covers all of it; a subdivision entry ("US-TX") covers that state. For a country that has subdivision entries, a
 *  request without a known subdivision is treated as covered (fail closed). */
export const DEFAULT_AGE_VERIFICATION_REGIONS = [
  "GB",
  ...["AL", "AR", "AZ", "FL", "GA", "IA", "ID", "IN", "KS", "KY", "LA", "MO", "MS", "MT", "NC", "ND", "NE", "OH", "OK", "SC", "SD", "TN", "TX", "UT", "VA", "WV", "WY"].map((s) => `US-${s}`),
] as const;

const CODE = /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?$/;
const UNKNOWN = new Set(["XX", "T1", "ZZ"]); // Cloudflare's unknown and Tor markers

export type RegionConfig = { ofac: readonly string[]; blocked?: readonly string[]; ageVerification: readonly string[]; unknownExplicitMedia: "restrict" | "allow"; unknownText?: "block" | "allow" };

export function parseRegion(code: string | null | undefined): { country: string; subdivision: string | null } | null {
  if (typeof code !== "string") return null;
  const m = CODE.exec(code.trim().toUpperCase());
  if (!m || UNKNOWN.has(m[1])) return null;
  return { country: m[1], subdivision: m[2] ?? null };
}

const parseList = (v: unknown, name: string): string[] | undefined => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  if (v.trim().toLowerCase() === "none") return [];
  const items = v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const i of items) if (!CODE.test(i)) throw new Error(`${name}: "${i}" is not an ISO 3166 code`);
  return items;
};

export function regionConfigFromEnv(env: Record<string, unknown>): RegionConfig {
  const unknown = typeof env.ANONYMO_REGION_UNKNOWN === "string" ? env.ANONYMO_REGION_UNKNOWN.trim().toLowerCase() : "";
  if (unknown && unknown !== "restrict" && unknown !== "allow") throw new Error("ANONYMO_REGION_UNKNOWN must be restrict or allow");
  const unknownText = typeof env.ANONYMO_REGION_UNKNOWN_TEXT === "string" ? env.ANONYMO_REGION_UNKNOWN_TEXT.trim().toLowerCase() : "";
  if (unknownText && unknownText !== "block" && unknownText !== "allow") throw new Error("ANONYMO_REGION_UNKNOWN_TEXT must be block or allow");
  return {
    ofac: parseList(env.ANONYMO_OFAC_REGIONS, "ANONYMO_OFAC_REGIONS") ?? [...DEFAULT_OFAC_REGIONS],
    blocked: parseList(env.ANONYMO_REGION_BLOCKED, "ANONYMO_REGION_BLOCKED") ?? [...DEFAULT_BLOCKED_REGIONS],
    unknownText: (unknownText || (env.ANONYMO_ENV === "production" ? "block" : "allow")) as "block" | "allow",
    ageVerification: parseList(env.ANONYMO_AGE_VERIFICATION_REGIONS, "ANONYMO_AGE_VERIFICATION_REGIONS") ?? [...DEFAULT_AGE_VERIFICATION_REGIONS],
    unknownExplicitMedia: (unknown || "restrict") as RegionConfig["unknownExplicitMedia"],
  };
}

export function createRegionRules(config: RegionConfig): RegionRules {
  const ofac = new Set(config.ofac);
  const legal = new Set(config.blocked ?? []);
  const av = new Set(config.ageVerification);
  const statesOf = (set: Set<string>) => new Set([...set].filter((c) => c.includes("-")).map((c) => c.slice(0, 2)));
  const avCountriesWithStates = statesOf(av);
  const legalCountriesWithStates = statesOf(legal);
  return {
    forCountry(code: string | null): RegionPolicy {
      const r = parseRegion(code);
      if (!r) return config.unknownText === "block" ? { blocked: true, explicitMediaAllowed: false } : { blocked: false, explicitMediaAllowed: config.unknownExplicitMedia === "allow" };
      const full = r.subdivision ? `${r.country}-${r.subdivision}` : null;
      // A country with blocked subdivisions and no known subdivision is blocked (fail closed), like the age list below.
      const blocked =
        ofac.has(r.country) || (full !== null && ofac.has(full)) || legal.has(r.country) || (full !== null ? legal.has(full) : legalCountriesWithStates.has(r.country));
      const ageGated = av.has(r.country) || (full !== null ? av.has(full) : avCountriesWithStates.has(r.country));
      return { blocked, explicitMediaAllowed: !blocked && !ageGated };
    },
  };
}

export const regionRulesFromEnv = (env: Record<string, unknown>) => createRegionRules(regionConfigFromEnv(env));

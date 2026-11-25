import { eq, like, or } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { parseRegion, parseRegionList, regionConfigFromEnv } from "./rules.ts";
import { regionPolicy, type RegionMode } from "./schema.ts";

type Policy = { mode: RegionMode; disclosure_interval_min: number | null };
const defaults = regionConfigFromEnv({});
const rank: Record<RegionMode, number> = { allowed: 0, proof_required: 1, blocked: 2 };

function listMode(region: string, config: ReturnType<typeof regionConfigFromEnv>): RegionMode {
  if (config.ofac.includes(region)) return "blocked";
  if (config.ageVerification.includes(region)) return "proof_required";
  return config.blocked?.includes(region) ? "blocked" : "allowed";
}

export function createRegionPolicy(db: Db, env: Record<string, unknown>) {
  const config = regionConfigFromEnv(env);
  const blocked = parseRegionList(env.ANONYMO_REGION_BLOCKED, "ANONYMO_REGION_BLOCKED");
  const proof = parseRegionList(env.ANONYMO_AGE_VERIFICATION_REGIONS, "ANONYMO_AGE_VERIFICATION_REGIONS");
  const envRegions = [...new Set([...config.ofac, ...(blocked ?? []), ...(proof ?? [])])];

  function modeFor(region: string, stored: RegionMode): RegionMode {
    if (config.ofac.includes(region) || blocked?.includes(region)) return "blocked";
    if (proof?.includes(region)) return "proof_required";
    // An explicit replacement can remove the corresponding legacy seed without discarding unrelated table policy.
    const seeded = listMode(region, defaults);
    return stored === seeded ? listMode(region, config) : stored;
  }

  async function forSignal(signal: string | null): Promise<Policy> {
    const code = parseRegion(signal);
    if (!code) return { mode: config.unknownText === "block" ? "blocked" : "allowed", disclosure_interval_min: null };
    const { country, subdivision } = code;
    const full = subdivision ? `${country}-${subdivision}` : null;
    const matches = (region: string) => region === country || (full ? region === full : region.startsWith(`${country}-`));
    const rows = await db.select().from(regionPolicy).where(or(
      eq(regionPolicy.region, country),
      full ? eq(regionPolicy.region, full) : like(regionPolicy.region, `${country}-%`),
    ));
    let mode: RegionMode = "allowed";
    let interval = Infinity;
    for (const row of rows) {
      const effective = modeFor(row.region, row.mode);
      if (rank[effective] > rank[mode]) mode = effective;
      interval = Math.min(interval, row.disclosureIntervalMin ?? Infinity);
    }
    for (const region of envRegions.filter(matches)) {
      const effective = modeFor(region, "allowed");
      if (rank[effective] > rank[mode]) mode = effective;
    }
    return { mode, disclosure_interval_min: Number.isFinite(interval) ? interval : null };
  }

  // A declaration can tighten access or the disclosure interval, even when the edge reports a different region.
  return async (edge: string | null, declared: string | null): Promise<Policy> => {
    const policy = await forSignal(edge);
    if (!declared) return policy;
    const declaration = await forSignal(declared);
    const interval = Math.min(policy.disclosure_interval_min ?? Infinity, declaration.disclosure_interval_min ?? Infinity);
    return {
      mode: rank[declaration.mode] > rank[policy.mode] ? declaration.mode : policy.mode,
      disclosure_interval_min: Number.isFinite(interval) ? interval : null,
    };
  };
}

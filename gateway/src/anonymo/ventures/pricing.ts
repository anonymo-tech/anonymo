// WS11 · prices, tiers and what each tier unlocks (Ventures Overview §5 and §6).
//
// A run costs a fixed USDG price, all usage included up to that price: the price funds the run's own crew key (see
// money.ts), whose lifetime cap is that price, so the crew can never spend more. Refused attempts stay free, as today.
// Paying in $NYMO through the Checkout contract costs 25% less, and that $NYMO is burned.

import type { Tier, VentureMode } from "./types.ts";

export type RunPrice = { mode: VentureMode; usd: number; nymoDiscountPct: number; includes: string };

export const NYMO_DISCOUNT_PCT = 25;

export const PRICES: Record<Exclude<VentureMode, "RUN">, RunPrice> = {
  IDEA_TO_LIVE: { mode: "IDEA_TO_LIVE", usd: 79, nymoDiscountPct: NYMO_DISCOUNT_PCT, includes: "MVP, landing page, ad kit, launch plan" },
  DUPE_DROP: { mode: "DUPE_DROP", usd: 99, nymoDiscountPct: NYMO_DISCOUNT_PCT, includes: "1 store, up to 25 products, ad kit" },
  BUILD_BETTER: { mode: "BUILD_BETTER", usd: 149, nymoDiscountPct: NYMO_DISCOUNT_PCT, includes: "Parity+ matrix, rebuilt core flows, comparison page" },
  TAKEOVER: { mode: "TAKEOVER", usd: 49, nymoDiscountPct: NYMO_DISCOUNT_PCT, includes: "Comparison pages, switch offer, import tool, 30 ads" },
  // Not priced in the Overview's table; set here at the Idea to Live price because the work is the same size (a repo
  // in, a rebranded repo out). Change it with the founder.
  FORK_FLIP: { mode: "FORK_FLIP", usd: 79, nymoDiscountPct: NYMO_DISCOUNT_PCT, includes: "Licence report, rebranded fork or clean-room plan, repo" },
};

/** Run Mode: a daily fee plus usage, under a hard daily cap the owner sets. */
export const RUN_MODE = { dailyFeeUsd: 5, minDailyCapUsd: 6, maxDailyCapUsd: 500 } as const;

/** Share of each step's budget: the per-step cap is total × this, so one step can't eat the run. */
export const PER_STEP_SHARE = 0.35;

// ---- no-loss rules ------------------------------------------------------------------------------------------------
// Model calls are billed at the provider's price plus at most 1% (router/pricing.ts), sandbox minutes and deploys at
// configured rates that must sit above their real cost. So the crew's spend is the run's real cost, and a run can't
// lose money as long as that spend stays under what the run brought in. The crew may spend at most 80% of the price
// (the workers' share of the 80/10/5/5 split); the other 20% is margin: 5% funds the Build Fuel pool (the stakers'
// credits), 15% stays with the house. Refused attempts, which the caller isn't billed for but the provider still
// charges, count against the 80% too.

/** The crew's budget as a share of the price, in basis points. */
export const CREW_BUDGET_BPS = 8_000n;
/** The share of a finished run's price that funds the Build Fuel pool, in basis points. */
export const FUEL_POOL_BPS = 500n;
export const crewBudgetOf = (price: bigint) => (price * CREW_BUDGET_BPS) / 10_000n;
export const crewBudgetUsd = (priceUsd: number) => (priceUsd * Number(CREW_BUDGET_BPS)) / 10_000;

/** What one static deploy (two pins and an Arweave copy) is charged to the run's budget. Keep it above the real cost. */
export const deployCostUsd = (env: Record<string, string | undefined> = process.env) => Number(env.VENTURES_DEPLOY_COST_USD ?? 0.5);
/** The most Build Fuel one wallet can spend in a UTC day, whatever it has locked. */
export const fuelWalletDailyCapUsd = (env: Record<string, string | undefined> = process.env) => Number(env.VENTURES_FUEL_WALLET_DAILY_USD ?? 25);

export type TierRules = {
  tier: Tier;
  stakeNymo: number;
  builders: number;
  families: number;
  modes: VentureMode[];
  runModeHoursPerDay: number;
  recipeSelling: boolean;
  sealedRoutes: boolean;
  apiAndMcp: boolean;
};

export const TIER_RULES: Record<Tier, TierRules> = {
  solo: { tier: "solo", stakeNymo: 0, builders: 1, families: 1, modes: ["IDEA_TO_LIVE", "DUPE_DROP", "FORK_FLIP"], runModeHoursPerDay: 0, recipeSelling: false, sealedRoutes: false, apiAndMcp: false },
  crew: { tier: "crew", stakeNymo: 50_000, builders: 3, families: 3, modes: ["IDEA_TO_LIVE", "DUPE_DROP", "FORK_FLIP", "BUILD_BETTER", "TAKEOVER", "RUN"], runModeHoursPerDay: 2, recipeSelling: false, sealedRoutes: false, apiAndMcp: false },
  gang: { tier: "gang", stakeNymo: 250_000, builders: 5, families: 5, modes: ["IDEA_TO_LIVE", "DUPE_DROP", "FORK_FLIP", "BUILD_BETTER", "TAKEOVER", "RUN"], runModeHoursPerDay: 12, recipeSelling: true, sealedRoutes: false, apiAndMcp: false },
  syndicate: { tier: "syndicate", stakeNymo: 1_000_000, builders: 8, families: 8, modes: ["IDEA_TO_LIVE", "DUPE_DROP", "FORK_FLIP", "BUILD_BETTER", "TAKEOVER", "RUN"], runModeHoursPerDay: 24, recipeSelling: true, sealedRoutes: true, apiAndMcp: true },
};

export const tierAllows = (tier: Tier, mode: VentureMode) => TIER_RULES[tier].modes.includes(mode);

/** The tier a 7-day average stake reaches (thresholds are the timelocked starting values). */
export function tierForStake(stakeNymo: number): Tier {
  if (stakeNymo >= TIER_RULES.syndicate.stakeNymo) return "syndicate";
  if (stakeNymo >= TIER_RULES.gang.stakeNymo) return "gang";
  if (stakeNymo >= TIER_RULES.crew.stakeNymo) return "crew";
  return "solo";
}

export function priceOf(mode: VentureMode): number {
  if (mode === "RUN") return RUN_MODE.dailyFeeUsd;
  return PRICES[mode].usd;
}

/** The public price list, as the dashboard and GET /v1/ventures/pricing show it. */
export function priceList() {
  return {
    currency: "USDG",
    runs: Object.values(PRICES).map((p) => ({ ...p, nymoUsdEquivalent: +(p.usd * (1 - p.nymoDiscountPct / 100)).toFixed(2) })),
    runMode: { ...RUN_MODE, note: "From $5 a day plus usage, under a hard daily cap you set." },
    refusedAttemptsUsd: 0,
    tiers: Object.values(TIER_RULES),
  };
}

// WS11 · crew size by tier (Ventures Overview §5, Backend PART 10 CrewTiers, M6 "tier-aware fan-out").
//
// A key's tier comes from the CrewTiers contract: the 7-day time-weighted average stake of the wallet the key proved by
// SIWE (anonymo_keys.wallet). Until CrewTiers is deployed and configured (VENTURES_CREW_TIERS_ADDRESS), every key gets
// VENTURES_TIER_FALLBACK (default "crew"), because V1 ships Build Better before $NYMO tiers exist (Overview §8).
// Tiers are read through viem and cached for five minutes per wallet.

import { eq } from "drizzle-orm";
import type { Address, PublicClient } from "viem";
import type { Ctx } from "../../context.ts";
import { anonymoKeys } from "../deposits/schema.ts";
import { crewTiersAbi } from "./chain/abis.ts";
import { tierForStake } from "./pricing.ts";
import { TIERS, type Tier } from "./types.ts";

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { tier: Tier; twab: number; at: number }>();

export type TierReader = (wallet: Address) => Promise<{ tier: Tier; twabNymo: number }>;

export function fallbackTier(env: Record<string, string | undefined> = process.env): Tier {
  const t = env.VENTURES_TIER_FALLBACK?.trim().toLowerCase();
  return (TIERS as readonly string[]).includes(t ?? "") ? (t as Tier) : "crew";
}

/** Reads CrewTiers on chain: tierOf() when the contract answers it, else the TWAB mapped through the thresholds. */
export function chainTierReader(client: PublicClient, address: Address): TierReader {
  return async (wallet) => {
    const twab = (await client.readContract({ address, abi: crewTiersAbi, functionName: "twabOf", args: [wallet] })) as bigint;
    const twabNymo = Number(twab / 10n ** 18n);
    let tier = tierForStake(twabNymo);
    try {
      const idx = Number(await client.readContract({ address, abi: crewTiersAbi, functionName: "tierOf", args: [wallet] }));
      if (TIERS[idx]) tier = TIERS[idx]!;
    } catch {
      /* the TWAB mapping stands */
    }
    return { tier, twabNymo };
  };
}

let override: TierReader | null = null;
/** Tests (and a deployment without the contract) can supply their own reader. */
export function setTierReader(r: TierReader | null) {
  override = r;
  cache.clear();
}

export async function tierOfKey(ctx: Ctx, keyHash: string): Promise<{ tier: Tier; source: "chain" | "fallback"; wallet: string | null; twabNymo: number | null }> {
  const [row] = await ctx.db.select({ wallet: anonymoKeys.wallet }).from(anonymoKeys).where(eq(anonymoKeys.keyHash, keyHash));
  const wallet = row?.wallet ?? null;
  const address = process.env.VENTURES_CREW_TIERS_ADDRESS as Address | undefined;
  const reader = override ?? (address && ctx.chain.client ? chainTierReader(ctx.chain.client, address) : null);
  if (!wallet || !reader) return { tier: fallbackTier(), source: "fallback", wallet, twabNymo: null };
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < TTL_MS) return { tier: hit.tier, source: "chain", wallet, twabNymo: hit.twab };
  try {
    const r = await reader(wallet as Address);
    cache.set(wallet, { tier: r.tier, twab: r.twabNymo, at: Date.now() });
    return { tier: r.tier, source: "chain", wallet, twabNymo: r.twabNymo };
  } catch {
    // The chain is unreachable: the key keeps the lowest tier rather than guessing a higher one.
    return { tier: "solo", source: "chain", wallet, twabNymo: null };
  }
}

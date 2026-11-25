import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";

export const DAY = 86_400n;
export const WINDOW = 7n * DAY;
export const CHAIN_ID = 4663;
export const PASS_DURATION_MS = 30 * Number(DAY) * 1000;
export const PASS_CHAT_LIMIT = 250;
export const PRODUCTS = {
  PASS30: { usd: 12, voiceSeconds: 3 * 3600, images: 300, council: false, party: 0 },
  PASS30_PLUS: { usd: 29, voiceSeconds: 15 * 3600, images: 1000, council: true, party: 6 },
} as const;
export type Sku = keyof typeof PRODUCTS;
export const skuBytes = (sku: Sku) => stringToHex(sku, { size: 32 });
export const orderIdFor = (checkout: Address, payer: Address, ref: Hex) => keccak256(encodeAbiParameters(
  [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
  [BigInt(CHAIN_ID), checkout, payer, ref],
));
export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

export const TIERS = ["Free", "Plus", "Pro", "Black"] as const;
export type Tier = typeof TIERS[number];
export type TierRule = { minTwab: bigint; dailyMicroUsd: bigint };
export type Checkpoint = { at: bigint; balance: bigint };

export function stakeAverage(checkpoints: readonly Checkpoint[], now: bigint) {
  const start = now - WINDOW;
  let since = start;
  let balance = 0n;
  let integral = 0n;
  for (const point of checkpoints) {
    if (point.at > now) break;
    if (point.at > since) {
      integral += balance * (point.at - since);
      since = point.at;
    }
    balance = point.balance;
  }
  return { balance, twab: (integral + balance * (now - since)) / WINDOW };
}

export function stakeTier(twab: bigint, table: readonly TierRule[]) {
  const index = table.findLastIndex((rule) => twab >= rule.minTwab);
  return { tier: TIERS[index + 1]!, dailyMicroUsd: table[index]?.dailyMicroUsd ?? 0n };
}

export function tierLimits(tier: Tier, pass?: Sku) {
  const level = TIERS.indexOf(tier);
  return {
    memoryItems: level === 3 ? null : level > 0 || pass ? 2048 : 512,
    dailyVoiceSeconds: level >= 2 ? 6 * 3600 : level === 1 ? 2 * 3600 : 0,
    partyPlayers: pass === "PASS30_PLUS" || level >= 2 ? 6 : level === 1 ? 4 : 0,
    council: pass === "PASS30_PLUS" || level >= 2,
    priority: level >= 2,
  };
}

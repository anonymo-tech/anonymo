// WS05 settings, read from the environment (all prefixed ANONYMO_). Every rail is off until configured.
// Secrets (BTCPay API key and webhook secret, TronGrid key) live only in memory and are never logged or returned.

import { z } from "zod";

const flag = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase() as `0x${string}`);
const json = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .optional()
    .transform((s, c) => {
      if (!s?.trim()) return undefined;
      try {
        return JSON.parse(s) as unknown;
      } catch {
        c.addIssue({ code: "custom", message: "must be JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema.optional());

export const EVM_CHAINS = ["base", "arbitrum", "rhc"] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];
export const STABLES = ["USDC", "USDT", "USDG"] as const;

const evmChainSchema = z.object({
  chain: z.enum(EVM_CHAINS),
  rpcUrl: z.string().url(),
  /** DepositRouter (WS08), the same CREATE2 address on every chain. */
  router: evmAddress,
  confirmations: z.number().int().min(0).max(10_000).default(12),
  /** First block to scan when no cursor is stored yet (the router's deploy block). */
  startBlock: z.number().int().min(0).default(0),
  /** Largest block range per eth_getLogs call. */
  maxRange: z.number().int().min(1).max(100_000).default(2_000),
  tokens: z.array(z.object({ symbol: z.enum(STABLES), address: evmAddress, decimals: z.number().int().min(0).max(36) })).min(1),
});
export type EvmChainConfig = z.infer<typeof evmChainSchema>;

const solanaSchema = z.object({
  rpcUrl: z.string().url(),
  cluster: z.enum(["mainnet-beta", "devnet"]).default("mainnet-beta"),
  treasuryWallet: z.string().min(32).max(44),
  /** The treasury's token accounts, one per accepted mint (USDC, USDT). */
  tokens: z.array(z.object({ symbol: z.enum(["USDC", "USDT"]), mint: z.string().min(32).max(44), account: z.string().min(32).max(44) })).min(1),
  /** Signatures fetched per token account per run. */
  pageSize: z.number().int().min(1).max(1000).default(100),
});
export type SolanaConfig = z.infer<typeof solanaSchema>;

const tronSchema = z.object({
  /** TronGrid-compatible HTTP API, e.g. https://api.trongrid.io */
  apiUrl: z.string().url(),
  apiKey: z.string().optional(),
  /** Extended public key whose external children (0/i) are the per-key deposit addresses. */
  xpub: z.string().regex(/^[xt]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/),
  confirmations: z.number().int().min(1).max(1000).default(20),
  tokens: z.array(z.object({ symbol: z.literal("USDT"), contract: z.string().min(34).max(34), decimals: z.number().int().default(6) })).min(1),
});
export type TronConfig = z.infer<typeof tronSchema>;

const btcpaySchema = z.object({
  url: z.string().url(),
  storeId: z.string().min(1),
  apiKey: z.string().min(1),
  webhookSecret: z.string().min(16),
});
export type BtcpayConfig = z.infer<typeof btcpaySchema>;

/** Paying with the coin (CoinPay on Robinhood Chain): burned on-chain, credited in USD at its Uniswap v3 pool price. */
const coinSchema = z.object({
  rpcUrl: z.string().url(),
  chainId: z.number().int().positive().default(4663),
  /** CoinPay: emits Paid(keyCommit, payer, amount) after burning the coins. */
  coinPay: evmAddress,
  token: z.object({ symbol: z.string().min(1).max(12).default("ANMO"), address: evmAddress, decimals: z.number().int().min(0).max(36).default(18) }),
  /** The coin's Uniswap v3 pool against `quote` (a USD stablecoin, counted 1:1). */
  pool: evmAddress,
  quote: z.object({ symbol: z.string().min(1).max(12).default("USDG"), address: evmAddress, decimals: z.number().int().min(0).max(36).default(6) }),
  /** The time-weighted average window; credit uses the lower of this average and the spot price. */
  twapSeconds: z.number().int().min(60).max(86_400).default(1_800),
  /** Below this in-range pool liquidity the price is not trusted and payments wait. "0" disables the check. */
  minLiquidity: z.string().regex(/^\d+$/).default("0"),
  /** A payment worth more than this is recorded as held for an operator, not credited. */
  maxUsdPerPayment: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).default("250"),
  confirmations: z.number().int().min(0).max(10_000).default(12),
  startBlock: z.number().int().min(0).default(0),
  maxRange: z.number().int().min(1).max(100_000).default(2_000),
});
export type CoinConfig = z.infer<typeof coinSchema>;

export const depositsEnv = z.object({
  ANONYMO_EVM_CHAINS: json(z.array(evmChainSchema)),
  ANONYMO_SOLANA: json(solanaSchema),
  ANONYMO_TRON: json(tronSchema),
  ANONYMO_BTCPAY: json(btcpaySchema),
  ANONYMO_COIN: json(coinSchema),
  /** Stops new deposit instructions and invoices. Never affects withdrawals (spec: Backend §7, §9). */
  ANONYMO_DEPOSITS_PAUSED: flag.default(false),
  ANONYMO_WITHDRAW_MIN_USD: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).default("1"),
  ANONYMO_WATCH_EVERY_MS: z.coerce.number().int().min(1_000).default(15_000),
  /** SIWE domain; defaults to the host of PUBLIC_URL. */
  ANONYMO_SIWE_DOMAIN: z.string().optional(),
  ANONYMO_SANCTIONS_LIST_URL: z.string().url().default("https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML"),
  ANONYMO_SANCTIONS_ENABLED: flag.default(false),
});

export type DepositsConfig = {
  evm: EvmChainConfig[];
  solana?: SolanaConfig;
  tron?: TronConfig;
  btcpay?: BtcpayConfig;
  coin?: CoinConfig;
  depositsPaused: boolean;
  withdrawMinUsd: string;
  watchEveryMs: number;
  siweDomain?: string;
  sanctions: { enabled: boolean; listUrl: string };
};

export function loadDepositsConfig(env: Record<string, unknown>): DepositsConfig {
  const parsed = depositsEnv.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid Anonymo deposit configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  const chains = e.ANONYMO_EVM_CHAINS ?? [];
  if (new Set(chains.map((c) => c.chain)).size !== chains.length) throw new Error("ANONYMO_EVM_CHAINS lists a chain twice.");
  return {
    evm: chains,
    solana: e.ANONYMO_SOLANA,
    tron: e.ANONYMO_TRON,
    btcpay: e.ANONYMO_BTCPAY,
    coin: e.ANONYMO_COIN,
    depositsPaused: e.ANONYMO_DEPOSITS_PAUSED,
    withdrawMinUsd: e.ANONYMO_WITHDRAW_MIN_USD,
    watchEveryMs: e.ANONYMO_WATCH_EVERY_MS,
    siweDomain: e.ANONYMO_SIWE_DOMAIN,
    sanctions: { enabled: e.ANONYMO_SANCTIONS_ENABLED, listUrl: e.ANONYMO_SANCTIONS_LIST_URL },
  };
}

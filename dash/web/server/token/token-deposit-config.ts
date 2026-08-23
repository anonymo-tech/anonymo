import { usd6 } from '../ledger/money.ts';
import { productionEnvironment } from '../ledger/test-credits.ts';
import { address } from '../solana/validation.ts';
import {
  PLATFORM_TOKEN_LABEL,
  platformTokenConfig,
  type TokenCluster,
  type TokenProgramKind,
} from './config.ts';
import {
  TOKEN_PRICE_LIMITS,
  createSimulatedPriceSource,
  requirePrice,
  type TokenPriceSource,
} from './price.ts';

// Pay-with-token deposits: configuration only. Nothing here contacts a chain.
// The token treasury (wallet + token account) is distinct from the USDC
// treasury. The path is enabled only where the token configuration is
// write-capable (localnet/devnet) and payments are switched on; mainnet-beta
// is refused by platformTokenConfig itself.

export const TOKEN_DEPOSIT_TRANSACTION_FORMAT = 'spl-transfer-checked-v1';

/** Terms fixed on an intent; verification later compares the chain against them. */
export type TokenDepositPolicy = {
  cluster: TokenCluster;
  mint: string;
  decimals: number;
  program: TokenProgramKind;
  programId: string;
  recipientWallet: string;
  recipientTokenAccount: string;
};

export type TokenDepositCapabilityReason =
  | 'TOKEN_NOT_CONFIGURED'
  | 'TOKEN_CONFIGURATION_INVALID'
  | 'TOKEN_MAINNET_LOCKED'
  | 'TOKEN_DEPOSIT_CONFIGURATION_REQUIRED'
  | 'TOKEN_PRICE_UNAVAILABLE'
  | 'TOKEN_PAYMENTS_DISABLED'
  | 'TOKEN_DEPOSITS_CONFIGURED';

export type TokenDepositCapability = {
  configured: boolean;
  reason: TokenDepositCapabilityReason;
  label: typeof PLATFORM_TOKEN_LABEL;
  cluster: TokenCluster | null;
  mint: string | null;
  decimals: number | null;
  program: TokenProgramKind | null;
  recipientWallet: string | null;
  recipientTokenAccount: string | null;
  maximumUsd6: string | null;
  quoteTtlMs: number;
  priceSource: TokenPriceSource['kind'] | null;
  transactionFormat: typeof TOKEN_DEPOSIT_TRANSACTION_FORMAT;
};

type Env = Record<string, string | undefined>;

const base: TokenDepositCapability = Object.freeze({
  configured: false,
  reason: 'TOKEN_NOT_CONFIGURED',
  label: PLATFORM_TOKEN_LABEL,
  cluster: null,
  mint: null,
  decimals: null,
  program: null,
  recipientWallet: null,
  recipientTokenAccount: null,
  maximumUsd6: null,
  quoteTtlMs: TOKEN_PRICE_LIMITS.defaultQuoteTtlMs,
  priceSource: null,
  transactionFormat: TOKEN_DEPOSIT_TRANSACTION_FORMAT,
});

function quoteTtl(value: string | undefined) {
  if (value === undefined || value === '')
    return TOKEN_PRICE_LIMITS.defaultQuoteTtlMs;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new Error();
  const ttl = Number(value);
  if (ttl > TOKEN_PRICE_LIMITS.maximumAgeMs) throw new Error();
  return ttl;
}

/**
 * Only a simulated source exists today; it is acceptable solely on
 * write-capable test clusters, which is the only place this path can run.
 * The price is an integer of micro-USD per whole token. Unset means "no
 * source"; a malformed value throws so the capability fails closed.
 */
export function tokenDepositPriceSource(
  env: Env = process.env,
): TokenPriceSource | null {
  const kind = env.CONCLAVE_TOKEN_PRICE_SOURCE;
  if (kind === undefined || kind === '') return null;
  if (kind !== 'simulated') throw new Error();
  const price = env.CONCLAVE_TOKEN_SIMULATED_PRICE_USD6;
  if (price === undefined || !/^[1-9][0-9]{0,18}$/.test(price))
    throw new Error();
  return createSimulatedPriceSource({
    priceUsd6PerToken: requirePrice(BigInt(price)),
  });
}

/** Configuration validation only. It never contacts the chain or exposes RPC credentials. */
export function tokenDepositConfiguration(env: Env = process.env): {
  capability: TokenDepositCapability;
  policy: TokenDepositPolicy | null;
  priceSource: TokenPriceSource | null;
  rpcUrl: string | null;
} {
  const unavailable = (
    reason: TokenDepositCapabilityReason,
    view: Partial<TokenDepositCapability> = {},
  ) => ({
    capability: { ...base, ...view, reason },
    policy: null,
    priceSource: null,
    rpcUrl: null,
  });
  let token;
  try {
    token = platformTokenConfig(env);
  } catch {
    return unavailable('TOKEN_CONFIGURATION_INVALID');
  }
  if (!token.configured) return unavailable(token.reason);
  if (!token.writeCapable) return unavailable('TOKEN_MAINNET_LOCKED');
  // Token payments credit spendable USD6 from a simulated price: never under a
  // production marker, whatever the token cluster says.
  if (productionEnvironment(env)) return unavailable('TOKEN_MAINNET_LOCKED');
  const tokenView = {
    cluster: token.cluster,
    mint: token.mint,
    decimals: token.decimals,
    program: token.program,
  };
  let policy: TokenDepositPolicy, maximumUsd6: string, quoteTtlMs: number;
  try {
    const recipientWallet = address(env.CONCLAVE_TOKEN_TREASURY_WALLET);
    const recipientTokenAccount = address(
      env.CONCLAVE_TOKEN_TREASURY_TOKEN_ACCOUNT,
    );
    if (
      new Set([recipientWallet, recipientTokenAccount, token.mint]).size !== 3
    )
      throw new Error();
    maximumUsd6 = usd6(env.CONCLAVE_TOKEN_MAX_DEPOSIT_USD6).toString();
    quoteTtlMs = quoteTtl(env.CONCLAVE_TOKEN_QUOTE_TTL_MS);
    policy = {
      ...tokenView,
      programId: token.programId,
      recipientWallet,
      recipientTokenAccount,
    };
  } catch {
    return unavailable('TOKEN_DEPOSIT_CONFIGURATION_REQUIRED', tokenView);
  }
  const treasuryView = {
    ...tokenView,
    recipientWallet: policy.recipientWallet,
    recipientTokenAccount: policy.recipientTokenAccount,
    maximumUsd6,
    quoteTtlMs,
  };
  let priceSource: TokenPriceSource | null;
  try {
    priceSource = tokenDepositPriceSource(env);
  } catch {
    return unavailable('TOKEN_PRICE_UNAVAILABLE', treasuryView);
  }
  const configured = token.paymentsEnabled && priceSource !== null;
  return {
    capability: {
      ...base,
      ...treasuryView,
      configured,
      reason: !token.paymentsEnabled
        ? 'TOKEN_PAYMENTS_DISABLED'
        : priceSource === null
          ? 'TOKEN_PRICE_UNAVAILABLE'
          : 'TOKEN_DEPOSITS_CONFIGURED',
      priceSource: priceSource?.kind ?? null,
    },
    // Nothing usable leaves here unless the path is actually enabled.
    policy: configured ? policy : null,
    priceSource: configured ? priceSource : null,
    rpcUrl: configured ? token.rpcUrl : null,
  };
}

export const tokenDepositCapability = (env: Env = process.env) =>
  tokenDepositConfiguration(env).capability;

export function sameTokenDepositPolicy(
  a: TokenDepositPolicy,
  b: TokenDepositPolicy,
) {
  return (
    a.cluster === b.cluster &&
    a.mint === b.mint &&
    a.decimals === b.decimals &&
    a.program === b.program &&
    a.programId === b.programId &&
    a.recipientWallet === b.recipientWallet &&
    a.recipientTokenAccount === b.recipientTokenAccount
  );
}

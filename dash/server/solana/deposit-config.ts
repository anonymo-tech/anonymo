import { serviceConfig } from '../core/config.ts';
import { usd6 } from '../ledger/money.ts';
import { address, SOLANA_NETWORKS } from './validation.ts';
import { createSolanaReader } from './rpc.ts';
import type { DepositPolicy } from './deposit.ts';

export const DEPOSIT_INTENT_SECONDS = 900;

/** Configuration validation only. It never contacts the chain or exposes RPC credentials. */
export function depositConfiguration(
  env: Record<string, string | undefined> = process.env,
) {
  const base = {
    configured: false,
    recoveryConfigured: false,
    reason: 'DEPOSIT_CONFIGURATION_REQUIRED',
    cluster: null as DepositPolicy['cluster'] | null,
    mint: null as string | null,
    maximumUsd6: null as string | null,
    recipientWallet: null as string | null,
    recipientTokenAccount: null as string | null,
    intentSeconds: DEPOSIT_INTENT_SECONDS,
    networkVerified: false as const,
    transactionFormat: 'spl-transfer-checked-v1' as const,
    walletSubmission: false,
  };
  try {
    const config = serviceConfig(env);
    if (
      config.mode !== 'service' ||
      !config.origin ||
      !config.databaseUrl ||
      !config.cluster ||
      !config.rpcUrl
    )
      return { capability: base, policy: null, rpcUrl: null };
    const recipientWallet = address(env.CONCLAVE_TREASURY_WALLET);
    const recipientTokenAccount = address(env.CONCLAVE_TREASURY_TOKEN_ACCOUNT);
    const usdcMint = SOLANA_NETWORKS[config.cluster].usdcMint;
    if (new Set([recipientWallet, recipientTokenAccount, usdcMint]).size !== 3)
      throw new Error();
    const maximumUsd6 = usd6(env.CONCLAVE_MAX_DEPOSIT_USD6).toString();
    // Constructor validates the trusted endpoint; it makes no request.
    createSolanaReader({ rpcUrl: config.rpcUrl, cluster: config.cluster });
    const configured = env.CONCLAVE_DEPOSITS_ENABLED === 'true';
    const recoveryConfigured =
      configured || env.CONCLAVE_DEPOSIT_RECOVERY_ENABLED === 'true';
    return {
      capability: {
        ...base,
        configured,
        recoveryConfigured,
        walletSubmission:
          configured && env.CONCLAVE_DEPOSIT_PAYMENTS_ENABLED === 'true',
        reason: configured
          ? 'DEPOSITS_CONFIGURED'
          : recoveryConfigured
            ? 'DEPOSIT_RECOVERY_ONLY'
            : 'DEPOSITS_DISABLED',
        cluster: config.cluster,
        mint: usdcMint,
        maximumUsd6,
        recipientWallet,
        recipientTokenAccount,
      },
      policy: {
        cluster: config.cluster,
        recipientWallet,
        recipientTokenAccount,
        usdcMint,
      },
      rpcUrl: config.rpcUrl,
    };
  } catch {
    return { capability: base, policy: null, rpcUrl: null };
  }
}

export const depositCapability = (
  env: Record<string, string | undefined> = process.env,
) => depositConfiguration(env).capability;

export function sameDepositPolicy(a: DepositPolicy, b: DepositPolicy) {
  return (
    a.cluster === b.cluster &&
    a.usdcMint === b.usdcMint &&
    a.recipientWallet === b.recipientWallet &&
    a.recipientTokenAccount === b.recipientTokenAccount
  );
}

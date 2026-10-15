import type { WalletCapability } from '../../lib/second-look/wallet.ts';
import { configuredKeyring } from '../core/encryption.ts';
import { address } from '../solana/validation.ts';
export type WalletIngestConfig = {
  enabled: boolean;
  rpcUrl: string | null;
  archiveUrl: string | null;
  archiveSourceId: string | null;
  priceUrl: string | null;
  solSpotEnabled?: boolean;
  feePolicyId: string | null;
  jitoAccounts: string[];
  platformAccounts: string[];
};
export function safeWalletEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      value.length > 2048
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
function destinations(value: string | undefined) {
  if (!value) return [];
  const items: unknown = JSON.parse(value);
  if (!Array.isArray(items) || items.length > 128) throw new Error();
  const result = items.map(address);
  if (new Set(result).size !== result.length) throw new Error();
  return result;
}
export function walletIngestConfig(
  env: Record<string, string | undefined> = process.env,
): WalletIngestConfig {
  const empty = {
    enabled: false,
    rpcUrl: null,
    archiveUrl: null,
    archiveSourceId: null,
    priceUrl: null,
    feePolicyId: null,
    jitoAccounts: [],
    platformAccounts: [],
  };
  try {
    const sourceId = env.CONCLAVE_WALLET_ARCHIVE_SOURCE_ID,
      feePolicyId = env.CONCLAVE_WALLET_FEE_POLICY_ID;
    if (sourceId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId)) return empty;
    if (feePolicyId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(feePolicyId))
      return empty;
    const rpcUrl = safeWalletEndpoint(env.CONCLAVE_WALLET_RPC_URL),
      archiveUrl = safeWalletEndpoint(env.CONCLAVE_WALLET_ARCHIVE_URL);
    const jitoAccounts = destinations(env.CONCLAVE_WALLET_JITO_ACCOUNTS),
      platformAccounts = destinations(env.CONCLAVE_WALLET_PLATFORM_ACCOUNTS);
    if (platformAccounts.some((a) => jitoAccounts.includes(a))) return empty;
    return {
      enabled: env.CONCLAVE_WALLET_INGEST_ENABLED === 'true',
      rpcUrl,
      archiveUrl: sourceId ? archiveUrl : null,
      archiveSourceId: sourceId ?? null,
      priceUrl: safeWalletEndpoint(env.CONCLAVE_WALLET_PRICE_URL),
      solSpotEnabled: env.CONCLAVE_WALLET_SOL_SPOT_ENABLED === 'true',
      feePolicyId: feePolicyId ?? null,
      jitoAccounts,
      platformAccounts,
    };
  } catch {
    return empty;
  }
}
export function walletCapability(
  env: Record<string, string | undefined> = process.env,
): WalletCapability {
  const config = walletIngestConfig(env);
  let encrypted = false;
  try {
    configuredKeyring(env);
    encrypted = true;
  } catch {
    /* No account-linked storage without keys. */
  }
  return {
    configured:
      encrypted &&
      config.enabled &&
      Boolean(config.rpcUrl || config.archiveUrl),
    pricingConfigured: Boolean(
      config.priceUrl || (config.solSpotEnabled && config.rpcUrl),
    ),
    cluster: 'mainnet-beta',
    reason: !encrypted
      ? 'WALLET_STORAGE_REQUIRED'
      : !config.enabled
        ? 'WALLET_INGEST_DISABLED'
        : !config.rpcUrl && !config.archiveUrl
          ? 'WALLET_RPC_REQUIRED'
          : null,
  };
}

import { ServiceError } from '../core/errors.ts';
import {
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  address,
} from '../solana/validation.ts';

// Platform token configuration. The token does not exist yet and its name is
// not decided: every user-facing string says "platform token" and the mint is
// a placeholder read from configuration. Nothing here contacts a chain.
//
// Write-capable token features (burn executor, pay-with-token deposits,
// buyback simulation) are allowed on localnet and devnet only. mainnet-beta is
// refused outright until a separately reviewed release enables it.

export const PLATFORM_TOKEN_LABEL = 'platform token';

export type TokenCluster = 'localnet' | 'devnet' | 'mainnet-beta';
export type TokenProgramKind = 'spl-token' | 'token-2022';

export const TOKEN_CLUSTERS: readonly TokenCluster[] = Object.freeze([
  'localnet',
  'devnet',
  'mainnet-beta',
]);
/** Clusters where this code may build and send token transactions. */
export const WRITE_CAPABLE_TOKEN_CLUSTERS: readonly TokenCluster[] =
  Object.freeze(['localnet', 'devnet']);

export type PlatformTokenConfig = {
  configured: true;
  label: typeof PLATFORM_TOKEN_LABEL;
  cluster: TokenCluster;
  /** Base58 mint address. A placeholder until the token is created. */
  mint: string;
  decimals: number;
  program: TokenProgramKind;
  programId: string;
  /** Trusted server configuration; never request data. */
  rpcUrl: string;
  burnEnabled: boolean;
  paymentsEnabled: boolean;
  /** True only on localnet/devnet; mainnet-beta is always false here. */
  writeCapable: boolean;
};

export type PlatformTokenUnavailable = {
  configured: false;
  label: typeof PLATFORM_TOKEN_LABEL;
  reason:
    | 'TOKEN_NOT_CONFIGURED'
    | 'TOKEN_CONFIGURATION_INVALID'
    | 'TOKEN_MAINNET_LOCKED';
};

type Env = Record<string, string | undefined>;

function invalid(): never {
  throw new ServiceError(
    503,
    'CONFIGURATION_REQUIRED',
    'The platform token configuration is invalid.',
  );
}

function tokenCluster(value: string | undefined): TokenCluster {
  if (value === 'localnet' || value === 'devnet' || value === 'mainnet-beta')
    return value;
  return invalid();
}

function tokenDecimals(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9])$/.test(value)) return invalid();
  return Number(value);
}

function tokenProgram(value: string | undefined): TokenProgramKind {
  if (value === undefined || value === '' || value === 'token-2022')
    return 'token-2022';
  if (value === 'spl-token') return 'spl-token';
  return invalid();
}

/**
 * RPC endpoints are https except on localnet, where the test validator serves
 * plain http on loopback. Credentials in the URL are never accepted.
 */
function tokenRpcUrl(value: string | undefined, cluster: TokenCluster): string {
  if (!value || value.length > 2048) return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.username || url.password || url.hash) return invalid();
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (cluster === 'localnet') {
    if (!loopback || !['http:', 'https:'].includes(url.protocol)) return invalid();
  } else if (url.protocol !== 'https:' || loopback) return invalid();
  return url.href;
}

/**
 * Reads the platform token configuration. Unset means "not configured" and
 * every token feature stays inert. Partial or malformed configuration fails
 * closed with CONFIGURATION_REQUIRED; it is never silently defaulted.
 */
export function platformTokenConfig(
  env: Env = process.env,
): PlatformTokenConfig | PlatformTokenUnavailable {
  if (typeof window !== 'undefined')
    throw new Error('Token configuration is unavailable in a browser.');
  const names = [
    'CONCLAVE_TOKEN_MINT',
    'CONCLAVE_TOKEN_CLUSTER',
    'CONCLAVE_TOKEN_RPC_URL',
    'CONCLAVE_TOKEN_DECIMALS',
  ] as const;
  const present = names.filter((name) => env[name] !== undefined && env[name] !== '');
  if (present.length === 0)
    return {
      configured: false,
      label: PLATFORM_TOKEN_LABEL,
      reason: 'TOKEN_NOT_CONFIGURED',
    };
  if (present.length !== names.length) return invalid();
  const cluster = tokenCluster(env.CONCLAVE_TOKEN_CLUSTER);
  const program = tokenProgram(env.CONCLAVE_TOKEN_PROGRAM);
  const config: PlatformTokenConfig = {
    configured: true,
    label: PLATFORM_TOKEN_LABEL,
    cluster,
    mint: address(env.CONCLAVE_TOKEN_MINT),
    decimals: tokenDecimals(env.CONCLAVE_TOKEN_DECIMALS),
    program,
    programId: program === 'spl-token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
    rpcUrl: tokenRpcUrl(env.CONCLAVE_TOKEN_RPC_URL, cluster),
    burnEnabled: env.CONCLAVE_TOKEN_BURN_ENABLED === 'true',
    paymentsEnabled: env.CONCLAVE_TOKEN_PAYMENTS_ENABLED === 'true',
    writeCapable: WRITE_CAPABLE_TOKEN_CLUSTERS.includes(cluster),
  };
  if (cluster === 'mainnet-beta' && (config.burnEnabled || config.paymentsEnabled))
    return {
      configured: false,
      label: PLATFORM_TOKEN_LABEL,
      reason: 'TOKEN_MAINNET_LOCKED',
    };
  return config;
}

/** Throws unless token features may send transactions on this cluster. */
export function requireWriteCapableToken(
  config: PlatformTokenConfig | PlatformTokenUnavailable,
): PlatformTokenConfig {
  if (!config.configured)
    throw new ServiceError(
      503,
      'TOKEN_UNAVAILABLE',
      'The platform token is not configured.',
    );
  if (!config.writeCapable)
    throw new ServiceError(
      503,
      'TOKEN_MAINNET_LOCKED',
      'Platform token transactions are not enabled on this network.',
    );
  return config;
}

/** Public, non-secret capability view for API responses. */
export function platformTokenCapability(env: Env = process.env) {
  try {
    const config = platformTokenConfig(env);
    if (!config.configured)
      return {
        configured: false as const,
        label: PLATFORM_TOKEN_LABEL,
        reason: config.reason,
        burnEnabled: false,
        paymentsEnabled: false,
      };
    return {
      configured: true as const,
      label: PLATFORM_TOKEN_LABEL,
      cluster: config.cluster,
      mint: config.mint,
      decimals: config.decimals,
      program: config.program,
      burnEnabled: config.burnEnabled && config.writeCapable,
      paymentsEnabled: config.paymentsEnabled && config.writeCapable,
    };
  } catch {
    return {
      configured: false as const,
      label: PLATFORM_TOKEN_LABEL,
      reason: 'TOKEN_CONFIGURATION_INVALID' as const,
      burnEnabled: false,
      paymentsEnabled: false,
    };
  }
}

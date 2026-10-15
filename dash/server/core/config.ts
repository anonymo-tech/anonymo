import { ServiceError } from './errors.ts';

export type ServiceConfig = {
  mode: 'preview' | 'service';
  origin: string | null;
  databaseUrl: string | null;
  ppqKey: string | null;
  inferenceEnabled: boolean;
  cluster: 'devnet' | 'mainnet-beta' | null;
  rpcUrl: string | null;
};

// These values must never be imported by a client component or serialized.
export function serviceConfig(env: Record<string, string | undefined> = process.env): ServiceConfig {
  if (typeof window !== 'undefined') throw new Error('Server configuration is unavailable in a browser.');
  const mode = env.CONCLAVE_MODE === 'service' ? 'service' : 'preview';
  let origin: string | null = null;
  if (env.CONCLAVE_APP_ORIGIN) {
    try {
      const url = new URL(env.CONCLAVE_APP_ORIGIN);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
          (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error();
      origin = url.origin;
    } catch {
      throw new ServiceError(503, 'CONFIGURATION_REQUIRED', 'The service origin is not configured correctly.');
    }
  }
  const cluster = env.CONCLAVE_SOLANA_CLUSTER;
  return {
    mode,
    origin,
    databaseUrl: env.CONCLAVE_DATABASE_URL || null,
    ppqKey: env.PPQ_API_KEY || null,
    inferenceEnabled: env.CONCLAVE_INFERENCE_ENABLED === 'true',
    cluster: cluster === 'devnet' || cluster === 'mainnet-beta' ? cluster : null,
    rpcUrl: env.CONCLAVE_SOLANA_RPC_URL || null,
  };
}

export function requireService(config: ServiceConfig) {
  if (config.mode !== 'service' || !config.origin || !config.databaseUrl) {
    throw new ServiceError(503, 'SERVICE_UNAVAILABLE', 'Live services are not configured for this workspace.');
  }
  return { ...config, origin: config.origin, databaseUrl: config.databaseUrl };
}

import { ServiceError, requireCondition } from '../core/errors.ts';
import { address, SOLANA_NETWORKS } from '../solana/validation.ts';
import type { TokenCapability } from '../../lib/second-look/token.ts';

export type TokenProviderConfig = {
  enabled: boolean;
  rpcUrl: string | null;
  dex: boolean;
  rug: boolean;
  evidence: boolean;
  simulation: boolean;
  claims: boolean;
  deep: boolean;
  freeDailyGlobalLimit: number;
};
export function tokenProviderConfig(
  env: Record<string, string | undefined> = process.env,
): TokenProviderConfig {
  let rpcUrl: string | null = null;
  try {
    const u = new URL(env.CONCLAVE_SOLANA_RPC_URL ?? '');
    if (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.hash &&
      env.CONCLAVE_SOLANA_CLUSTER === 'mainnet-beta'
    )
      rpcUrl = u.href;
  } catch {
    /* Configuration is not a user URL. */
  }
  return {
    enabled: env.CONCLAVE_SECOND_LOOK_ENABLED === 'true',
    rpcUrl,
    dex: env.CONCLAVE_SECOND_LOOK_DEXSCREENER_ENABLED === 'true',
    rug: env.CONCLAVE_SECOND_LOOK_RUGCHECK_ENABLED === 'true',
    evidence: env.CONCLAVE_SECOND_LOOK_INDEX_ENABLED === 'true',
    simulation: env.CONCLAVE_SECOND_LOOK_SIMULATION_ENABLED === 'true',
    claims: env.CONCLAVE_SECOND_LOOK_CLAIMS_ENABLED === 'true',
    deep: env.CONCLAVE_SECOND_LOOK_DEEP_ENABLED === 'true',
    freeDailyGlobalLimit: Math.min(
      100000,
      Math.max(
        0,
        Number(env.CONCLAVE_SECOND_LOOK_FREE_DAILY_LIMIT ?? 1000) || 0,
      ),
    ),
  };
}
export function tokenCapability(
  config = tokenProviderConfig(),
): TokenCapability {
  return {
    configured: config.enabled && !!config.rpcUrl,
    deepConfigured:
      config.enabled &&
      !!config.rpcUrl &&
      config.deep &&
      config.evidence &&
      config.claims,
    calibrationConfigured: false,
    reason: !config.enabled
      ? 'TOKEN_CHECK_DISABLED'
      : !config.rpcUrl
        ? 'MAINNET_RPC_REQUIRED'
        : null,
    dailyFreeChecks: 10,
    standardUsd6: '20000',
    deepUsd6: '100000',
    providers: {
      rpc: !!config.rpcUrl,
      market: config.dex,
      externalRisk: config.rug,
      indexedEvidence: config.evidence,
      simulation: config.simulation,
      claims: config.claims,
    },
  };
}
export function providerError() {
  return new ServiceError(
    503,
    'TOKEN_SOURCE_UNAVAILABLE',
    'A token data source is unavailable.',
    true,
  );
}
export function object(value: unknown): Record<string, unknown> {
  requireCondition(
    !!value && typeof value === 'object' && !Array.isArray(value),
    503,
    'TOKEN_SOURCE_INVALID',
    'A token data source returned invalid data.',
  );
  return value as Record<string, unknown>;
}
export function safeText(value: unknown, max = 256): string {
  requireCondition(
    typeof value === 'string' &&
      value.length <= max &&
      !Array.from(value).some((c) => {
        const n = c.charCodeAt(0);
        return n < 32 || (n >= 127 && n <= 159);
      }),
    503,
    'TOKEN_SOURCE_INVALID',
    'A token data source returned invalid text.',
  );
  return value;
}
export function finite(value: unknown, max = 1e18): number {
  requireCondition(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= max,
    503,
    'TOKEN_SOURCE_INVALID',
    'A token data source returned invalid data.',
  );
  return value;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const n = finite(value, max);
  requireCondition(
    Number.isSafeInteger(n),
    503,
    'TOKEN_SOURCE_INVALID',
    'A token data source returned invalid data.',
  );
  return n;
}
export function canonicalAmount(value: unknown): string {
  requireCondition(
    typeof value === 'string' &&
      /^(0|[1-9][0-9]{0,19})$/.test(value) &&
      BigInt(value) <= (1n << 64n) - 1n,
    503,
    'TOKEN_SOURCE_INVALID',
    'A token data source returned invalid data.',
  );
  return value;
}

/** Fixed public origins and an operator-configured RPC only. No submitted URL reaches fetch. */
export function createTokenProviders(
  config = tokenProviderConfig(),
  fetcher: typeof fetch = fetch,
) {
  async function read(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) abort.abort();
    const timer = setTimeout(stop, 8000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    async function bounded<T>(promise: Promise<T>): Promise<T> {
      if (abort.signal.aborted) throw providerError();
      let rejectAbort: () => void = () => {};
      const interruption = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(providerError());
        abort.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      try {
        return await Promise.race([promise, interruption]);
      } finally {
        abort.signal.removeEventListener('abort', rejectAbort);
      }
    }
    try {
      response = await bounded(
        fetcher(url, {
          ...init,
          signal: abort.signal,
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: {
            Accept: 'application/json',
            ...(init.method === 'POST'
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
        }),
      );
      if (
        !response.ok ||
        !/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        throw providerError();
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > 1048576))
        throw providerError();
      reader = response.body?.getReader();
      if (!reader) throw providerError();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const next = await bounded(reader.read());
        if (next.done) break;
        size += next.value.length;
        if (size > 1048576) throw providerError();
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw providerError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      try {
        void (reader ? reader.cancel() : response?.body?.cancel())?.catch(
          () => {},
        );
      } catch {
        /* Body cleanup only. */
      }
      try {
        reader?.releaseLock();
      } catch {
        /* A cancelled pending read settles separately. */
      }
    }
  }
  async function rpc(method: string, params: unknown[], signal?: AbortSignal) {
    if (
      !config.rpcUrl ||
      ![
        'getGenesisHash',
        'getAccountInfo',
        'getTokenLargestAccounts',
        'getEpochInfo',
      ].includes(method)
    )
      throw providerError();
    const data = object(
      await read(
        config.rpcUrl,
        {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        },
        signal,
      ),
    );
    if (
      data.jsonrpc !== '2.0' ||
      data.id !== 1 ||
      data.error ||
      !Object.hasOwn(data, 'result')
    )
      throw providerError();
    return data.result;
  }
  return {
    config,
    async genesis(signal?: AbortSignal) {
      if (
        (await rpc('getGenesisHash', [], signal)) !==
        SOLANA_NETWORKS['mainnet-beta'].genesisHash
      )
        throw new ServiceError(
          503,
          'TOKEN_WRONG_NETWORK',
          'The token source is not Solana mainnet.',
        );
    },
    async mint(mint: string, signal?: AbortSignal) {
      return rpc(
        'getAccountInfo',
        [address(mint), { encoding: 'base64', commitment: 'finalized' }],
        signal,
      );
    },
    async largest(mint: string, signal?: AbortSignal) {
      return rpc(
        'getTokenLargestAccounts',
        [address(mint), { commitment: 'finalized' }],
        signal,
      );
    },
    async search(ticker: string, signal?: AbortSignal) {
      if (!config.dex || !/^\$?[a-zA-Z0-9._-]{1,16}$/.test(ticker))
        throw providerError();
      return read(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`,
        {},
        signal,
      );
    },
    async pair(pair: string, signal?: AbortSignal) {
      if (!config.dex) throw providerError();
      return read(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${address(pair)}`,
        {},
        signal,
      );
    },
    async market(mint: string, signal?: AbortSignal) {
      if (!config.dex) throw providerError();
      return read(
        `https://api.dexscreener.com/token-pairs/v1/solana/${address(mint)}`,
        {},
        signal,
      );
    },
    async orders(mint: string, signal?: AbortSignal) {
      if (!config.dex) throw providerError();
      return read(
        `https://api.dexscreener.com/orders/v1/solana/${address(mint)}`,
        {},
        signal,
      );
    },
    async rug(mint: string, signal?: AbortSignal) {
      if (!config.rug) throw providerError();
      return read(
        `https://api.rugcheck.xyz/v1/tokens/${address(mint)}/report/summary?cacheOnly=true`,
        {},
        signal,
      );
    },
  };
}
export type TokenProviders = ReturnType<typeof createTokenProviders>;

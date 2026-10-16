import type { Pool } from 'pg';
import {
  decodeStockTokenMint,
  isStockTokenAddress,
  STOCK_TOKEN_DATA_ERROR,
  STOCK_TOKEN_INPUT_ERROR,
  type StockTokenCard,
} from '../../lib/second-look/stock-token.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { jsonResponse, readJson } from '../core/http.ts';
import { assertGenesis } from '../solana/validation.ts';
import { readWalletJson } from './ingest-source.ts';
import { tokenProviderConfig } from './providers.ts';

// FOMO-equivalent per-minute quotas, kept only in memory: no research or limiter
// records are written. Each worker has its own quota; the edge may tighten it.
export function createStockTokenLimiter() {
  const accounts = new Map<string, number>();
  let expires = 0,
    global = 0;
  return (accountId: string, now = Date.now()) => {
    if (now >= expires) {
      accounts.clear();
      global = 0;
      expires = now + 60_000;
    }
    const count = accounts.get(accountId) ?? 0;
    requireCondition(
      count < 10 && global < 25,
      429,
      'RATE_LIMITED',
      'Too many requests. Try again shortly.',
    );
    accounts.set(accountId, count + 1);
    global++;
  };
}
const limit = createStockTokenLimiter();

/** Only configured mainnet RPC, through the existing bounded JSON transport.
 * The metadata URI is descriptive text and is never fetched. */
export async function readStockTokenCard(
  mint: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<StockTokenCard> {
  requireCondition(
    isStockTokenAddress(mint),
    400,
    'STOCK_TOKEN_INPUT_INVALID',
    STOCK_TOKEN_INPUT_ERROR,
  );
  const config = tokenProviderConfig();
  requireCondition(
    config.rpcUrl,
    503,
    'STOCK_TOKEN_UNAVAILABLE',
    'Stock-token RPC is not configured for Solana mainnet.',
  );
  const deadline = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(20_000),
  ]);
  const rpc = async (
    method: 'getGenesisHash' | 'getAccountInfo',
    params: unknown[],
  ) => {
    const id = crypto.randomUUID();
    const raw = await readWalletJson(
      config.rpcUrl!,
      { jsonrpc: '2.0', id, method, params },
      fetcher,
      deadline,
      65_536,
    );
    requireCondition(
      raw !== null && typeof raw === 'object' && !Array.isArray(raw),
      503,
      'STOCK_TOKEN_SOURCE_INVALID',
      STOCK_TOKEN_DATA_ERROR,
    );
    const r = raw as Record<string, unknown>;
    requireCondition(
      r.jsonrpc === '2.0' &&
        r.id === id &&
        Object.hasOwn(r, 'result') &&
        !Object.hasOwn(r, 'error'),
      503,
      'STOCK_TOKEN_SOURCE_INVALID',
      STOCK_TOKEN_DATA_ERROR,
    );
    return r.result;
  };
  try {
    assertGenesis('mainnet-beta', await rpc('getGenesisHash', []));
    return decodeStockTokenMint(
      await rpc('getAccountInfo', [
        mint,
        { encoding: 'jsonParsed', commitment: 'finalized' },
      ]),
      mint,
    );
  } catch {
    throw new ServiceError(
      503,
      'STOCK_TOKEN_SOURCE_UNAVAILABLE',
      'Stock-token mint data is unavailable, malformed or unsupported. Try again shortly.',
      true,
    );
  }
}

/** Stock-token Second Look (read-only). Paths: second-look/stock-tokens/*. Gated by the stockToken switch. */
export async function stockTokenRoutes(
  _pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path !== 'second-look/stock-tokens/check' || request.method !== 'POST')
    return null;
  requireCondition(
    accountId,
    401,
    'SIGN_IN_REQUIRED',
    'Sign in to use this tool.',
  );
  limit(accountId);
  const body = await readJson(request, 256);
  requireCondition(
    Object.keys(body).length === 1 && isStockTokenAddress(body.mint),
    400,
    'STOCK_TOKEN_INPUT_INVALID',
    STOCK_TOKEN_INPUT_ERROR,
  );
  return jsonResponse({
    card: await readStockTokenCard(body.mint, request.signal),
  });
}

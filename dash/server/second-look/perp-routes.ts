import type { Pool } from 'pg';
import { readJson, jsonResponse } from '../core/http.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import {
  DAY_MS,
  PERP_CANDLE_LIMIT,
  isPerpAddress,
  parsePerpAccount,
  parsePerpMarkets,
  parsePerpFunding,
  parsePerpFills,
  parsePerpCandles,
  buildPerpReport,
  type PerpCandle,
} from '../../lib/second-look/perp-check.ts';

import {
  buildPerpPlan,
  parsePerpPlanInput,
  validatePlanMarket,
  PERP_PLAN_INVALID,
  PERP_PLAN_NETTING,
  type PerpPlanInput,
} from '../../lib/second-look/perp-plan.ts';

const INFO = 'https://api.hyperliquid.xyz/info';
const MAX_BYTES = 2_000_000;
// Tool-specific quotas expire in memory. No research data or addresses are persisted.
const buckets = new Map<string, { hits: number; expires: number }>();
function rateLimit(key: string, limit: number) {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.expires <= now) buckets.delete(k);
  let bucket = buckets.get(key);
  requireCondition(
    bucket || buckets.size < 5000,
    429,
    'RATE_LIMITED',
    'Too many requests. Try again shortly.',
  );
  if (!bucket) {
    bucket = { hits: 0, expires: now + 60_000 };
    buckets.set(key, bucket);
  }
  requireCondition(
    ++bucket.hits <= limit,
    429,
    'RATE_LIMITED',
    'Too many requests. Try again shortly.',
  );
}

/** Fixed endpoint, no redirects or cookies; deadline covers headers and streaming body. */
export async function readPerpInfo(
  body: Record<string, unknown>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(Error('Hyperliquid request cancelled'));
    combined.addEventListener('abort', abort, { once: true });
    if (combined.aborted) abort();
  });
  const bounded = <T>(p: Promise<T>) => Promise.race([p, cancelled]);
  try {
    const response = await bounded(
      fetcher(INFO, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      }).then((r) => {
        if (combined.aborted) void r.body?.cancel().catch(() => {});
        return r;
      }),
    );
    if (
      !response.ok ||
      response.redirected ||
      (response.url && response.url !== INFO) ||
      !/^application\/json(?:;|$)/i.test(
        response.headers.get('content-type') ?? '',
      ) ||
      Number(response.headers.get('content-length')) > MAX_BYTES
    )
      throw Error('Invalid Hyperliquid response');
    reader = response.body?.getReader();
    if (!reader) throw Error('Empty Hyperliquid response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await bounded(reader.read());
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) throw Error('Hyperliquid response too large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    return value;
  } finally {
    combined.removeEventListener('abort', abort);
    void reader?.cancel().catch(() => {});
  }
}

export async function collectPerpReport(
  address: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  requireCondition(
    isPerpAddress(address),
    400,
    'INVALID_REQUEST',
    'Enter a Hyperliquid address: 0x followed by 40 hex characters.',
  );
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const startTime = now - 30 * DAY_MS;
  const [account, markets, funding, fills] = await Promise.all([
    readPerpInfo(
      { type: 'clearinghouseState', user: address },
      deadline,
      fetcher,
    ).then(parsePerpAccount),
    readPerpInfo({ type: 'metaAndAssetCtxs' }, deadline, fetcher).then(
      parsePerpMarkets,
    ),
    readPerpInfo(
      { type: 'userFunding', user: address, startTime, endTime: now },
      deadline,
      fetcher,
    ).then(parsePerpFunding),
    readPerpInfo(
      { type: 'userFillsByTime', user: address, startTime },
      deadline,
      fetcher,
    ).then(parsePerpFills),
  ]);
  const candleEnd = Math.floor(now / DAY_MS) * DAY_MS - 1;
  const candleStart = candleEnd + 1 - 30 * DAY_MS;
  const entries = await Promise.all(
    account.positions.slice(0, PERP_CANDLE_LIMIT).map(async (p) => {
      try {
        const data = await readPerpInfo(
          {
            type: 'candleSnapshot',
            req: {
              coin: p.coin,
              interval: '1d',
              startTime: candleStart,
              endTime: candleEnd,
            },
          },
          deadline,
          fetcher,
        );
        return [p.coin, parsePerpCandles(data, p.coin)] as const;
      } catch {
        // Missing or malformed candles are unavailable, never a zero-volatility estimate.
        return null;
      }
    }),
  );
  if (deadline.aborted) throw Error('Perp Check deadline exceeded');
  const candles = new Map<string, PerpCandle[]>();
  for (const entry of entries) if (entry) candles.set(entry[0], entry[1]);
  return buildPerpReport({
    address,
    now,
    account,
    markets,
    funding,
    fills,
    candles,
  });
}

/** Two calls without an address, four with one. No pagination or persisted research. */
export async function collectPerpPlan(
  value: PerpPlanInput,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const plan = parsePerpPlanInput(value);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const markets = parsePerpMarkets(
    await readPerpInfo({ type: 'metaAndAssetCtxs' }, deadline, fetcher),
  );
  validatePlanMarket(plan, markets);
  const candleEnd = Math.floor(now / DAY_MS) * DAY_MS - 1;
  const candleStart = candleEnd + 1 - 30 * DAY_MS;
  const [candles, account, fills] = await Promise.all([
    readPerpInfo(
      {
        type: 'candleSnapshot',
        req: {
          coin: plan.coin,
          interval: '1d',
          startTime: candleStart,
          endTime: candleEnd,
        },
      },
      deadline,
      fetcher,
    ).then((v) => parsePerpCandles(v, plan.coin)),
    plan.address
      ? readPerpInfo(
          { type: 'clearinghouseState', user: plan.address },
          deadline,
          fetcher,
        ).then(parsePerpAccount)
      : undefined,
    plan.address
      ? readPerpInfo(
          {
            type: 'userFillsByTime',
            user: plan.address,
            startTime: now - 30 * DAY_MS,
          },
          deadline,
          fetcher,
        ).then(parsePerpFills)
      : undefined,
  ]);
  return buildPerpPlan({ plan, markets, candles, account, fills, now });
}

/** Authenticated by dispatch; release gating happens before dispatch opens a database. */
export async function perpRoutes(
  _pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  const planning = path === 'second-look/perp-plan/check';
  const marketsOnly = path === 'second-look/perp-plan/markets';
  if (
    (!planning && !marketsOnly && path !== 'second-look/perp/check') ||
    request.method !== 'POST'
  )
    return null;
  requireCondition(
    accountId,
    401,
    'SIGN_IN_REQUIRED',
    'Sign in to run this check.',
  );
  rateLimit(
    (planning || marketsOnly ? 'plan-account:' : 'account:') + accountId,
    5,
  );
  rateLimit('global', 25);
  const body = await readJson(request, planning ? 512 : 256);
  if (planning || marketsOnly) {
    let plan: PerpPlanInput | undefined;
    try {
      if (marketsOnly)
        requireCondition(
          Object.keys(body).length === 0,
          400,
          'INVALID_REQUEST',
          PERP_PLAN_INVALID,
        );
      else plan = parsePerpPlanInput(body);
    } catch {
      throw new ServiceError(400, 'INVALID_REQUEST', PERP_PLAN_INVALID);
    }
    try {
      if (plan)
        return jsonResponse({
          report: await collectPerpPlan(plan, request.signal),
        });
      const markets = parsePerpMarkets(
        await readPerpInfo({ type: 'metaAndAssetCtxs' }, request.signal),
      );
      return jsonResponse({
        markets: markets
          .filter((m) => !m.coin.includes(':'))
          .map((m) => ({ coin: m.coin, maxLeverage: m.maxLeverage })),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [PERP_PLAN_INVALID, PERP_PLAN_NETTING].includes(error.message)
      )
        throw new ServiceError(400, 'INVALID_REQUEST', error.message);
      throw new ServiceError(
        502,
        'PERP_DATA_UNAVAILABLE',
        'Hyperliquid data could not be verified. Try again shortly.',
        true,
      );
    }
  }
  requireCondition(
    Object.keys(body).length === 1 && isPerpAddress(body.address),
    400,
    'INVALID_REQUEST',
    'Enter a Hyperliquid address: 0x followed by 40 hex characters.',
  );
  try {
    return jsonResponse({
      report: await collectPerpReport(body.address, request.signal),
    });
  } catch {
    throw new ServiceError(
      502,
      'PERP_DATA_UNAVAILABLE',
      'Hyperliquid data could not be verified. Try again shortly.',
      true,
    );
  }
}

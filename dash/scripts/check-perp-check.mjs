import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DAY_MS,
  isPerpAddress,
  perpNumber,
  parsePerpAccount,
  parsePerpMarkets,
  parsePerpFunding,
  parsePerpFills,
  parsePerpCandles,
  buildPerpReport,
  dailyRisk,
  liquidationDistance,
  projectHourlyFunding,
  isPerpResponse,
} from '../lib/second-look/perp-check.ts';
import {
  collectPerpReport,
  readPerpInfo,
  perpRoutes,
} from '../server/second-look/perp-routes.ts';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/perp-check/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const { now, address } = fixture('snapshot');
function input() {
  return {
    address,
    now,
    account: parsePerpAccount(fixture('account')),
    markets: parsePerpMarkets(fixture('markets')),
    funding: parsePerpFunding(fixture('funding')),
    fills: parsePerpFills(fixture('fills')),
    candles: new Map(
      ['BTC', 'ETH'].map((coin) => [
        coin,
        parsePerpCandles(fixture('candles-' + coin.toLowerCase())),
      ]),
    ),
  };
}
const near = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${actual} differs from ${expected}`,
  );

test('long and isolated short: funding signs, windows, P&L and leverage', () => {
  const report = buildPerpReport(input());
  assert.ok(isPerpResponse({ report }));
  near(report.effectiveLeverage, 5.5);
  const [long, short] = report.positions;
  assert.equal(long.funding7, -4);
  assert.equal(long.funding30, -10);
  assert.equal(short.funding7, 3);
  assert.equal(short.funding30, 5);
  assert.equal(long.fundingSinceOpen, -12);
  assert.equal(short.fundingSinceOpen, 8);
  near(long.pnlAfter, 216.8);
  near(short.pnlAfter, 47.3);
  assert.equal(short.leverageType, 'isolated');
  assert.equal(short.leverage, 5);
  near(long.distance, 0.1);
  near(short.distance, 0.2);
  near(long.projected7, -16.8);
  near(short.projected7, 3.36);
  assert.equal(report.funding30, -5);
  assert.equal(report.realized30, 20);
});

test('no open positions still includes historical funding and closed P&L', () => {
  const value = input();
  value.account = parsePerpAccount(fixture('empty-account'));
  const r = buildPerpReport(value);
  assert.deepEqual(r.positions, []);
  assert.equal(r.funding30, -5);
  assert.equal(r.realized30, 20);
  assert.equal(r.effectiveLeverage, 0);
  value.account.accountValue = 0;
  assert.equal(buildPerpReport(value).effectiveLeverage, null);
  value.account.accountValue = -1;
  assert.equal(buildPerpReport(value).effectiveLeverage, null);
});

test('spot fills do not contaminate perp fees or realized totals', () => {
  const value = input();
  value.fills = parsePerpFills([...fixture('fills'), ...fixture('spot-fills')]);
  const report = buildPerpReport(value);
  assert.equal(report.fillsCount, 4);
  assert.equal(report.realized30, 20);
  near(report.fees30, 1.9);
});

test('strict addresses, malformed number fixtures, and external shapes', () => {
  assert.ok(isPerpAddress(address));
  assert.ok(!isPerpAddress(address + '/path'));
  assert.ok(!isPerpAddress('https://example.invalid'));
  for (const v of fixture('malformed-numbers'))
    assert.throws(() => perpNumber(v));
  assert.equal(perpNumber('-0.001'), -0.001);
  const a = fixture('account');
  a.assetPositions[0].position.szi = 'NaN';
  assert.throws(() => parsePerpAccount(a));
  assert.throws(() => parsePerpAccount({}));
  assert.throws(() => parsePerpMarkets([{}, []]));
  const m = fixture('markets');
  m[1].pop();
  assert.throws(() => parsePerpMarkets(m));
  const f = fixture('funding');
  f[0].delta.usdc = '5junk';
  assert.throws(() => parsePerpFunding(f));
  const fills = fixture('fills');
  fills[0].feeToken = 'OTHER';
  assert.throws(() => parsePerpFills(fills));
  const c = fixture('candles-btc');
  c[0].h = '1';
  assert.throws(() => parsePerpCandles(c));
  assert.ok(!isPerpResponse({ report: {} }));
  const r = buildPerpReport(input());
  r.positions[0].sigma = Infinity;
  assert.ok(!isPerpResponse({ report: r }));
});

test('sample daily log σ, 30-day range count, missing days and zero variance', () => {
  const candles = parsePerpCandles(fixture('candles-btc'));
  const risk = dailyRisk(candles, 0.1);
  assert.equal(risk.candleDays, 30);
  assert.equal(risk.returnCount, 29);
  assert.equal(risk.daysAtDistance, 5);
  const returns = candles
    .slice(1)
    .map((c, i) => Math.log(c.close) - Math.log(candles[i].close));
  const mean = returns.reduce((a, b) => a + b, 0) / 29;
  const expected = Math.sqrt(
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / 28,
  );
  near(risk.sigma, expected);
  near(risk.distanceSigma, 0.1 / expected);
  assert.equal(
    dailyRisk(
      candles.filter((_, i) => i !== 10),
      0.1,
    ).returnCount,
    27,
  );
  const flat = candles.map((c) => ({
    ...c,
    open: 10,
    close: 10,
    high: 10,
    low: 10,
  }));
  assert.equal(dailyRisk(flat, 0.1).sigma, 0);
  assert.equal(dailyRisk(flat, 0.1).distanceSigma, null);
  assert.equal(dailyRisk([], 0.1).sigma, null);
  assert.equal(dailyRisk(candles.slice(0, 2), 0.1).sigma, null);
  assert.equal(dailyRisk(candles, null).daysAtDistance, null);
});

test('hourly funding projects 168 hours and respects both position and rate signs', () => {
  near(projectHourlyFunding(0.001, 1000, 1), -168);
  near(projectHourlyFunding(0.001, 1000, -1), 168);
  near(projectHourlyFunding(-0.001, 1000, 1), 168);
  near(projectHourlyFunding(-0.001, 1000, -1), -168);
  assert.throws(() => projectHourlyFunding(Infinity, 1000, 1));
  assert.throws(() => projectHourlyFunding(0.1, 1000, 0));
  assert.equal(liquidationDistance(100, null, 1), null);
  near(liquidationDistance(100, 110, 1), -0.1);
});

test('missing context, null liquidation, partial days, boundaries and history caps are explicit', () => {
  const value = input();
  value.account.positions[0].coin = 'dex:STOCK';
  value.account.positions[0].liquidation = null;
  value.funding.push(
    { coin: 'ETH', time: now + 1, usdc: 1000 },
    { coin: 'ETH', time: now - 30 * DAY_MS - 1, usdc: 1000 },
  );
  value.candles.set('ETH', value.candles.get('ETH').slice(0, 10));
  const r = buildPerpReport(value);
  assert.equal(r.positions[0].stockLike, true);
  assert.equal(r.positions[0].mark, null);
  assert.equal(r.positions[0].projected7, null);
  assert.equal(r.positions[0].distance, null);
  assert.equal(r.positions[1].candleDays, 10);
  assert.equal(r.funding30, -5);
  value.fills = Array.from({ length: 2000 }, () => value.fills[0]);
  value.funding = Array.from({ length: 500 }, () => value.funding[0]);
  const capped = buildPerpReport(value);
  assert.ok(capped.fillsCapped);
  assert.ok(capped.fundingPossiblyCapped);
  const currentDay = Math.floor(now / DAY_MS) * DAY_MS;
  value.candles.set('ETH', [
    { ...value.candles.get('ETH')[0], time: currentDay },
  ]);
  assert.equal(buildPerpReport(value).positions[1].candleDays, 0);
});

function transport(
  calls,
  { account = fixture('account'), brokenCandle = false } = {},
) {
  return async (url, init) => {
    assert.equal(url, 'https://api.hyperliquid.xyz/info');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    const body = JSON.parse(init.body);
    calls.push(body);
    const sources = {
      clearinghouseState: account,
      metaAndAssetCtxs: fixture('markets'),
      userFunding: fixture('funding'),
      userFillsByTime: fixture('fills'),
    };
    const data =
      body.type === 'candleSnapshot'
        ? brokenCandle
          ? [{ t: 1 }]
          : fixture('candles-btc').map((c) => ({ ...c, s: body.req.coin }))
        : sources[body.type];
    return new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('collector sends exact documented request bodies and bounds calls to 4 + 10', async () => {
  const calls = [],
    account = fixture('account');
  account.assetPositions = Array.from({ length: 12 }, (_, i) => {
    const p = structuredClone(account.assetPositions[0]);
    p.position.coin = 'COIN' + i;
    return p;
  });
  const r = await collectPerpReport(
    address,
    new AbortController().signal,
    transport(calls, { account }),
    now,
  );
  assert.equal(calls.length, 14);
  assert.deepEqual(calls.slice(0, 4), [
    { type: 'clearinghouseState', user: address },
    { type: 'metaAndAssetCtxs' },
    {
      type: 'userFunding',
      user: address,
      startTime: now - 30 * DAY_MS,
      endTime: now,
    },
    { type: 'userFillsByTime', user: address, startTime: now - 30 * DAY_MS },
  ]);
  assert.deepEqual(calls[4], {
    type: 'candleSnapshot',
    req: {
      coin: 'COIN0',
      interval: '1d',
      startTime: r.candleStart,
      endTime: r.candleEnd,
    },
  });
  assert.equal(r.positions[10].candleStatus, 'limit');
  assert.ok(isPerpResponse({ report: r }));
  const partial = await collectPerpReport(
    address,
    new AbortController().signal,
    transport([], { brokenCandle: true }),
    now,
  );
  assert.equal(partial.positions[0].candleStatus, 'unavailable');
  assert.equal(partial.positions[0].sigma, null);
  const emptyCalls = [];
  await collectPerpReport(
    address,
    new AbortController().signal,
    transport(emptyCalls, { account: fixture('empty-account') }),
    now,
  );
  assert.equal(emptyCalls.length, 4);
});

test('external reader rejects oversized streams, redirects, invalid JSON, content type and cancellation', async () => {
  for (const response of [
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', {
      status: 302,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('x'.repeat(2_000_001), {
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'content-length': '2000001',
      },
    }),
  ])
    await assert.rejects(() =>
      readPerpInfo(
        { type: 'metaAndAssetCtxs' },
        new AbortController().signal,
        async () => response,
      ),
    );
  const controller = new AbortController();
  const pending = readPerpInfo(
    { type: 'metaAndAssetCtxs' },
    controller.signal,
    async () => new Promise(() => {}),
  );
  controller.abort();
  await assert.rejects(pending);
  const streamController = new AbortController();
  const streamPending = readPerpInfo(
    { type: 'metaAndAssetCtxs' },
    streamController.signal,
    async () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  setTimeout(() => streamController.abort(), 5);
  await assert.rejects(streamPending);
});

test('route rejects unknown fields and invalid addresses before any external call; no tool DB writes', async () => {
  const pool = {
    query() {
      assert.fail('Perp Check must not write to the database');
    },
  };
  const request = (body) =>
    new Request('https://example.invalid/api/second-look/perp/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal(
    await perpRoutes(
      pool,
      request({}),
      'second-look/perp-plan/unknown',
      'demo-account',
    ),
    null,
  );
  for (const body of [
    { address: 'bad' },
    { address, url: 'https://example.invalid' },
  ]) {
    await assert.rejects(
      () =>
        perpRoutes(
          pool,
          request(body),
          'second-look/perp/check',
          'demo-account',
        ),
      (e) => e.code === 'INVALID_REQUEST',
    );
  }
  await assert.rejects(
    () => perpRoutes(pool, request({ address }), 'second-look/perp/check', ''),
    (e) => e.code === 'SIGN_IN_REQUIRED',
  );
});

test('valid route is read-only, no-store, and account requests are rate limited', async () => {
  const pool = {
    query() {
      assert.fail('Unexpected database write');
    },
  };
  const request = (value) =>
    new Request('https://example.invalid/api/second-look/perp/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  const originalFetch = globalThis.fetch,
    calls = [];
  globalThis.fetch = transport(calls);
  try {
    const response = await perpRoutes(
      pool,
      request({ address }),
      'second-look/perp/check',
      'sample-user',
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(isPerpResponse(await response.json()));
    assert.equal(calls.length, 6);
    for (let i = 0; i < 4; i++)
      await assert.rejects(
        () =>
          perpRoutes(
            pool,
            request({ address: 'bad' }),
            'second-look/perp/check',
            'sample-user',
          ),
        (e) => e.code === 'INVALID_REQUEST',
      );
    await assert.rejects(
      () =>
        perpRoutes(
          pool,
          request({ address }),
          'second-look/perp/check',
          'sample-user',
        ),
      (e) => e.code === 'RATE_LIMITED',
    );
    assert.equal(calls.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

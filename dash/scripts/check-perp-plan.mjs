import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPerpPlan,
  estimateLiquidationPrice,
  losingCloseStreak,
  parsePerpPlanInput,
  validatePlanMarket,
  isPerpPlanResponse,
  isPlanMarketsResponse,
  PERP_PLAN_NETTING,
} from '../lib/second-look/perp-plan.ts';
import {
  DAY_MS,
  parsePerpAccount,
  parsePerpMarkets,
  parsePerpFills,
  parsePerpCandles,
} from '../lib/second-look/perp-check.ts';
import {
  collectPerpPlan,
  perpRoutes,
} from '../server/second-look/perp-routes.ts';
import { assertEndpointReleased } from '../server/core/feature-release.ts';
import { SECOND_LOOK_SWITCHES } from '../lib/second-look/releases.ts';
const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/perp-plan/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const { now, address, ...plan } = fixture('plan');
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const markets = () => parsePerpMarkets(fixture('markets'));
function input(overrides = {}) {
  return {
    plan: { ...plan },
    markets: markets(),
    now,
    candles: parsePerpCandles(fixture('candles')),
    ...overrides,
  };
}

test('published formula: isolated long and short, reusable with live position inputs', () => {
  // 1,000 notional at 100, 5x initial margin 200, maintenance 25, surplus 175.
  near(
    estimateLiquidationPrice({
      price: 100,
      side: 1,
      positionSize: 10,
      marginAvailable: 175,
      maxLeverage: 20,
    }),
    82.05128205128204,
  );
  near(
    estimateLiquidationPrice({
      price: 100,
      side: -1,
      positionSize: 10,
      marginAvailable: 175,
      maxLeverage: 20,
    }),
    117.07317073170732,
  );
  const long = buildPerpPlan(input());
  near(long.maintenance, 20);
  near(long.initialMargin, 200);
  near(long.marginAvailable, 180);
  near(long.liquidation, 1632.6530612244896);
  near(long.distance, (2000 - long.liquidation) / 2000);
  const short = buildPerpPlan(input({ plan: { ...plan, side: 'short' } }));
  near(short.liquidation, 2352.9411764705883);
  near(short.distance, (short.liquidation - 2000) / 2000);
  near(long.projected7, -3.36);
  near(short.projected7, 3.36);
  assert.equal(long.candleDays, 30);
  assert.equal(long.returnCount, 29);
  assert.ok(isPerpPlanResponse({ report: long }));
});

test('cross margin always uses the own-margin estimate, with or without an address', () => {
  const cross = { ...plan, marginMode: 'cross' };
  const own = buildPerpPlan(input({ plan: cross }));
  near(own.liquidation, 1632.6530612244896);
  assert.equal(own.basis, 'own-margin');
  const account = parsePerpAccount(fixture('account'));
  const report = buildPerpPlan(
    input({ plan: { ...cross, address }, account, fills: [] }),
  );
  // Account collateral never feeds the estimate: live checks showed cross estimates off by up to 147%.
  near(report.liquidation, own.liquidation);
  near(report.existingMaintenance, 0);
  near(report.collateral, report.initialMargin);
  near(report.effectiveNow, 5);
  near(report.effectiveAfter, 5.5);
  account.accountValue = -1;
  const underwater = buildPerpPlan(
    input({ plan: { ...cross, address }, account, fills: [] }),
  );
  assert.equal(underwater.effectiveAfter, null);
  near(underwater.liquidation, own.liquidation);
});

test('isolated ignores other margin; same-coin netting is never guessed', () => {
  const account = parsePerpAccount(fixture('account'));
  const r = buildPerpPlan(
    input({ plan: { ...plan, address }, account, fills: [] }),
  );
  near(r.liquidation, 1632.6530612244896);
  near(r.existingMaintenance, 0);
  near(r.collateral, 200);
  assert.throws(
    () =>
      buildPerpPlan(
        input({ plan: { ...plan, address, coin: 'BTC' }, account, fills: [] }),
      ),
    { message: PERP_PLAN_NETTING },
  );
});

test('leverage bounds, strict malformed input, finite formula and client response validation', () => {
  for (const leverage of [0, -1, 1.5, Infinity, '5', 1001])
    assert.throws(() => parsePerpPlanInput({ ...plan, leverage }));
  for (const leverage of [1, 25])
    validatePlanMarket(parsePerpPlanInput({ ...plan, leverage }), markets());
  assert.throws(() =>
    validatePlanMarket(
      parsePerpPlanInput({ ...plan, leverage: 26 }),
      markets(),
    ),
  );
  for (const patch of [
    { notional: 'NaN' },
    { notional: '1e3' },
    { notional: ' 1' },
    { notional: '0' },
    { notional: '-1' },
    { notional: 1000 },
    { notional: '1junk' },
    { notional: '9007199254740992' },
    { notional: '0.' + '0'.repeat(400) + '1' },
    { side: 'buy' },
    { marginMode: 'other' },
    { coin: 'dex:STOCK' },
    { coin: 'https://example.invalid' },
    { address: '' },
    { address: address + 'x' },
    { url: 'https://example.invalid' },
  ])
    assert.throws(() => parsePerpPlanInput({ ...plan, ...patch }));
  assert.throws(() =>
    validatePlanMarket({ ...plan, coin: 'UNKNOWN' }, markets()),
  );
  for (const patch of [
    { price: NaN },
    { side: 0 },
    { positionSize: 0 },
    { marginAvailable: Infinity },
    { maxLeverage: 0 },
  ]) {
    assert.throws(() =>
      estimateLiquidationPrice({
        price: 100,
        side: 1,
        positionSize: 10,
        marginAvailable: 175,
        maxLeverage: 20,
        ...patch,
      }),
    );
  }
  assert.ok(!isPerpPlanResponse({ report: {} }));
  const r = buildPerpPlan(input());
  assert.ok(!isPerpPlanResponse({ report: { ...r, projected7: Infinity } }));
  assert.ok(
    !isPlanMarketsResponse({
      markets: [{ coin: 'BAD<script>', maxLeverage: 10 }],
    }),
  );
  assert.ok(
    !isPlanMarketsResponse({
      markets: [
        { coin: 'ETH', maxLeverage: 25 },
        { coin: 'ETH', maxLeverage: 25 },
      ],
    }),
  );
});

test('Cool Head counts losing closes newest first, skips openings/spot, stops on flat or winning close', () => {
  const fills = parsePerpFills(fixture('fills'));
  assert.equal(losingCloseStreak(fills.toReversed()), 5);
  const open = { ...fills[0], time: now, dir: 'Open Long', closedPnl: 0 };
  const spot = { ...fills[0], time: now, spot: true, closedPnl: 50 };
  assert.equal(losingCloseStreak([...fills, open, spot]), 5);
  assert.equal(
    losingCloseStreak([...fills, { ...fills[0], time: now, closedPnl: 1 }]),
    0,
  );
  assert.equal(
    losingCloseStreak([...fills, { ...fills[0], time: now, closedPnl: 0 }]),
    0,
  );
  assert.equal(
    losingCloseStreak([
      ...fills,
      { ...fills[0], time: now, dir: 'Long > Short' },
    ]),
    6,
  );
  assert.equal(
    losingCloseStreak([{ ...fills[0], dir: 'Liquidated Cross Long' }]),
    1,
  );
  assert.equal(losingCloseStreak([]), 0);
  const account = parsePerpAccount(fixture('account'));
  const report = buildPerpPlan(
    input({
      plan: { ...plan, address },
      account,
      fills: [...fills, { ...fills[0], time: now + 1, closedPnl: 1 }],
    }),
  );
  assert.equal(report.losingStreak, 5);
  const capped = buildPerpPlan(
    input({
      plan: { ...plan, address },
      account,
      fills: Array.from({ length: 2000 }, () => fills[0]),
    }),
  );
  assert.ok(capped.fillsCapped);
});

function transport(calls) {
  return async (url, init) => {
    assert.equal(url, 'https://api.hyperliquid.xyz/info');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    const body = JSON.parse(init.body);
    calls.push(body);
    const data =
      body.type === 'metaAndAssetCtxs'
        ? fixture('markets')
        : body.type === 'candleSnapshot'
          ? fixture('candles').map((c) => ({ ...c, s: body.req.coin }))
          : body.type === 'clearinghouseState'
            ? fixture('account')
            : body.type === 'userFillsByTime'
              ? fixture('fills')
              : assert.fail('Unexpected external request');
    return new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  };
}
test('collector exact request bodies, four-call bound and no account calls without address', async () => {
  const calls = [];
  const r = await collectPerpPlan(
    { ...plan, address },
    new AbortController().signal,
    transport(calls),
    now,
  );
  assert.equal(r.losingStreak, 5);
  assert.ok(isPerpPlanResponse({ report: r }));
  const candleEnd = Math.floor(now / DAY_MS) * DAY_MS - 1;
  assert.deepEqual(calls, [
    { type: 'metaAndAssetCtxs' },
    {
      type: 'candleSnapshot',
      req: {
        coin: 'ETH',
        interval: '1d',
        startTime: candleEnd + 1 - 30 * DAY_MS,
        endTime: candleEnd,
      },
    },
    { type: 'clearinghouseState', user: address },
    { type: 'userFillsByTime', user: address, startTime: now - 30 * DAY_MS },
  ]);
  const noAddress = [];
  await collectPerpPlan(
    plan,
    new AbortController().signal,
    transport(noAddress),
    now,
  );
  assert.equal(noAddress.length, 2);
  const rejected = [];
  await assert.rejects(() =>
    collectPerpPlan(
      { ...plan, leverage: 26 },
      new AbortController().signal,
      transport(rejected),
      now,
    ),
  );
  assert.equal(rejected.length, 1);
  await assert.rejects(() =>
    collectPerpPlan(
      plan,
      new AbortController().signal,
      async () =>
        new Response('[{}]', {
          headers: { 'content-type': 'application/json' },
        }),
      now,
    ),
  );
});

test('routes: held gates, authenticated, strict input, no DB writes, no-store, rate limits', async () => {
  assert.equal(SECOND_LOOK_SWITCHES.perp, false);
  assert.equal(SECOND_LOOK_SWITCHES.perpPlan, false);
  for (const path of [
    'second-look/perp-plan/check',
    'second-look/perp-plan/markets',
  ])
    assert.throws(
      () => assertEndpointReleased(path, 'POST'),
      (e) => e.code === 'FEATURE_UNAVAILABLE',
    );
  const pool = {
    query() {
      assert.fail('Tool must never access the database');
    },
  };
  const request = (body) =>
    new Request('https://example.invalid/api/second-look/perp-plan/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const check = (body, id = 'demo-account') =>
    perpRoutes(pool, request(body), 'second-look/perp-plan/check', id);
  await assert.rejects(
    () => check(plan, ''),
    (e) => e.code === 'SIGN_IN_REQUIRED',
  );
  for (const body of [
    {},
    { ...plan, notional: 'NaN' },
    { ...plan, address: 'bad' },
    { ...plan, extra: true },
  ])
    await assert.rejects(
      () => check(body),
      (e) => e.code === 'INVALID_REQUEST',
    );
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = transport(calls);
  try {
    const m = await perpRoutes(
      pool,
      request({}),
      'second-look/perp-plan/markets',
      'sample-user',
    );
    assert.ok(isPlanMarketsResponse(await m.json()));
    assert.equal(m.headers.get('cache-control'), 'no-store');
    const r = await check(plan, 'sample-user');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(isPerpPlanResponse(await r.json()));
    assert.equal(calls.length, 3);
    await assert.rejects(
      () => check({ ...plan, coin: 'BTC', address }, 'sample-user'),
      (e) => e.code === 'INVALID_REQUEST' && e.message === PERP_PLAN_NETTING,
    );
    await assert.rejects(
      () => check({ ...plan, leverage: 26 }, 'sample-user'),
      (e) => e.status === 400,
    );
    await assert.rejects(
      () => check({}, 'sample-user'),
      (e) => e.code === 'INVALID_REQUEST',
    );
    const count = calls.length;
    await assert.rejects(
      () => check(plan, 'sample-user'),
      (e) => e.code === 'RATE_LIMITED',
    );
    assert.equal(calls.length, count);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a losing streak counts orders, not fills, and is withheld when history is capped', () => {
  const fill = (oid, time, closedPnl) => ({ coin: 'ETH', spot: false, time, dir: 'Close Long', closedPnl, fee: 0, oid });
  // One losing order filled 10 times, then two more losing orders: three trades, not twelve.
  const fills = [
    ...Array.from({ length: 10 }, (_, i) => fill(1, 1000 + i, -1)),
    fill(2, 2000, -5),
    fill(3, 3000, -2),
    fill(4, 500, 7),
  ];
  assert.equal(losingCloseStreak(fills), 3);
  assert.equal(losingCloseStreak([...fills, fill(5, 4000, 3)]), 0);
});

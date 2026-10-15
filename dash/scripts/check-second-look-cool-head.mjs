import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCoolHead,
  localDay,
  validCoolHeadRules,
} from '../server/second-look/cool-head.ts';
import { defaultCoolHeadRules } from '../lib/second-look/cool-head.ts';
import { coolHeadResponse } from '../lib/client/cool-head-contracts.ts';
const mint = 'So11111111111111111111111111111111111111112';
const now = '2026-10-12T04:00:00.000Z';
const settings = {
  enabled: true,
  timezone: 'UTC',
  dailyBudgetUsd6: '100000000',
};
const buy = (id, at = now, extra = {}) => ({
  id,
  walletId: '00000000-0000-4000-8000-000000000001',
  mint,
  at,
  grossUsd6: '25000000',
  priceUsd: '3',
  hourAgoPriceUsd: '1',
  outcome: null,
  ...extra,
});
const run = (extra = {}) =>
  evaluateCoolHead({
    settings,
    asOf: now,
    coverage: true,
    buys: [],
    closes: [],
    ...extra,
  });
test('empty history is empty and never a population claim', () => {
  const r = run({ coverage: false });
  assert.equal(r.today.grossUsd6, '0');
  assert.equal(r.today.complete, false);
  assert.equal(r.suggestedBudgetUsd6, null);
  assert.deepEqual(r.nudges, []);
  assert(coolHeadResponse({ summary: r }));
});
test('chase boundary uses exact ratios; missing quotes remain unavailable', () => {
  assert(run({ buys: [buy('a')] }).nudges.some((n) => n.signal === 'chase'));
  assert(
    !run({
      buys: [buy('a', now, { priceUsd: '2.999999999999999999' })],
    }).nudges.some((n) => n.signal === 'chase'),
  );
  assert(
    run({
      buys: [buy('a', now, { hourAgoPriceUsd: null })],
    }).unavailable.includes('chase'),
  );
});
test('revenge only after a known close within the configured interval', () => {
  const close = {
    walletId: '00000000-0000-4000-8000-000000000001',
    mint,
    at: '2026-10-12T03:50:00.000Z',
    pnlUsd6: '-1',
  };
  assert(
    run({ buys: [buy('a')], closes: [close] }).nudges.some(
      (n) => n.signal === 'revenge',
    ),
  );
  assert(
    !run({
      buys: [buy('a')],
      closes: [{ ...close, at: '2026-10-12T03:49:59.000Z' }],
    }).nudges.some((n) => n.signal === 'revenge'),
  );
});
test('streak is suppressed with partial history and resets on flat or winning closes', () => {
  const closes = Array.from({ length: 5 }, (_, i) => ({
    walletId: '00000000-0000-4000-8000-000000000001',
    mint,
    at: `2026-10-12T03:0${i}:00.000Z`,
    pnlUsd6: '-1',
  }));
  assert(
    run({ buys: [buy('a')], closes }).nudges.some((n) => n.signal === 'streak'),
  );
  assert(
    !run({ coverage: false, buys: [buy('a')], closes }).nudges.some(
      (n) => n.signal === 'streak',
    ),
  );
  assert(
    !run({
      buys: [buy('a')],
      closes: [
        ...closes,
        { ...closes[0], at: '2026-10-12T03:30:00.000Z', pnlUsd6: '0' },
      ],
    }).nudges.some((n) => n.signal === 'streak'),
  );
});
test('night uses the selected local day and handles DST', () => {
  assert.equal(
    localDay('2026-11-01T05:30:00.000Z', 'America/New_York'),
    '2026-11-01',
  );
  assert.equal(
    localDay('2026-11-01T06:30:00.000Z', 'America/New_York'),
    '2026-11-01',
  );
  const closes = [
    {
      walletId: '00000000-0000-4000-8000-000000000001',
      mint,
      at: '2026-10-12T02:59:00.000Z',
      pnlUsd6: '-1',
    },
  ];
  assert(
    run({ buys: [buy('a')], closes }).nudges.some((n) => n.signal === 'night'),
  );
  assert(
    !run({
      settings: { ...settings, timezone: 'America/New_York' },
      buys: [buy('a')],
      closes,
    }).nudges.some((n) => n.signal === 'night'),
  );
});
test('budget dedupes duplicate events and records both alert thresholds distinctly', () => {
  const eighty = buy('a', now, { grossUsd6: '80000000' });
  const r = run({ buys: [eighty, eighty] });
  assert.equal(r.today.grossUsd6, '80000000');
  assert.equal(r.today.usedBps, 8000);
  const full = run({ buys: [{ ...eighty, grossUsd6: '100000000' }] });
  assert.notEqual(
    r.nudges.find((n) => n.signal === 'budget').id,
    full.nudges.find((n) => n.signal === 'budget').id,
  );
});
test('incomplete prices report observed lower bound but do not suggest a budget', () => {
  const r = run({
    buys: [
      buy('a', now, { grossUsd6: null }),
      buy('b', now, { grossUsd6: '80000000' }),
    ],
  });
  assert.equal(r.today.grossUsd6, '80000000');
  assert.equal(r.today.complete, false);
  assert.equal(r.suggestedBudgetUsd6, null);
  assert(r.exceptions.includes('HISTORICAL_PRICES_MISSING'));
});
test('size creep requires complete history, a losing previous day and >2x median', () => {
  const buys = [
    buy('a', '2026-10-10T04:00:00.000Z'),
    buy('b', '2026-10-11T04:00:00.000Z'),
    buy('c', now, { grossUsd6: '50000001' }),
  ];
  const closes = [
    {
      walletId: '00000000-0000-4000-8000-000000000001',
      mint,
      at: '2026-10-11T10:00:00.000Z',
      pnlUsd6: '-1',
    },
  ];
  assert(run({ buys, closes }).nudges.some((n) => n.signal === 'size'));
  assert(
    !run({
      buys: buys.map((b) =>
        b.id === 'c' ? { ...b, grossUsd6: '50000000' } : b,
      ),
      closes,
    }).nudges.some((n) => n.signal === 'size'),
  );
});
test('personal rates require 10 known past outcomes and verified coverage', () => {
  const old = Array.from({ length: 10 }, (_, i) =>
    buy(`h${i}`, `2026-10-${String(i + 1).padStart(2, '0')}T04:00:00.000Z`, {
      outcome: i < 8 ? 'loss' : 'win',
      outcomeAt: `2026-10-${String(i + 1).padStart(2, '0')}T05:00:00.000Z`,
    }),
  );
  const r = run({ buys: [...old, buy('current')] });
  const n = r.nudges.find((x) => x.signal === 'chase');
  assert.equal(n.baseRate.sample, 10);
  assert.equal(n.baseRate.losses, 8);
  assert.equal(n.baseRate.scope, 'personal');
  assert.equal(
    run({ coverage: false, buys: [...old, buy('current')] }).nudges.find(
      (x) => x.signal === 'chase',
    ).baseRate,
    null,
  );
});
test('population rates must have verified recent source evidence', () => {
  const rate = {
    signal: 'chase',
    sample: 100,
    losses: 68,
    through: '2026-10-10T00:00:00.000Z',
    sourceId: 'reviewed-index',
    verified: true,
  };
  assert.equal(
    run({ buys: [buy('a')], population: [rate] }).nudges[0].baseRate.scope,
    'population',
  );
  assert.equal(
    run({
      buys: [buy('a')],
      population: [{ ...rate, through: '2026-09-01T00:00:00.000Z' }],
    }).nudges[0].baseRate,
    null,
  );
});
test('off suppresses all nudges; custom rules are bounded; factual copy avoids shame', () => {
  const r = run({
    settings: { ...settings, enabled: false },
    buys: [buy('a')],
  });
  assert.deepEqual(r.nudges, []);
  assert(validCoolHeadRules(defaultCoolHeadRules));
  assert(!validCoolHeadRules({ ...defaultCoolHeadRules, nightEnd: 1 }));
  const on = run({ buys: [buy('a')] });
  assert(!/you should|addict|reckless/i.test(JSON.stringify(on)));
});
test('future events do not affect spending or a signal', () => {
  const r = run({ buys: [buy('future', '2026-10-12T05:00:00.000Z')] });
  assert.equal(r.indexedBuys, 0);
  assert.deepEqual(r.nudges, []);
});

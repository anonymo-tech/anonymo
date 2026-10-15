import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateFollowMetrics,
  FOLLOW_WINDOW_DAYS,
} from '../server/second-look/follow-metrics.ts';

const day = 86_400_000;
const asOf = '2026-10-12T12:00:00.000Z';
const end = Date.parse(asOf);
const start = end - FOLLOW_WINDOW_DAYS * day;
const at = (offset) => new Date(end - day + offset * 1_000).toISOString();
const mint = 'fixture-mint';
const coverage = {
  sourceId: 'reviewed-fixture',
  snapshotId: 'snapshot-1',
  from: new Date(start).toISOString(),
  through: asOf,
  transactionsComplete: true,
  normalizationReviewed: true,
  feePolicyReviewed: true,
  openingPositionsComplete: true,
  unresolvedEvents: 0,
};
function event(n, kind, amount = '10', quote = '100000000', extra = {}) {
  return {
    id: `event-${n}`,
    signature: `signature-${n}`,
    slot: String(100 + n),
    transactionIndex: 0,
    eventIndex: 0,
    at: at(n),
    feesUsd6: '0',
    mint,
    decimals: 0,
    amountAtoms: amount,
    kind,
    quoteUsd6: quote,
    valuation: 'verified',
    ...extra,
  };
}
function mark(extra = {}) {
  return {
    mint,
    sourceId: 'reviewed-market',
    observedAt: asOf,
    verified: true,
    amountAtoms: '10',
    marketValueUsd6: '120000000',
    lastTradeAt: at(300),
    liquidityUsd6: '1000000000',
    ...extra,
  };
}
function creation(extra = {}) {
  return {
    mint,
    slot: '100',
    signature: 'creation-proof',
    sourceId: 'reviewed-index',
    indexedMintCreation: true,
    ...extra,
  };
}
function input(events = [], extra = {}) {
  return {
    wallet: 'fixture-wallet',
    asOf,
    coverage,
    openingPositions: [],
    events,
    mintCreations: [creation()],
    ...extra,
  };
}
function trip(n, profit = 18_000_000n, extra = {}) {
  return [
    event(n, 'buy', '10', '100000000', { feesUsd6: '1000000', ...extra }),
    event(n + 1, 'sell', '10', String(102_000_000n + profit), {
      feesUsd6: '1000000',
      ...extra,
    }),
  ];
}
function value(metric, expected) {
  assert.equal(metric.status, 'available');
  assert.equal(metric.value, expected);
}
function missing(metric, reason) {
  assert.equal(metric.status, 'unavailable');
  assert.equal(metric.value, null);
  if (reason)
    assert.ok(metric.reasons.includes(reason), `${reason}: ${metric.reasons}`);
}

test('twenty fee-inclusive round trips produce exact metrics and a sufficient sample', () => {
  const events = Array.from({ length: 20 }, (_, i) => trip(i * 2 + 1)).flat();
  const result = calculateFollowMetrics(input(events));
  value(result.realizedPnlUsd6, '360000000');
  value(result.unrealizedPnlUsd6, '0');
  value(result.winRateBps, 10_000);
  value(result.medianHoldSeconds, 1);
  value(result.maxDrawdownUsd6, '0');
  value(result.top3ProfitShareBps, 1_500);
  assert.deepEqual(result.sample, {
    trades: 40,
    buys: 20,
    roundTrips: 20,
    complete: true,
    tooSmall: false,
  });
  assert.equal(result.window.coveredDays, 90);
});

test('sub-dollar integer math above Number precision keeps acquisition and exit fees exact', () => {
  const result = calculateFollowMetrics(
    input([
      event(1, 'buy', '3', '9007199254740993', { feesUsd6: '2' }),
      event(2, 'sell', '1', '3002399751580333', { feesUsd6: '1' }),
      event(3, 'sell', '2', '6004799503160666'),
    ]),
  );
  value(result.realizedPnlUsd6, '3');
  assert.equal(result.roundTrips[0].pnlUsd6, '3');
});

test('average-cost partial disposals differ correctly from FIFO', () => {
  const result = calculateFollowMetrics(
    input(
      [
        event(1, 'buy', '2', '2000000'),
        event(2, 'buy', '2', '6000000'),
        event(3, 'sell', '2', '5000000'),
      ],
      { marks: [mark({ amountAtoms: '2', marketValueUsd6: '4000000' })] },
    ),
  );
  value(result.realizedPnlUsd6, '1000000');
  value(result.unrealizedPnlUsd6, '0');
  assert.equal(result.sample.roundTrips, 0);
  missing(result.winRateBps, 'NO_COMPLETED_ROUND_TRIPS');
});

test('remaining micro-dollar basis is exhausted exactly on the final exit', () => {
  const result = calculateFollowMetrics(
    input([
      event(1, 'buy', '3', '2'),
      event(2, 'sell', '1', '1'),
      event(3, 'sell', '1', '1'),
      event(4, 'sell', '1', '1'),
    ]),
  );
  value(result.realizedPnlUsd6, '1');
  assert.equal(result.roundTrips[0].pnlUsd6, '1');
});

test('drawdown is the cumulative realized peak-to-trough fall, not the largest single loss', () => {
  const result = calculateFollowMetrics(
    input([...trip(1, 10n), ...trip(3, -12n), ...trip(5, -8n), ...trip(7, 5n)]),
  );
  value(result.realizedPnlUsd6, '-5');
  value(result.maxDrawdownUsd6, '20');
  value(result.winRateBps, 5_000);
});

test('fees from failed or fee-only transactions reduce realized P&L and drawdown once', () => {
  const fee = {
    id: 'failed',
    signature: 'failed-signature',
    slot: '103',
    transactionIndex: 0,
    eventIndex: 0,
    at: at(3),
    kind: 'fee',
    feesUsd6: '19000000',
  };
  const result = calculateFollowMetrics(input([...trip(1), fee, fee]));
  value(result.realizedPnlUsd6, '-1000000');
  value(result.maxDrawdownUsd6, '19000000');
  assert.equal(result.sample.trades, 2);
});

test('median hold includes partial exits only when the position fully closes', () => {
  const result = calculateFollowMetrics(
    input([
      event(1, 'buy'),
      event(2, 'sell', '5', '60000000'),
      event(4, 'sell', '5', '60000000'),
      event(10, 'buy'),
      event(12, 'sell', '10', '120000000'),
    ]),
  );
  value(result.medianHoldSeconds, 2.5);
  assert.equal(result.sample.roundTrips, 2);
});

test('top-three share divides by positive fee-adjusted trip gains and never includes losses', () => {
  const result = calculateFollowMetrics(
    input([
      ...trip(1, 10n),
      ...trip(3, 20n),
      ...trip(5, 30n),
      ...trip(7, 40n),
      ...trip(9, -50n),
    ]),
  );
  value(result.top3ProfitShareBps, 9_000);
});

test('small samples are explicit even when the arithmetic is complete', () => {
  const result = calculateFollowMetrics(input(trip(1)));
  value(result.realizedPnlUsd6, '18000000');
  assert.equal(result.sample.tooSmall, true);
  assert.ok(result.limitations.includes('SAMPLE_TOO_SMALL'));
});

test('empty but proven history has zero realized P&L, never invented rates', () => {
  const result = calculateFollowMetrics(input());
  value(result.realizedPnlUsd6, '0');
  missing(result.winRateBps, 'NO_COMPLETED_ROUND_TRIPS');
  missing(result.medianHoldSeconds, 'NO_COMPLETED_ROUND_TRIPS');
  missing(result.top3ProfitShareBps, 'NO_POSITIVE_ROUND_TRIPS');
  missing(result.firstBlockBuyRateBps, 'NO_BUYS_IN_WINDOW');
});

test('missing archive evidence never reports an empty wallet as zero performance', () => {
  const result = calculateFollowMetrics(input([], { coverage: null }));
  missing(result.realizedPnlUsd6, 'HISTORY_COVERAGE_UNAVAILABLE');
  missing(result.maxDrawdownUsd6, 'HISTORY_COVERAGE_UNAVAILABLE');
  missing(result.firstBlockBuyRateBps, 'HISTORY_COVERAGE_UNAVAILABLE');
  assert.equal(result.window.coveredDays, null);
  assert.equal(result.sample.complete, false);
});

test('partial 90-day history, unresolved events and unreviewed normalization fail closed', () => {
  for (const changed of [
    { from: new Date(start + day).toISOString() },
    { through: new Date(end - day).toISOString() },
    { transactionsComplete: false },
    { unresolvedEvents: 1 },
    { normalizationReviewed: false },
  ]) {
    const result = calculateFollowMetrics(
      input(trip(1), { coverage: { ...coverage, ...changed } }),
    );
    missing(result.realizedPnlUsd6);
    missing(result.firstBlockBuyRateBps);
    assert.equal(result.sample.complete, false);
  }
});

test('unverified fee policy and unavailable fee prices cannot show net P&L', () => {
  const events = trip(1);
  missing(
    calculateFollowMetrics(
      input(events, { coverage: { ...coverage, feePolicyReviewed: false } }),
    ).realizedPnlUsd6,
    'FEE_COVERAGE_UNVERIFIED',
  );
  events[0].feesUsd6 = null;
  const result = calculateFollowMetrics(input(events));
  missing(result.realizedPnlUsd6, 'FEE_PRICE_UNAVAILABLE');
  value(result.firstBlockBuyRateBps, 10_000);
});

test('estimated historical prices remain unavailable for precise performance claims', () => {
  const events = trip(1);
  events[0].valuation = 'estimated';
  const result = calculateFollowMetrics(input(events));
  missing(result.realizedPnlUsd6, 'ESTIMATED_TRADE_PRICE');
  missing(result.winRateBps);
  value(result.firstBlockBuyRateBps, 10_000);
});

test('missing historical quote is not replaced by current price or zero', () => {
  const events = trip(1);
  events[0].quoteUsd6 = null;
  missing(
    calculateFollowMetrics(input(events, { marks: [mark()] })).realizedPnlUsd6,
    'TRADE_PRICE_UNAVAILABLE',
  );
});

test('opening basis separates window P&L from the complete round-trip result', () => {
  const firstBuyAt = new Date(start - day).toISOString();
  const result = calculateFollowMetrics(
    input([event(1, 'sell', '10', '50000000')], {
      openingPositions: [
        {
          mint,
          decimals: 0,
          amountAtoms: '10',
          basisUsd6: '100000000',
          firstBuyAt,
          priorRealizedUsd6: '50000000',
        },
      ],
    }),
  );
  value(result.realizedPnlUsd6, '-50000000');
  value(result.winRateBps, 0);
  assert.equal(result.roundTrips[0].pnlUsd6, '0');
  value(
    result.medianHoldSeconds,
    (Date.parse(at(1)) - Date.parse(firstBuyAt)) / 1_000,
  );
});

test('unknown pre-window partial exits suppress whole-trip scoring without inventing losses', () => {
  const result = calculateFollowMetrics(
    input([event(1, 'sell', '10', '120000000')], {
      openingPositions: [
        {
          mint,
          decimals: 0,
          amountAtoms: '10',
          basisUsd6: '100000000',
          firstBuyAt: new Date(start - day).toISOString(),
          priorRealizedUsd6: null,
        },
      ],
    }),
  );
  value(result.realizedPnlUsd6, '20000000');
  missing(result.winRateBps, 'ROUND_TRIP_BASIS_UNAVAILABLE');
  missing(result.top3ProfitShareBps, 'ROUND_TRIP_BASIS_UNAVAILABLE');
});

test('missing opening inventory or opening cost basis cannot be silently assumed empty', () => {
  const opening = {
    mint,
    decimals: 0,
    amountAtoms: '10',
    basisUsd6: null,
    firstBuyAt: new Date(start - day).toISOString(),
    priorRealizedUsd6: '0',
  };
  missing(
    calculateFollowMetrics(
      input([event(1, 'sell')], { openingPositions: [opening] }),
    ).realizedPnlUsd6,
    'OPENING_BASIS_UNAVAILABLE',
  );
  missing(
    calculateFollowMetrics(input([event(1, 'sell')])).realizedPnlUsd6,
    'POSITION_HISTORY_INCOMPLETE',
  );
  missing(
    calculateFollowMetrics(
      input(trip(1), {
        coverage: { ...coverage, openingPositionsComplete: false },
      }),
    ).realizedPnlUsd6,
    'OPENING_POSITIONS_UNVERIFIED',
  );
});

test('events outside the exact window are ignored and cannot change period realized results', () => {
  const past = event(50, 'buy', '10', '999999999', {
    at: new Date(start - 1).toISOString(),
  });
  const future = event(60, 'sell', '10', '999999999', {
    at: new Date(end + 1).toISOString(),
  });
  value(
    calculateFollowMetrics(input([...trip(1), past, future])).realizedPnlUsd6,
    '18000000',
  );
});

test('verified dead positions close at zero and enter the losing round-trip denominator', () => {
  for (const evidence of [
    { liquidityUsd6: '99999999' },
    { lastTradeAt: new Date(end - 7 * day - 1).toISOString() },
  ]) {
    const result = calculateFollowMetrics(
      input([event(1, 'buy', '10', '100000000', { feesUsd6: '1000000' })], {
        marks: [mark(evidence)],
      }),
    );
    value(result.realizedPnlUsd6, '-101000000');
    value(result.unrealizedPnlUsd6, '0');
    value(result.winRateBps, 0);
    value(result.maxDrawdownUsd6, '101000000');
    assert.equal(result.roundTrips[0].closeReason, 'dead');
  }
});

test('the no-market boundaries are strict: $100 and seven days are not below/older', () => {
  const result = calculateFollowMetrics(
    input([event(1, 'buy')], {
      marks: [
        mark({
          liquidityUsd6: '100000000',
          lastTradeAt: new Date(end - 7 * day).toISOString(),
        }),
      ],
    }),
  );
  value(result.realizedPnlUsd6, '0');
  value(result.unrealizedPnlUsd6, '20000000');
  assert.equal(result.roundTrips.length, 0);
});

test('missing, stale, mismatched or unverified market evidence cannot invent dead closures', () => {
  for (const marks of [
    [],
    [mark({ verified: false })],
    [
      mark({
        observedAt: new Date(end - 300_001).toISOString(),
        liquidityUsd6: '1',
      }),
    ],
    [mark({ amountAtoms: '9' })],
    [mark({ lastTradeAt: null })],
  ]) {
    const result = calculateFollowMetrics(input([event(1, 'buy')], { marks }));
    missing(result.realizedPnlUsd6);
    missing(result.unrealizedPnlUsd6);
    assert.equal(result.roundTrips.length, 0);
  }
});

test('an active market with unknown valuation keeps unrealized unavailable but realized known', () => {
  const result = calculateFollowMetrics(
    input([event(1, 'buy')], { marks: [mark({ marketValueUsd6: null })] }),
  );
  value(result.realizedPnlUsd6, '0');
  missing(result.unrealizedPnlUsd6, 'ENDING_VALUATION_OR_BASIS_UNAVAILABLE');
});

test('transfers to unlinked wallets dispose at historical market value for Follow Check', () => {
  const result = calculateFollowMetrics(
    input([
      event(1, 'buy'),
      event(2, 'transfer-out', '10', '125000000', { feesUsd6: '2000000' }),
    ]),
  );
  value(result.realizedPnlUsd6, '23000000');
  assert.equal(result.roundTrips[0].closeReason, 'transfer-out');
  assert.equal(result.sample.trades, 1);
});

test('incoming transfer basis must be proven, including its first buy and earlier partial exits', () => {
  const transfer = {
    id: 'incoming',
    signature: 'incoming-signature',
    slot: '101',
    transactionIndex: 0,
    eventIndex: 0,
    at: at(1),
    feesUsd6: '1000000',
    mint,
    decimals: 0,
    amountAtoms: '10',
    kind: 'transfer-in',
    basisUsd6: '80000000',
    firstBuyAt: at(0),
    priorRealizedUsd6: '5000000',
  };
  const sale = event(2, 'sell', '10', '100000000');
  const result = calculateFollowMetrics(input([transfer, sale]));
  value(result.realizedPnlUsd6, '19000000');
  assert.equal(result.roundTrips[0].pnlUsd6, '24000000');
  value(result.medianHoldSeconds, 2);
  missing(
    calculateFollowMetrics(input([{ ...transfer, basisUsd6: null }, sale]))
      .realizedPnlUsd6,
    'TRANSFER_BASIS_UNAVAILABLE',
  );
});

test('explicit zero basis is allowed but no first-buy timestamp is fabricated', () => {
  const result = calculateFollowMetrics(
    input([event(1, 'sell')], {
      openingPositions: [
        {
          mint,
          decimals: 0,
          amountAtoms: '10',
          basisUsd6: '0',
          firstBuyAt: null,
          priorRealizedUsd6: '0',
        },
      ],
    }),
  );
  value(result.realizedPnlUsd6, '100000000');
  missing(result.medianHoldSeconds, 'FIRST_BUY_TIME_UNAVAILABLE');
  missing(result.winRateBps, 'FIRST_BUY_TIME_UNAVAILABLE');
  assert.equal(result.sample.roundTrips, 0);
  assert.equal(result.sample.complete, false);
});

test('first-block buys use indexed create slots zero through four, excluding slot five', () => {
  const result = calculateFollowMetrics(
    input([...trip(0), ...trip(4), ...trip(6)]),
  );
  value(result.firstBlockBuyRateBps, 6_666);
});

test('one missing or conflicting mint creation makes the complete first-block rate unknown', () => {
  for (const mintCreations of [
    [],
    [creation({ indexedMintCreation: false })],
    [creation({ signature: '' })],
    [creation({ slot: '200' })],
  ]) {
    const result = calculateFollowMetrics(input(trip(1), { mintCreations }));
    missing(result.firstBlockBuyRateBps);
    value(result.realizedPnlUsd6, '18000000');
  }
  const result = calculateFollowMetrics(
    input([...trip(1), ...trip(3, 18_000_000n, { mint: 'second-mint' })]),
  );
  missing(result.firstBlockBuyRateBps, 'INDEXED_MINT_CREATION_UNAVAILABLE');
});

test('unproven same-slot transaction ordering suppresses order-sensitive metrics', () => {
  const result = calculateFollowMetrics(
    input([
      event(1, 'buy', '10', '100000000', {
        slot: '101',
        transactionIndex: null,
      }),
      event(2, 'sell', '10', '120000000', {
        slot: '101',
        transactionIndex: null,
      }),
    ]),
  );
  missing(result.realizedPnlUsd6, 'INTRA_SLOT_ORDER_UNVERIFIED');
});

test('transaction ordinals and instruction/event indices prove deterministic same-slot order', () => {
  const buy = event(1, 'buy', '10', '100000000', {
    slot: '101',
    transactionIndex: 0,
  });
  const sell = event(2, 'sell', '10', '120000000', {
    slot: '101',
    transactionIndex: 1,
  });
  const expected = calculateFollowMetrics(input([buy, sell]));
  assert.deepEqual(calculateFollowMetrics(input([sell, buy, buy])), expected);
  value(expected.realizedPnlUsd6, '20000000');
});

test('unknown event time is a coverage hole, even when all visible trades look complete', () => {
  const result = calculateFollowMetrics(
    input([...trip(1), event(10, 'buy', '10', '100000000', { at: null })]),
  );
  missing(result.realizedPnlUsd6, 'EVENT_TIME_UNAVAILABLE');
});

test('wallet-only evidence never produces follower, cluster, wallet-age or burst statistics', () => {
  const result = calculateFollowMetrics(
    input(Array.from({ length: 25 }, (_, i) => trip(i * 2 + 1)).flat()),
  );
  missing(
    result.exitIntoFollowersRateBps,
    'WHOLE_CHAIN_FOLLOWER_GRAPH_UNAVAILABLE',
  );
  missing(result.possiblyLinkedWallets, 'FUNDING_GRAPH_UNAVAILABLE');
  missing(result.walletAgeDays, 'FUNDING_GRAPH_UNAVAILABLE');
});

test('malformed, conflicting and duplicate accounting evidence is rejected', () => {
  const original = event(1, 'buy');
  for (const invalid of [
    input([original, { ...original, quoteUsd6: '1' }]),
    input([original, { ...original, id: 'other-id' }]),
    input([event(1, 'buy', '-1')]),
    input([{ ...original, kind: 'linked-transfer' }]),
    input([
      original,
      { ...original, id: 'other-event', eventIndex: 1, slot: '102' },
    ]),
    input([event(1, 'buy', '0')]),
    input([event(1, 'buy', '10', '-100')]),
    input([event(1, 'buy', '10', '100', { feesUsd6: '-1' })]),
    input([event(1, 'buy', '10', '100', { decimals: 19 })]),
    input([event(1, 'buy', '10', '100', { at: '2026-02-30T12:00:00.000Z' })]),
    input([], { asOf: '2026-10-12T08:00:00-04:00' }),
    input([], { mintCreations: [creation(), creation()] }),
    input([], { coverage: { ...coverage, unresolvedEvents: -1 } }),
  ])
    assert.throws(() => calculateFollowMetrics(invalid));
});

test('source amounts are bounded and no caller arrays are mutated', () => {
  const events = [...trip(3), ...trip(1)];
  const snapshot = JSON.stringify(events);
  calculateFollowMetrics(input(events));
  assert.equal(JSON.stringify(events), snapshot);
  assert.throws(() =>
    calculateFollowMetrics(input([event(1, 'buy', '1', '1'.repeat(39))])),
  );
  assert.throws(() =>
    calculateFollowMetrics(input(Array(100_001).fill(event(1, 'buy')))),
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExitWatchState,
  evaluateExitPlan,
} from '../server/second-look/exit-evaluator.ts';

const epoch = Date.parse('2026-10-12T12:00:00.000Z');
const at = (offset = 0) => new Date(epoch + offset).toISOString();
const basePlan = {
  id: 'plan-1',
  revision: '1',
  mint: 'So11111111111111111111111111111111111111112',
  quoteCurrency: 'USD',
  takeProfit: { price: '110', sizePercent: '50' },
  stop: { price: '90', sizePercent: '100' },
};
function quotes(price, crossPrice = price, offset = 0) {
  const common = {
    mint: basePlan.mint,
    quoteCurrency: basePlan.quoteCurrency,
    observedAt: at(offset),
  };
  return {
    now: at(offset),
    primary: { ...common, source: 'pool', id: `pool-${offset}`, price },
    crosscheck: {
      ...common,
      source: 'independent-price',
      id: `cross-${offset}`,
      price: crossPrice,
    },
  };
}
function evaluate(
  plan = basePlan,
  price = '100',
  crossPrice = price,
  offset = 0,
  state = createExitWatchState(plan),
) {
  return evaluateExitPlan(plan, state, quotes(price, crossPrice, offset));
}

await test('take-profit is inclusive, exact and contains a per-leg reminder only', () => {
  assert.equal(
    evaluate(basePlan, '109.999999999999999999').reminders.length,
    0,
  );
  const result = evaluate(basePlan, '110');
  assert.equal(result.status, 'triggered');
  assert.equal(result.reminders.length, 1);
  const [reminder] = result.reminders;
  assert.equal(reminder.kind, 'reminder');
  assert.equal(reminder.leg, 'take_profit');
  assert.equal(reminder.sizePercent, '50');
  assert.equal(reminder.thresholdPrice, '110');
  assert.equal(reminder.evidence.primary.price, '110');
  assert.equal('transaction' in reminder, false);
});

await test('stop is inclusive and does not cross on the next representable decimal', () => {
  assert.equal(evaluate(basePlan, '90.000000000000000001').reminders.length, 0);
  assert.equal(evaluate(basePlan, '90').reminders[0].leg, 'stop');
});

await test('quote disagreement uses exact >3%, not >=3% or rounded floats', () => {
  const plan = {
    ...basePlan,
    takeProfit: { price: '100', sizePercent: '20.25' },
  };
  assert.equal(evaluate(plan, '100', '103').status, 'triggered');
  assert.equal(evaluate(plan, '100', '97').status, 'triggered');
  assert.equal(
    evaluate(plan, '100', '103.000000000000000001').status,
    'quote_disagreement',
  );
  assert.equal(
    evaluate(plan, '100', '96.999999999999999999').status,
    'quote_disagreement',
  );
});

await test('disagreement delays a trigger until two independently fresh agreeing pairs', () => {
  let result = evaluate(basePlan, '120', '100');
  assert.equal(result.state.highWaterPrice, null);
  result = evaluate(basePlan, '120', '120', 1, result.state);
  assert.equal(result.status, 'confirming_agreement');
  assert.equal(result.reminders.length, 0);
  const first = result.state;
  result = evaluateExitPlan(basePlan, first, {
    ...quotes('120', '120', 2),
    crosscheck: quotes('120', '120', 1).crosscheck,
  });
  assert.equal(result.status, 'ignored_replay');
  assert.equal(result.state.agreeingReads, 1);
  result = evaluate(basePlan, '120', '120', 3, result.state);
  assert.equal(result.status, 'triggered');
  assert.equal(result.state.awaitingAgreement, false);
  assert.equal(result.state.agreeingReads, 0);
});

await test('new disagreement and missing quotes reset the consecutive agreement streak', () => {
  let result = evaluate(basePlan, '120', '100');
  result = evaluate(basePlan, '120', '120', 1, result.state);
  result = evaluate(basePlan, '120', '100', 2, result.state);
  assert.equal(result.state.agreeingReads, 0);
  result = evaluate(basePlan, '120', '120', 3, result.state);
  result = evaluateExitPlan(basePlan, result.state, {
    ...quotes('120', '120', 4),
    crosscheck: null,
  });
  assert.equal(result.status, 'quote_unavailable');
  assert.equal(result.state.agreeingReads, 0);
  result = evaluate(basePlan, '120', '120', 5, result.state);
  assert.equal(result.status, 'confirming_agreement');
  result = evaluate(basePlan, '120', '120', 6, result.state);
  assert.equal(result.status, 'triggered');
});

await test('a fresh primary disagreeing with an unchanged fresh crosscheck also enters the hold', () => {
  let result = evaluate(basePlan, '100');
  result = evaluateExitPlan(basePlan, result.state, {
    ...quotes('120', '120', 1),
    crosscheck: quotes('100').crosscheck,
  });
  assert.equal(result.status, 'quote_disagreement');
  result = evaluate(basePlan, '120', '120', 2, result.state);
  assert.equal(result.status, 'confirming_agreement');
  result = evaluate(basePlan, '120', '120', 3, result.state);
  assert.equal(result.status, 'triggered');
});

await test('missing, stale, future, zero, malformed and mismatched quotes never trigger', () => {
  const original = quotes('120');
  const cases = [
    { ...original, primary: null },
    { ...original, crosscheck: null },
    { ...original, now: at(30_001) },
    { ...original, primary: { ...original.primary, observedAt: at(1) } },
    ...['0', '-1', 'Infinity', '1e2', 'NaN', '1.1234567890123456789'].map(
      (price) => ({
        ...original,
        primary: { ...original.primary, price },
      }),
    ),
    { ...original, primary: { ...original.primary, mint: 'wrong-token' } },
    {
      ...original,
      crosscheck: { ...original.crosscheck, quoteCurrency: 'SOL' },
    },
    { ...original, crosscheck: { ...original.crosscheck, source: 'pool' } },
    {
      ...original,
      crosscheck: {
        ...original.crosscheck,
        observedAt: '2026-10-12T08:00:00.000-04:00',
      },
    },
  ];
  for (const input of cases) {
    const result = evaluateExitPlan(
      basePlan,
      createExitWatchState(basePlan),
      input,
    );
    assert.equal(result.reminders.length, 0);
    assert.equal(result.state.highWaterPrice, null);
    assert.ok(
      ['quote_unavailable', 'quote_stale', 'quote_invalid'].includes(
        result.status,
      ),
    );
  }
  assert.equal(
    evaluateExitPlan(basePlan, createExitWatchState(basePlan), {
      ...original,
      now: at(30_000),
    }).status,
    'triggered',
  );
});

await test('trailing follows only trusted highs and fires at the exact drawdown boundary', () => {
  const plan = {
    ...basePlan,
    takeProfit: undefined,
    stop: undefined,
    trailing: { distancePercent: '10', sizePercent: '75' },
  };
  let result = evaluate(plan, '100');
  result = evaluate(plan, '200', '200', 1, result.state);
  assert.equal(result.state.highWaterPrice, '200');
  result = evaluate(plan, '180.000000000000000001', undefined, 2, result.state);
  assert.equal(result.status, 'watching');
  result = evaluate(plan, '180', undefined, 3, result.state);
  assert.equal(result.reminders[0].leg, 'trailing_stop');
  assert.equal(result.reminders[0].thresholdPrice, '180');
  assert.equal(result.reminders[0].sizePercent, '75');
});

await test('a disputed price cannot manufacture a trailing high', () => {
  const plan = {
    ...basePlan,
    takeProfit: undefined,
    stop: undefined,
    trailing: { distancePercent: '10', sizePercent: '100' },
  };
  let result = evaluate(plan, '100');
  result = evaluate(plan, '1000', '100', 1, result.state);
  assert.equal(result.state.highWaterPrice, '100');
  result = evaluate(plan, '200', '200', 2, result.state);
  assert.equal(result.state.highWaterPrice, '100');
  result = evaluate(plan, '100', '100', 3, result.state);
  assert.equal(result.status, 'watching');
  assert.equal(result.state.highWaterPrice, '100');
});

await test('tiny prices and fractional trailing percentages are not rounded at trigger time', () => {
  const plan = {
    ...basePlan,
    takeProfit: undefined,
    stop: undefined,
    trailing: {
      distancePercent: '33.333333333333333333',
      sizePercent: '0.000000000000000001',
    },
  };
  let result = evaluate(plan, '0.000000000000000003');
  result = evaluate(plan, '0.000000000000000002', undefined, 1, result.state);
  assert.equal(result.status, 'triggered');
  assert.equal(
    result.reminders[0].thresholdPrice,
    '0.00000000000000000200000000000000000001',
  );
  assert.equal(result.reminders[0].sizePercent, '0.000000000000000001');
});

await test('large prices beyond safe integer range compare exactly', () => {
  const plan = {
    ...basePlan,
    stop: undefined,
    takeProfit: {
      price: '999999999999999998.999999999999999999',
      sizePercent: '100',
    },
  };
  assert.equal(
    evaluate(plan, '999999999999999998.999999999999999998').status,
    'watching',
  );
  assert.equal(
    evaluate(plan, '999999999999999998.999999999999999999').status,
    'triggered',
  );
});

await test('state serializes, replay produces no repeat reminder, old-state retries have stable outbox IDs', () => {
  const state = createExitWatchState(basePlan),
    snapshot = structuredClone(state);
  const input = quotes('120');
  const first = evaluateExitPlan(basePlan, state, input);
  assert.deepEqual(state, snapshot);
  assert.deepEqual(input, quotes('120'));
  assert.equal(
    evaluateExitPlan(basePlan, state, input).reminders[0].id,
    first.reminders[0].id,
  );
  const persisted = JSON.parse(JSON.stringify(first.state));
  assert.equal(
    evaluateExitPlan(basePlan, persisted, input).status,
    'ignored_replay',
  );
  assert.equal(
    evaluate(basePlan, '121', undefined, 1, persisted).reminders.length,
    0,
  );
  const stop = evaluate(basePlan, '89', undefined, 2, persisted);
  assert.equal(stop.reminders[0].leg, 'stop');
  assert.notEqual(stop.reminders[0].id, first.reminders[0].id);
});

await test('out-of-order timestamps, duplicate IDs and reused data do not count as fresh observations', () => {
  const result = evaluate(basePlan, '100', '100', 100);
  assert.equal(
    evaluate(basePlan, '120', '120', 99, result.state).status,
    'ignored_replay',
  );
  const duplicateId = quotes('120', '120', 101);
  duplicateId.primary.id = 'pool-100';
  assert.equal(
    evaluateExitPlan(basePlan, result.state, duplicateId).status,
    'ignored_replay',
  );
  const duplicateTime = quotes('100', '100', 101);
  duplicateTime.crosscheck.observedAt = at(100);
  assert.equal(
    evaluateExitPlan(basePlan, result.state, duplicateTime).status,
    'ignored_replay',
  );
});

await test('plan revisions isolate reminders and edited thresholds cannot reuse old state', () => {
  const state = createExitWatchState(basePlan);
  assert.throws(() =>
    evaluate(
      { ...basePlan, takeProfit: { price: '111', sizePercent: '50' } },
      '120',
      '120',
      0,
      state,
    ),
  );
  assert.throws(() =>
    evaluate({ ...basePlan, revision: '2' }, '120', '120', 0, state),
  );
  assert.notEqual(
    evaluate(basePlan, '120').reminders[0].id,
    evaluate({ ...basePlan, revision: '2' }, '120').reminders[0].id,
  );
  const normalized = {
    ...basePlan,
    takeProfit: { price: '110.00', sizePercent: '50.0' },
  };
  assert.equal(
    evaluate(normalized, '120', '120', 0, state).status,
    'triggered',
  );
});

await test('invalid plans and corrupt durable state fail closed', () => {
  const invalid = [
    { ...basePlan, id: '' },
    { ...basePlan, takeProfit: undefined, stop: undefined },
    { ...basePlan, takeProfit: { price: '0', sizePercent: '50' } },
    { ...basePlan, takeProfit: { price: '90', sizePercent: '50' } },
    { ...basePlan, takeProfit: { price: '110', sizePercent: '0' } },
    {
      ...basePlan,
      takeProfit: { price: '110', sizePercent: '100.000000000000000001' },
    },
    { ...basePlan, trailing: { distancePercent: '100', sizePercent: '50' } },
    { ...basePlan, quoteMaxAgeMs: 0 },
    { ...basePlan, quoteMaxAgeMs: 300001 },
  ];
  for (const plan of invalid) assert.throws(() => createExitWatchState(plan));
  const state = createExitWatchState(basePlan);
  for (const corrupt of [
    { ...state, version: 2 },
    { ...state, agreeingReads: 2 },
    { ...state, agreeingReads: 1 },
    { ...state, emittedLegs: ['stop', 'stop'] },
    { ...state, emittedLegs: ['send_trade'] },
  ])
    assert.throws(() => evaluate(basePlan, '120', '120', 0, corrupt));
});

await test('outward price bounds never produce a stop trigger from downward rounding', () => {
  const input = quotes('90');
  input.primary.upperPrice = '90.000000000000000001';
  assert.equal(
    evaluateExitPlan(basePlan, createExitWatchState(basePlan), input).status,
    'watching',
  );
  const profit = quotes('109.999999999999999999');
  profit.primary.upperPrice = '110';
  assert.equal(
    evaluateExitPlan(basePlan, createExitWatchState(basePlan), profit).status,
    'watching',
  );
  const inconsistent = quotes('120');
  inconsistent.primary.upperPrice = '119';
  assert.equal(
    evaluateExitPlan(basePlan, createExitWatchState(basePlan), inconsistent)
      .status,
    'quote_invalid',
  );
});

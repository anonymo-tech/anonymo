import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGuardSimulation,
  simulateGuardAction,
  guardAtoms,
} from '../lib/second-look/guarded-wallet.ts';
import {
  appendRoomCall,
  verifyRoomChain,
  roomCallResults,
  roomMembershipQuote,
  roomExport,
  roomCallerStats,
  roomDailyCheckpoints,
  roomSoldIntoCall,
} from '../lib/second-look/rooms.ts';
const mint = 'So11111111111111111111111111111111111111112';
const buy = (input = '10000000') => ({
  type: 'buy',
  mint,
  input,
  output: '1000000000',
  quoted: '1000000000',
  minimum: '990000000',
  mintPolicyPassed: true,
  strictCosign: false,
});
const sell = (gross = '9000000') => ({
  type: 'sell',
  mint,
  input: '1000000000',
  grossOutput: gross,
  minimum: (BigInt(gross) - (BigInt(gross) * 50n + 9999n) / 10000n).toString(),
  quoted: (BigInt(gross) - (BigInt(gross) * 50n + 9999n) / 10000n).toString(),
});
test('local guard is immutable and can never claim to execute a transaction', () => {
  const s = createGuardSimulation(),
    copy = structuredClone(s),
    next = simulateGuardAction(s, buy(), 'device');
  assert.deepEqual(s, copy);
  assert.equal(next.executesTrades, false);
  assert.equal(next.environment, 'local_simulation');
  assert.equal(next.quoteBalance, '190000000');
  assert.equal(next.openCost, '10000000');
  assert.throws(() =>
    simulateGuardAction({ ...s, executesTrades: true }, buy(), 'device'),
  );
});
test('paused buys fail without debit while sells and home withdrawals remain possible', () => {
  let s = simulateGuardAction(createGuardSimulation(), buy(), 'device');
  s = simulateGuardAction(s, { type: 'pause', until: s.now + 86400 }, 'device');
  assert.throws(() => simulateGuardAction(s, buy(), 'device'), /paused/);
  s = simulateGuardAction(s, sell(), 'device');
  assert.equal(s.realizedLoss, '1045000');
  assert.equal(s.openCost, '0');
  assert.equal(
    simulateGuardAction(
      s,
      {
        type: 'withdraw',
        mint: 'USDC',
        amount: s.quoteBalance,
        destination: 'home',
      },
      'device',
    ).quoteBalance,
    '0',
  );
  assert.throws(
    () =>
      simulateGuardAction(
        s,
        { type: 'withdraw', mint: 'USDC', amount: '1', destination: 'other' },
        'device',
      ),
    /home only/,
  );
});
test('gross losses remain after profitable exits and only a profitable closed trip clears the streak', () => {
  let s = simulateGuardAction(
    simulateGuardAction(createGuardSimulation(), buy(), 'device'),
    sell(),
    'device',
  );
  assert.equal(s.losses, 1);
  s = simulateGuardAction(
    simulateGuardAction(s, buy(), 'device'),
    sell('15000000'),
    'device',
  );
  assert.equal(s.realizedLoss, '1045000');
  assert.equal(s.losses, 0);
  assert.equal(s.openCost, '0');
});
test('daily rollover clears daily totals but retains cooldown and loss streak', () => {
  let s = createGuardSimulation();
  for (let i = 0; i < 3; i++)
    s = simulateGuardAction(
      simulateGuardAction(s, buy(), 'device'),
      sell(),
      'device',
    );
  assert.throws(() => simulateGuardAction(s, buy(), 'device'), /Cooldown/);
  const next = simulateGuardAction(
    s,
    { type: 'fund', amount: '0' },
    'home',
    (s.day + 1) * 86400,
  );
  assert.equal(next.losses, 3);
  assert.equal(next.bought, '0');
  assert.equal(next.realizedLoss, '0');
  assert.equal(next.lastLoss, s.lastLoss);
});
test('limit increases wait a day and do not undo a later tightening', () => {
  let s = createGuardSimulation();
  const requested = {
    ...s.limits,
    dailyBuy: '150000000',
    perToken: '75000000',
  };
  assert.throws(
    () =>
      simulateGuardAction(s, { type: 'loosen', limits: requested }, 'device'),
    /Only home/,
  );
  s = simulateGuardAction(s, { type: 'loosen', limits: requested }, 'home');
  assert.throws(
    () => simulateGuardAction(s, { type: 'apply' }, 'device'),
    /delay/,
  );
  s = simulateGuardAction(
    s,
    { type: 'tighten', limits: { ...s.limits, dailyBuy: '50000000' } },
    'device',
  );
  s = simulateGuardAction(s, { type: 'apply' }, 'home', s.now + 86400);
  assert.equal(s.limits.dailyBuy, '50000000');
  assert.equal(s.limits.perToken, '75000000');
});
test('buy caps minimum mint policy strict mode and quote floor fail closed', () => {
  const s = createGuardSimulation();
  for (const action of [
    buy('4999999'),
    buy('51000000'),
    { ...buy(), mintPolicyPassed: false },
    { ...buy(), minimum: '989999999' },
    { ...buy(), output: '1' },
  ])
    assert.throws(() => simulateGuardAction(s, action, 'device'));
  const strict = simulateGuardAction(
    s,
    { type: 'strict', enabled: true },
    'device',
  );
  assert.throws(() => simulateGuardAction(strict, buy(), 'device'), /approval/);
  assert.doesNotThrow(() =>
    simulateGuardAction(strict, { ...buy(), strictCosign: true }, 'device'),
  );
  assert.throws(() => simulateGuardAction(s, buy(), 'keeper'));
});
test('keeper legs enforce independent size and net price floors even while paused', () => {
  let s = simulateGuardAction(createGuardSimulation(), buy(), 'device');
  s = simulateGuardAction(
    s,
    {
      type: 'plan',
      mint,
      stop: { floor: '8000000000', remaining: '1000000000' },
      target: { floor: '11000000000', remaining: '1000000000' },
    },
    'device',
  );
  s = simulateGuardAction(s, { type: 'keeper', enabled: true }, 'device');
  s = simulateGuardAction(s, { type: 'pause', until: s.now + 86400 }, 'device');
  assert.throws(
    () => simulateGuardAction(s, { ...sell(), leg: 'target' }, 'keeper'),
    /floor/,
  );
  const next = simulateGuardAction(s, { ...sell(), leg: 'stop' }, 'keeper');
  assert.equal(next.openCost, '0');
  assert.equal(next.positions[mint].stop, null);
  assert.throws(() =>
    simulateGuardAction(next, { ...sell(), leg: 'stop' }, 'keeper'),
  );
});
test('pro rata cost removal conserves every micro unit through partial exits', () => {
  for (let n = 1; n <= 100; n++) {
    let s = simulateGuardAction(
      createGuardSimulation(),
      {
        ...buy(),
        output: String(100 + n),
        quoted: String(100 + n),
        minimum: String(100 + n),
      },
      'device',
    );
    while (s.positions[mint].quantity !== '0') {
      s = simulateGuardAction(
        s,
        {
          type: 'withdraw',
          mint,
          amount: '1',
          destination: 'home',
        },
        'device',
      );
    }
    assert.equal(s.openCost, '0');
    assert.equal(s.positions[mint].cost, '0');
    assert.equal(s.realizedLoss, '10000000');
  }
});
test('exact integer amounts and clocks reject overflow negative values and backward time', () => {
  for (const value of ['-1', '1.1', '1e6', '18446744073709551616', '01'])
    assert.throws(() => guardAtoms(value));
  assert.equal(guardAtoms('18446744073709551615'), (1n << 64n) - 1n);
  assert.throws(() =>
    simulateGuardAction(
      createGuardSimulation(),
      { type: 'fund', amount: '0' },
      'home',
      1,
    ),
  );
});
const input = {
  roomId: 'fixture-room',
  mint,
  caller: mint,
  note: 'Watching liquidity',
  at: '2026-10-14T12:00:00.000Z',
  slot: null,
  priceUsd6: '1000000',
  heldAtoms: null,
  bought60mAtoms: null,
};
test('local call records hash every captured field and reject edits order changes and cross-room appends', async () => {
  let calls = await appendRoomCall([], input);
  calls = await appendRoomCall(calls, {
    ...input,
    at: '2026-10-14T13:00:00.000Z',
  });
  assert.equal(await verifyRoomChain(calls), true);
  assert.equal(
    await verifyRoomChain([{ ...calls[0], note: 'Edited' }, calls[1]]),
    false,
  );
  assert.equal(await verifyRoomChain([...calls].reverse()), false);
  await assert.rejects(
    appendRoomCall(calls, { ...input, roomId: 'other-room' }),
  );
  const exported = await roomExport(calls);
  assert.equal(exported.anchored, false);
  assert.equal(exported.environment, 'local_simulation');
  assert.equal(exported.root, calls[1].hash);
});
test('room outcomes do not use future quotes or turn missing prices into zero returns', async () => {
  const [call] = await appendRoomCall([], input);
  const points = [
    { at: '2026-10-14T13:00:01.000Z', priceUsd6: '2000000', source: 'fixture' },
  ];
  assert.equal(
    roomCallResults(call, points, '2026-10-14T14:00:00.000Z').oneHourBps,
    null,
  );
  points.push({
    at: '2026-10-14T12:59:00.000Z',
    priceUsd6: '1100000',
    source: 'fixture',
  });
  const r = roomCallResults(call, points, '2026-10-14T14:00:00.000Z');
  assert.equal(r.oneHourBps, '1000');
  assert.equal(r.oneDayBps, null);
  assert.equal(r.completePricePath, false);
  assert.equal(r.soldIntoCallBps, null);
  assert.throws(() =>
    roomCallResults(
      call,
      [...points, { ...points[0], priceUsd6: '1' }],
      '2026-10-14T14:00:00.000Z',
    ),
  );
});
test('room pricing is a no-charge quote and secret notes never enter the local ledger', async () => {
  assert.deepEqual(roomMembershipQuote(10), {
    members: 10,
    monthlyUsd6: '0',
    chargesMoney: false,
  });
  assert.equal(roomMembershipQuote(11).monthlyUsd6, '2000000');
  await assert.rejects(
    appendRoomCall([], {
      ...input,
      note: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    }),
    /secret/,
  );
});

test('outside tokens have no cost and cannot reset a tracked loss streak', () => {
  let s = simulateGuardAction(
    simulateGuardAction(createGuardSimulation(), buy(), 'device'),
    sell(),
    'device',
  );
  s = simulateGuardAction(
    s,
    { type: 'receive', mint, amount: '1000000000' },
    'home',
  );
  const next = simulateGuardAction(s, sell('20000000'), 'device');
  assert.equal(next.losses, 1);
  assert.equal(next.realizedLoss, s.realizedLoss);
  assert.equal(next.openCost, '0');
  assert.equal(next.positions[mint].balance, '0');
});
test('dust closes tracked cost without burning the leftover token balance', () => {
  let s = simulateGuardAction(createGuardSimulation(), buy(), 'device');
  const next = simulateGuardAction(
    s,
    { ...sell(), input: '999999999' },
    'device',
  );
  assert.equal(next.positions[mint].quantity, '0');
  assert.equal(next.positions[mint].balance, '1');
  assert.equal(next.openCost, '0');
  assert.equal(next.realizedLoss, '1045000');
  assert.equal(next.losses, 1);
  assert.equal(
    simulateGuardAction(next, { type: 'close', mint }, 'observer').positions[
      mint
    ],
    undefined,
  );
  assert.throws(() =>
    simulateGuardAction(s, { type: 'close', mint }, 'observer'),
  );
});
test('home can exit with services absent and optional fixture valuation avoids inventing a loss', () => {
  let s = simulateGuardAction(createGuardSimulation(), buy(), 'device');
  s = simulateGuardAction(s, { type: 'strict', enabled: true }, 'device');
  s = simulateGuardAction(s, { type: 'pause', until: s.now + 86400 }, 'device');
  const withoutQuote = simulateGuardAction(
    s,
    {
      type: 'withdraw',
      mint,
      amount: s.positions[mint].quantity,
      destination: 'other',
    },
    'home',
  );
  assert.equal(withoutQuote.realizedLoss, '10000000');
  assert.equal(withoutQuote.openCost, '0');
  const quoted = simulateGuardAction(
    s,
    {
      type: 'withdraw',
      mint,
      amount: s.positions[mint].quantity,
      destination: 'other',
      attestedValue: '12000000',
    },
    'home',
  );
  assert.equal(quoted.realizedLoss, '0');
  assert.equal(quoted.openCost, '0');
});
test('strict-off and timezone changes wait 24 hours and pause cancels those fields', () => {
  let s = simulateGuardAction(
    createGuardSimulation(),
    { type: 'strict', enabled: true },
    'device',
  );
  s = simulateGuardAction(
    s,
    { type: 'loosen', limits: s.limits, strictOff: true, offsetMinutes: 120 },
    'home',
  );
  const done = simulateGuardAction(
    s,
    { type: 'apply' },
    'observer',
    s.now + 86400,
  );
  assert.equal(done.strict, false);
  assert.equal(done.offsetMinutes, 120);
  const paused = simulateGuardAction(
    s,
    { type: 'pause', until: s.now + 3600 },
    'device',
  );
  const canceled = simulateGuardAction(
    paused,
    { type: 'apply' },
    'observer',
    s.now + 86400,
  );
  assert.equal(canceled.strict, true);
  assert.equal(canceled.offsetMinutes, 0);
  assert.throws(() =>
    simulateGuardAction(s, { type: 'apply' }, 'observer', s.now + 86399),
  );
});
test('keeper can raise floors but never lower them, fund, buy or withdraw', () => {
  let s = simulateGuardAction(createGuardSimulation(), buy(), 'device');
  s = simulateGuardAction(
    s,
    {
      type: 'plan',
      mint,
      stop: { floor: '8000000000', remaining: '1000000000' },
      target: null,
    },
    'device',
  );
  s = simulateGuardAction(s, { type: 'keeper', enabled: true }, 'device');
  const raised = simulateGuardAction(
    s,
    { type: 'raise_floor', mint, leg: 'stop', floor: '8100000000' },
    'keeper',
  );
  assert.equal(raised.positions[mint].stop.floor, '8100000000');
  assert.throws(() =>
    simulateGuardAction(
      raised,
      { type: 'raise_floor', mint, leg: 'stop', floor: '8000000000' },
      'keeper',
    ),
  );
  assert.throws(() =>
    simulateGuardAction(s, { type: 'fund', amount: '1' }, 'keeper'),
  );
  assert.throws(() =>
    simulateGuardAction(
      s,
      { type: 'withdraw', mint: 'USDC', amount: '1', destination: 'home' },
      'keeper',
    ),
  );
});
test('trade fee bookkeeping is exact and corrupted local state is rejected', () => {
  const s = simulateGuardAction(createGuardSimulation(), buy(), 'device');
  assert.equal(s.feesPaid, '50000');
  assert.equal(simulateGuardAction(s, sell(), 'device').feesPaid, '95000');
  assert.throws(() =>
    simulateGuardAction(
      { ...s, positions: { [mint]: { ...s.positions[mint], balance: '1' } } },
      { type: 'fund', amount: '0' },
      'home',
    ),
  );
  assert.throws(() =>
    simulateGuardAction(
      { ...s, feesPaid: 'NaN' },
      { type: 'fund', amount: '0' },
      'home',
    ),
  );
});
test('daily room checkpoints link adjacent days and are never called published anchors', async () => {
  let calls = await appendRoomCall([], input);
  calls = await appendRoomCall(calls, {
    ...input,
    at: '2026-10-15T12:00:00.000Z',
  });
  const roots = await roomDailyCheckpoints(calls);
  assert.equal(roots.length, 2);
  assert.equal(roots[0].root, roots[1].previousHash);
  assert.equal(roots[1].root, calls[1].hash);
  assert.equal(roots[1].anchored, false);
  await assert.rejects(
    roomDailyCheckpoints([{ ...calls[0], note: 'rewritten' }]),
  );
});
test('caller statistics use priced outcomes and disclose sparse or missing sale coverage', async () => {
  let calls = [];
  const observations = {};
  for (let i = 0; i < 10; i++) {
    calls = await appendRoomCall(calls, {
      ...input,
      at: new Date(Date.parse(input.at) + i * 86400000).toISOString(),
    });
    const c = calls.at(-1);
    observations[c.hash] = [
      {
        at: new Date(Date.parse(c.at) + 86400000).toISOString(),
        priceUsd6: i < 5 ? '800000' : '1200000',
        source: 'fixture',
      },
    ];
  }
  const stats = await roomCallerStats(
    calls,
    mint,
    observations,
    '2026-11-01T00:00:00.000Z',
  );
  assert.equal(stats.priced24h, 10);
  assert.equal(stats.median24hBps, '0');
  assert.equal(stats.hitRateBps, '5000');
  assert.equal(stats.soldIntoCallRateBps, null);
  assert.equal(stats.saleCoverage, 0);
  delete observations[calls[0].hash];
  const sparse = await roomCallerStats(
    calls,
    mint,
    observations,
    '2026-11-01T00:00:00.000Z',
  );
  assert.equal(sparse.calls, 10);
  assert.equal(sparse.priced24h, 9);
  assert.equal(sparse.sampleTooSmall, true);
  assert.equal(sparse.median24hBps, null);
});
test('sold-into-call fixtures require complete first-hour coverage and captured holdings', async () => {
  const [call] = await appendRoomCall([], { ...input, heldAtoms: '1000' });
  const evidence = {
    environment: 'local_simulation',
    completeFirstHour: true,
    sales: [
      { at: '2026-10-14T12:30:00.000Z', amount: '250', source: 'fixture' },
    ],
  };
  assert.equal(
    roomSoldIntoCall(call, evidence, '2026-10-14T13:00:00.000Z'),
    '2500',
  );
  assert.equal(
    roomSoldIntoCall(
      call,
      { ...evidence, completeFirstHour: false },
      '2026-10-14T13:00:00.000Z',
    ),
    null,
  );
  assert.equal(
    roomSoldIntoCall(call, evidence, '2026-10-14T12:59:59.000Z'),
    null,
  );
  assert.equal(
    roomSoldIntoCall(
      { ...call, heldAtoms: null },
      evidence,
      '2026-10-14T13:00:00.000Z',
    ),
    null,
  );
});

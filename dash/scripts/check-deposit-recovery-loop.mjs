import assert from 'node:assert/strict';
import test from 'node:test';
import { startDepositRecoveryPolling } from '../lib/client/deposit-recovery-loop.ts';
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function clock() {
  let at = 0;
  let timer;
  return {
    now: () => at,
    schedule(run, delay) {
      const item = { run, at: at + delay };
      timer = item;
      return () => {
        if (timer === item) timer = undefined;
      };
    },
    async next() {
      const item = timer;
      timer = undefined;
      if (!item) return false;
      at = item.at;
      item.run();
      await flush();
      return true;
    },
    advance(ms) {
      at += ms;
    },
    get pending() {
      return !!timer;
    },
  };
}
void test('never starts immediately and checks at15-second intervals, at most8 times', async () => {
  const c = clock(),
    abort = new AbortController();
  let checks = 0,
    expired = 0;
  startDepositRecoveryPolling({
    ...c,
    signal: abort.signal,
    check: async () => {
      checks++;
      return 'retry';
    },
    onExhausted: () => expired++,
  });
  assert.equal(checks, 0);
  while (await c.next()) {}
  assert.equal(checks, 8);
  assert.equal(c.now(), 120000);
  assert.equal(expired, 1);
});
void test('confirmed credit stops without any additional recovery or expiry message', async () => {
  const c = clock(),
    abort = new AbortController();
  let checks = 0,
    expired = 0;
  startDepositRecoveryPolling({
    ...c,
    signal: abort.signal,
    check: async () => {
      checks++;
      return 'credited';
    },
    onExhausted: () => expired++,
  });
  await c.next();
  assert.equal(checks, 1);
  assert.equal(c.pending, false);
  assert.equal(expired, 0);
});
void test('unmount/account abort cancels the scheduled check', async () => {
  const c = clock(),
    abort = new AbortController();
  let checks = 0;
  startDepositRecoveryPolling({
    ...c,
    signal: abort.signal,
    check: async () => {
      checks++;
      return 'retry';
    },
    onExhausted: () => assert.fail(),
  });
  abort.abort();
  assert.equal(await c.next(), false);
  assert.equal(checks, 0);
});
void test('an in-flight check never overlaps and abort cannot reschedule its late result', async () => {
  const c = clock(),
    abort = new AbortController();
  let resolve;
  let checks = 0;
  startDepositRecoveryPolling({
    ...c,
    signal: abort.signal,
    check: () => {
      checks++;
      return new Promise((r) => (resolve = r));
    },
    onExhausted: () => assert.fail(),
  });
  await c.next();
  assert.equal(c.pending, false);
  c.advance(45000);
  assert.equal(await c.next(), false);
  assert.equal(checks, 1);
  abort.abort();
  resolve('retry');
  await flush();
  assert.equal(c.pending, false);
});
void test('terminal ownership/capability state or thrown failure stops polling', async () => {
  for (const fail of [false, true]) {
    const c = clock();
    let checks = 0;
    startDepositRecoveryPolling({
      ...c,
      signal: new AbortController().signal,
      check: async () => {
        checks++;
        if (fail) throw new Error('unavailable');
        return 'stop';
      },
      onExhausted: () => assert.fail(),
    });
    await c.next();
    assert.equal(checks, 1);
    assert.equal(c.pending, false);
  }
});
void test('a late pending-finality response exhausts the deadline without another request', async () => {
  const c = clock();
  let resolve;
  let expired = 0;
  startDepositRecoveryPolling({
    ...c,
    signal: new AbortController().signal,
    check: () => new Promise((r) => (resolve = r)),
    onExhausted: () => expired++,
  });
  await c.next();
  c.advance(120000);
  resolve('retry');
  await flush();
  assert.equal(c.pending, false);
  assert.equal(expired, 1);
});

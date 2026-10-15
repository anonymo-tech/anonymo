import assert from 'node:assert/strict';
import test from 'node:test';
import {
  tallyBlindPicks,
  isSmallBlindSample,
  countBlindRecord,
  BLIND_RECORD_LIMITS,
} from '../lib/blind-record.ts';

function comparison(id, winner = 'a', blind = true) {
  return {
    id, blind, votedCallId: winner,
    calls: [
      { id: 'a', family: 'claude' },
      { id: 'b', family: 'gpt' },
      { id: 'c', family: 'claude' },
    ],
  };
}
const page = (items, nextCursor = null) => ({ items, nextCursor });
const signal = () => new AbortController().signal;

test('votes counted once; unvoted and non-blind comparisons ignored', () => {
  const vote = comparison('one');
  assert.deepEqual(tallyBlindPicks([
    vote, vote, comparison('unvoted', null), comparison('visible', 'b', false),
  ]), {
    votes: 1, unattributed: 0,
    rows: [
      { family: 'claude', picked: 1, appeared: 1, pickRate: 1 },
      { family: 'gpt', picked: 0, appeared: 1, pickRate: 0 },
    ],
  });
});

test('aggregates per family once per voted comparison and sorts by picks', () => {
  assert.deepEqual(tallyBlindPicks([
    comparison('one', 'b'), comparison('two', 'c'), comparison('three', 'b'),
  ]).rows, [
    { family: 'gpt', picked: 2, appeared: 3, pickRate: 2 / 3 },
    { family: 'claude', picked: 1, appeared: 3, pickRate: 1 / 3 },
  ]);
});

test('missing model metadata never invents a family or drops the vote total', () => {
  const item = comparison('one');
  item.calls[0].family = null;
  const result = tallyBlindPicks([item]);
  assert.equal(result.votes, 1);
  assert.equal(result.unattributed, 1);
  assert.equal(result.rows.reduce((n, row) => n + row.picked, 0), 0);
});

test('small-sample message applies only below ten votes', () => {
  for (const n of [0, 1, 9]) assert.equal(isSmallBlindSample(n), true);
  for (const n of [10, 11, 500]) assert.equal(isSmallBlindSample(n), false);
});

test('paginates projects and comparisons, reports progress, deduplicates history', async () => {
  const requests = [];
  const progress = [];
  const client = {
    async projects(cursor) {
      requests.push(['projects', cursor]);
      return cursor ? page([{ id: 'p1' }, { id: 'p2' }]) : page([{ id: 'p1' }], 'next-project');
    },
    async comparisons(id, cursor) {
      requests.push([id, cursor]);
      if (id === 'p2') return page([comparison('three', 'b', false)]);
      return cursor ? page([comparison('one'), comparison('two', 'b')]) : page([comparison('one')], 'next-comparison');
    },
  };
  const result = await countBlindRecord(client, signal(), item => progress.push(item));
  assert.deepEqual(requests, [
    ['projects', null], ['p1', null], ['p1', 'next-comparison'],
    ['projects', 'next-project'], ['p2', null],
  ]);
  assert.equal(result.votes, 2);
  assert.equal(result.scanned, 4);
  assert.equal(result.pageCapReached, false);
  assert.equal(result.comparisonCapReached, false);
  assert.deepEqual(progress.at(-1), { projects: 2, comparisons: 4, votes: 2 });
});

test('caps each project at twenty pages and continues to the next project', async () => {
  const calls = { p1: 0, p2: 0 };
  const result = await countBlindRecord({
    async projects() { return page([{ id: 'p1' }, { id: 'p2' }]); },
    async comparisons(id) {
      calls[id]++;
      return page([comparison(`${id}-${calls[id]}`)], id === 'p1' ? String(calls[id]) : null);
    },
  }, signal(), () => {});
  assert.deepEqual(calls, { p1: BLIND_RECORD_LIMITS.pagesPerProject, p2: 1 });
  assert.equal(result.pageCapReached, true);
  assert.equal(result.votes, 21);
});

test('exactly twenty completed pages does not claim missing history', async () => {
  let n = 0;
  const result = await countBlindRecord({
    async projects() { return page([{ id: 'p1' }]); },
    async comparisons() { n++; return page([], n < 20 ? String(n) : null); },
  }, signal(), () => {});
  assert.equal(n, 20);
  assert.equal(result.pageCapReached, false);
});

test('caps total comparisons at 500 including unvoted and stops further requests', async () => {
  let requests = 0;
  const result = await countBlindRecord({
    async projects() { return page([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], 'unused'); },
    async comparisons(id) {
      requests++;
      return page(Array.from({ length: 20 }, (_, i) => comparison(`${id}-${requests}-${i}`, null)), String(requests));
    },
  }, signal(), () => {});
  assert.equal(requests, 25);
  assert.equal(result.scanned, 500);
  assert.equal(result.votes, 0);
  assert.equal(result.comparisonCapReached, true);
  assert.equal(result.pageCapReached, true);
});

test('aborting an in-flight page prevents progress, results, and further requests', async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(countBlindRecord({
    async projects() { return page([{ id: 'p1' }]); },
    async comparisons() {
      requests++;
      controller.abort();
      return page([comparison('one')], 'next');
    },
  }, controller.signal, () => assert.fail('Aborted page cannot update progress')), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('already-cancelled scan makes no requests; request failures do not return a tally', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(countBlindRecord({
    async projects() { assert.fail('No requests after cancel'); },
    async comparisons() { assert.fail('No requests after cancel'); },
  }, controller.signal, () => {}), { name: 'AbortError' });
  await assert.rejects(countBlindRecord({
    async projects() { return page([{ id: 'p1' }]); },
    async comparisons() { throw new Error('Unavailable'); },
  }, signal(), () => {}), /Unavailable/);
});

test('repeated cursors fail instead of repeatedly fetching the same history', async () => {
  await assert.rejects(countBlindRecord({
    async projects() { return page([{ id: 'p1' }]); },
    async comparisons() { return page([], 'same'); },
  }, signal(), () => {}), /Repeated comparison cursor/);
});

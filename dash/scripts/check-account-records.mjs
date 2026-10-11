import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createAccountRecordsClient,
  formatAccountUsd6,
} from '../lib/client/account-records.ts';

void test('account record requests bind the expected account and never follow redirects or persist responses', async () => {
  const account = randomUUID(),
    id = randomUUID();
  let request;
  const client = createAccountRecordsClient(
    account,
    new AbortController().signal,
    async (path, options) => {
      request = { path, options };
      return Response.json({
        entries: [
          {
            id,
            kind: 'hold',
            createdAt: '2026-10-10T01:00:00Z',
            availableDeltaUsd6: '-123',
            reservedDeltaUsd6: '123',
          },
        ],
        nextCursor: null,
      });
    },
  );
  assert.equal((await client.ledger()).entries[0].availableDeltaUsd6, '-123');
  assert.equal(request.path, '/api/ledger');
  assert.equal(request.options.headers['X-Conclave-Account-Id'], account);
  assert.equal(request.options.mode, 'same-origin');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.cache, 'no-store');
});

void test('account money stays exact at micro-dollar and large integer boundaries', () => {
  assert.equal(formatAccountUsd6('0'), '0.00');
  assert.equal(formatAccountUsd6('1'), '0.000001');
  assert.equal(formatAccountUsd6('-1000010'), '−1.00001');
  assert.equal(formatAccountUsd6('9000000000000000'), '9000000000.00');
  for (const value of ['1e6', '1.1', 'NaN', ' 1', '+1', '01'])
    assert.throws(() => formatAccountUsd6(value));
});

void test('malformed amounts, states, cursors, and foreign receipt payloads fail closed', async () => {
  const account = randomUUID(),
    id = randomUUID(),
    controller = new AbortController();
  const client = (body) =>
    createAccountRecordsClient(account, controller.signal, async () =>
      Response.json(body),
    );
  await assert.rejects(
    client({
      entries: [
        {
          id,
          kind: 'deposit',
          createdAt: new Date().toISOString(),
          availableDeltaUsd6: 9007199254740992,
          reservedDeltaUsd6: '0',
        },
      ],
      nextCursor: null,
    }).ledger(),
  );
  await assert.rejects(
    client({
      receipts: [
        {
          id,
          callId: randomUUID(),
          issuedAt: new Date().toISOString(),
          actualUsd6: '1',
          state: 'anchored_finalized',
        },
      ],
      nextCursor: null,
    }).receipts(),
  );
  await assert.rejects(
    client({ entries: [], nextCursor: 'https://other.test' }).ledger(),
  );
  await assert.rejects(
    client({
      receipt: { payload: { receiptId: randomUUID() }, signature: 'synthetic' },
    }).receipt(id),
  );
});

void test('unknown upstream errors and oversized bodies never expose server details', async () => {
  const account = randomUUID(),
    controller = new AbortController();
  const failed = createAccountRecordsClient(
    account,
    controller.signal,
    async () => new Response('private diagnostic details', { status: 500 }),
  );
  await assert.rejects(
    failed.ledger(),
    (error) => !error.message.includes('private diagnostic'),
  );
  const oversized = createAccountRecordsClient(
    account,
    controller.signal,
    async () =>
      Response.json({
        entries: [],
        nextCursor: null,
        padding: 'x'.repeat(262144),
      }),
  );
  await assert.rejects(oversized.ledger(), /download limit/);
});

void test('mixed chat and media receipt summaries preserve source and exact zero costs', async () => {
  const common = {
    id: randomUUID(),
    issuedAt: new Date().toISOString(),
    actualUsd6: '0',
    state: 'signed_pending_batch',
  };
  const callId = randomUUID(),
    mediaJobId = randomUUID();
  const client = (rows) =>
    createAccountRecordsClient(
      randomUUID(),
      new AbortController().signal,
      async () => Response.json({ receipts: rows, nextCursor: null }),
    );
  const rows = (
    await client([
      { ...common, callId },
      { ...common, id: randomUUID(), callId: null, kind: 'media', mediaJobId },
    ]).receipts()
  ).receipts;
  assert.equal(rows[0].kind, 'call');
  assert.equal(rows[0].callId, callId);
  assert.equal(rows[1].kind, 'media');
  assert.equal(rows[1].callId, null);
  assert.equal(rows[1].mediaJobId, mediaJobId);
  assert.equal(rows[1].actualUsd6, '0');
  for (const source of [
    { kind: 'media', callId, mediaJobId },
    { kind: 'media', callId: null },
    { callId, mediaJobId },
    { kind: 'other', callId },
    { kind: 'call', callId: null },
  ])
    await assert.rejects(client([{ ...common, ...source }]).receipts());
});

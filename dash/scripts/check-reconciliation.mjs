import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { creditVerifiedDeposit, getBalance } from '../server/ledger/ledger.ts';
import { splitPlatformFee } from '../server/ledger/platform-fee.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { drainBoundMs, runNextCall } from '../server/routes/call-worker.ts';
import { createPpqClient } from '../server/ppq/index.ts';
import { reconcileFromCli } from './reconcile-holds.mjs';
import {
  recordedStream,
  recordedStreams,
  recordedText,
  reviewedPricing,
} from './fixtures/ppq-recorded.mjs';

const connection = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href;
Object.assign(process.env, {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.test',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_DATA_KEYS: JSON.stringify({
    test: randomBytes(32).toString('base64'),
  }),
  CONCLAVE_ACTIVE_DATA_KEY: 'test',
  PPQ_API_KEY: 'synthetic-provider-fixture',
  CONCLAVE_INFERENCE_ENABLED: 'true',
});
// Every test starts fee-free and opts in explicitly.
delete process.env.CONCLAVE_PLATFORM_FEE_BPS;
delete process.env.CONCLAVE_BURN_SHARE_BPS;
const pool = createDatabase(connection, 12);
before(() => migrate(pool));
after(() => pool.end());

const keys = () => configuredKeyring();
const fast = { cancelPollMs: 20, drainTimeoutMs: 3000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const operatorEnv = {
  CONCLAVE_INTERNAL_TESTING: 'true',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_APP_ORIGIN: 'http://localhost',
};

async function waitFor(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function withFee(platformFeeBps, burnShareBps, work) {
  process.env.CONCLAVE_PLATFORM_FEE_BPS = String(platformFeeBps);
  process.env.CONCLAVE_BURN_SHARE_BPS = String(burnShareBps);
  try {
    return await work();
  } finally {
    delete process.env.CONCLAVE_PLATFORM_FEE_BPS;
    delete process.env.CONCLAVE_BURN_SHARE_BPS;
  }
}

async function owner(balance = '10000000') {
  const id = randomUUID(),
    token = generateSessionToken(),
    projectId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), id],
  );
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Settlement fixture')",
    [projectId, id],
  );
  await creditVerifiedDeposit(pool, {
    accountId: id,
    reference: `fixture_${randomUUID()}`,
    amountUsd6: balance,
  });
  return { id, projectId, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

async function api(user, path, body) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: 'https://conclave.test',
        cookie: user.cookie,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: response.headers.get('content-type')?.includes('json')
      ? JSON.parse(text)
      : null,
  };
}

async function route(family, modelId, pricing, markupBps = 0) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,$3,$4,'chat',true,$5,$6,now()+interval '1 hour')`,
    [
      id,
      randomUUID(),
      modelId,
      family,
      {
        level: 'unverified',
        reviewed: true,
        retentionDisclosure: 'Synthetic reviewed route terms.',
        evidenceUrl: 'https://example.test/terms',
        evidenceDate: new Date().toISOString().slice(0, 10),
      },
      {
        ...pricing,
        markupBps,
        maxInputBytes: 32768,
        maxOutputTokens: 8192,
      },
    ],
  );
  return id;
}

/** Quotes, approves and queues one chat call; returns its ids and quote. */
async function queued(user, routeVersionId, maxOutputTokens = 2048) {
  const item = {
    projectId: user.projectId,
    routeVersionId,
    messages: [{ role: 'user', content: 'A recorded fixture' }],
    maxOutputTokens,
    privacy: 'standard',
  };
  const quote = await api(user, 'quotes', item);
  assert.equal(quote.status, 201, quote.text);
  const call = await api(user, 'calls', {
    ...item,
    quoteId: quote.body.quote.id,
    idempotencyKey: randomUUID(),
  });
  assert.equal(call.status, 202, call.text);
  const holdId = (
    await pool.query('SELECT hold_id FROM calls WHERE id=$1', [
      call.body.call.id,
    ])
  ).rows[0].hold_id;
  return { callId: call.body.call.id, holdId, quote: quote.body.quote };
}

async function state(callId) {
  return (
    await pool.query(
      `SELECT c.state,c.error_code,h.state AS hold_state,h.captured_usd6::text AS captured,h.maximum_usd6::text AS maximum,
      h.provider_reference,h.cancel_requested_at IS NOT NULL AS cancel_requested
      FROM calls c JOIN holds h ON h.id=c.hold_id WHERE c.id=$1`,
      [callId],
    )
  ).rows[0];
}

async function reconciliation(holdId) {
  return (
    (
      await pool.query(
        `SELECT reason_code,observed_usd6::text AS observed,input_tokens,output_tokens,total_tokens,stopped,
        overage_usd6::text AS overage,resolution,resolved_usd6::text AS resolved
        FROM hold_reconciliations WHERE hold_id=$1`,
        [holdId],
      )
    ).rows[0] ?? null
  );
}

async function feeRow(holdId) {
  return (
    (
      await pool.query(
        `SELECT base_usd6::text AS base,platform_fee_usd6::text AS fee,burn_reserve_usd6::text AS burn
        FROM hold_platform_fees WHERE hold_id=$1`,
        [holdId],
      )
    ).rows[0] ?? null
  );
}

async function ledgerHealthy() {
  const result = (
    await pool.query(`SELECT
      (SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_usd6)<>0) t)::int AS imbalanced,
      (SELECT count(*) FROM ledger_accounts a WHERE a.balance_usd6<>COALESCE((SELECT sum(e.amount_usd6) FROM ledger_entries e WHERE e.ledger_account_id=a.id),0))::int AS drift,
      (SELECT count(*) FROM holds WHERE captured_usd6>maximum_usd6)::int AS overcaptured`)
  ).rows[0];
  assert.deepEqual(result, { imbalanced: 0, drift: 0, overcaptured: 0 });
}

/** A provider stub the test writes to frame by frame. */
function controlledProvider(timeouts) {
  const encoder = new TextEncoder();
  let stream;
  let requests = 0;
  const provider = createPpqClient({
    apiKey: 'test-key-not-a-credential',
    ...(timeouts ? { timeouts } : {}),
    fetch: async (_url, init) => {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            init.signal.addEventListener('abort', () => {
              try {
                controller.error(new Error('aborted'));
              } catch {}
            });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return {
    provider,
    requests: () => requests,
    ready: () => Boolean(stream),
    push: (text) => stream.enqueue(encoder.encode(text)),
    close: () => stream.close(),
    drop: () => stream.error(new Error('connection reset')),
  };
}

const chunk = (id, content) =>
  `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1700000000, model: 'meta-llama/llama-4-scout', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const finish = (id, usage) =>
  `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1700000000, model: 'meta-llama/llama-4-scout', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: {"id":"${id}","object":"chat.completion.chunk","created":1700000000,"choices":[],"usage":${usage}}\n\n`;
const before300 = 'Before the stop. '.repeat(20);

/** The test pool, with lease renewals counted and the next N made to fail. */
function flakyHeartbeats() {
  let failing = 0,
    renewals = 0,
    failures = 0;
  const proxy = new Proxy(pool, {
    get(target, key) {
      if (key === 'query')
        return (text, ...rest) => {
          if (
            typeof text === 'string' &&
            text.startsWith('UPDATE jobs SET lease_expires_at')
          ) {
            if (failing > 0) {
              failing--;
              failures++;
              return Promise.reject(new Error('transient database error'));
            }
            renewals++;
          }
          return target.query(text, ...rest);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    pool: proxy,
    failNext: (count) => {
      failing = count;
    },
    stats: () => ({ renewals, failures }),
  };
}

async function leaseExpiry(callId) {
  return (
    await pool.query('SELECT lease_expires_at FROM jobs WHERE reference=$1', [
      `inference:${callId}`,
    ])
  ).rows[0].lease_expires_at;
}

void test('every recorded model settles exactly through the worker, with the platform fee and burn split', async () => {
  for (const entry of recordedStreams) {
    await withFee(500, 5000, async () => {
      const user = await owner();
      const routeVersionId = await route(
        entry.family,
        entry.modelId,
        reviewedPricing[entry.family],
      );
      const call = await queued(user, routeVersionId);
      let requests = 0;
      const provider = createPpqClient({
        apiKey: 'test-key-not-a-credential',
        fetch: async () => {
          requests++;
          return new Response(recordedStream(entry), {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      assert.equal(await runNextCall(pool, provider, keys(), fast), true);
      assert.equal(requests, 1);
      const base = BigInt(entry.expected.costUsd6);
      const split = splitPlatformFee(base, 500, 5000);
      const result = await state(call.callId);
      assert.deepEqual(
        result,
        {
          state: 'succeeded',
          error_code: null,
          hold_state: 'captured',
          captured: split.totalUsd6.toString(),
          maximum: call.quote.maximumUsd6,
          provider_reference: entry.providerId,
          cancel_requested: false,
        },
        entry.family,
      );
      assert.deepEqual(await feeRow(call.holdId), {
        base: base.toString(),
        fee: split.platformFeeUsd6.toString(),
        burn: split.burnReserveUsd6.toString(),
      });
      assert.equal(await reconciliation(call.holdId), null);
      assert.deepEqual(await getBalance(pool, user.id), {
        availableUsd6: (10_000_000n - split.totalUsd6).toString(),
        reservedUsd6: '0',
        currency: 'USD6',
      });
      const read = await api(user, `calls/${call.callId}`);
      assert.equal(read.body.call.output, recordedText);
      assert.equal(
        read.body.call.billing.actualUsd6,
        split.totalUsd6.toString(),
      );
      assert.equal(read.body.call.cancelRequested, false);
    });
  }
  await ledgerHealthy();
});

void test('route markup applies to the canonical cost before the platform fee', async () => {
  const entry = recordedStreams.find((item) => item.family === 'gemini');
  const user = await owner();
  const routeVersionId = await route(
    entry.family,
    entry.modelId,
    reviewedPricing.gemini,
    250,
  );
  const call = await queued(user, routeVersionId);
  await runNextCall(
    pool,
    createPpqClient({
      apiKey: 'test-key-not-a-credential',
      fetch: async () =>
        new Response(recordedStream(entry), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    }),
    keys(),
    fast,
  );
  // ceil(2673 × 1.025) = 2740.
  assert.equal((await state(call.callId)).captured, '2740');
});

void test('a cancel mid-stream freezes output, drains the stream and settles the exact full cost', async () => {
  await withFee(500, 5000, async () => {
    const user = await owner();
    const routeVersionId = await route(
      'llama',
      'meta-llama/llama-4-scout',
      reviewedPricing.llama,
    );
    const call = await queued(user, routeVersionId);
    const stub = controlledProvider();
    const run = runNextCall(pool, stub.provider, keys(), fast);
    await waitFor(stub.ready, 'dispatch');
    stub.push(chunk('gen-fixture-cancel', before300));
    await waitFor(
      async () => (await state(call.callId)).provider_reference,
      'provider reference',
    );
    await waitFor(
      async () =>
        (
          await pool.query('SELECT output_ciphertext FROM calls WHERE id=$1', [
            call.callId,
          ])
        ).rows[0].output_ciphertext,
      'persisted output',
    );
    const cancelled = await api(user, `calls/${call.callId}/cancel`, {});
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.body.cancellationRequested, true);
    // The snapshot shows the stop before the worker writes again.
    const live = await api(user, `calls/${call.callId}`);
    assert.equal(live.body.call.state, 'running');
    assert.equal(live.body.call.cancelRequested, true);
    await sleep(200);
    // Everything generated after the stop is drained, never delivered.
    stub.push(chunk('gen-fixture-cancel', 'AFTER THE STOP '.repeat(40)));
    stub.push(
      finish(
        'gen-fixture-cancel',
        '{"prompt_tokens":19,"completion_tokens":900,"total_tokens":919,"cost":0.0002869,"is_byok":false,"cost_details":{"upstream_inference_cost":0.0002869}}',
      ),
    );
    stub.push('data: [DONE]\n\n');
    stub.close();
    assert.equal(await run, true);
    assert.equal(stub.requests(), 1);
    // 19 × 0.1055 + 900 × 0.3165 = 286.8545 → 287 < provider 286.9 → 287.
    const split = splitPlatformFee(287n, 500, 5000);
    assert.deepEqual(await state(call.callId), {
      state: 'cancelled',
      error_code: null,
      hold_state: 'captured',
      captured: split.totalUsd6.toString(),
      maximum: call.quote.maximumUsd6,
      provider_reference: 'gen-fixture-cancel',
      cancel_requested: true,
    });
    assert.deepEqual(await feeRow(call.holdId), {
      base: '287',
      fee: split.platformFeeUsd6.toString(),
      burn: split.burnReserveUsd6.toString(),
    });
    const read = await api(user, `calls/${call.callId}`);
    assert.equal(read.body.call.output, before300);
    assert.ok(!read.body.call.output.includes('AFTER'));
    const events = await api(user, `calls/${call.callId}/events`);
    assert.ok(events.text.includes('"cancelRequested":true'));
    assert.ok(events.text.includes('"state":"cancelled"'));
    assert.deepEqual(await getBalance(pool, user.id), {
      availableUsd6: (10_000_000n - split.totalUsd6).toString(),
      reservedUsd6: '0',
      currency: 'USD6',
    });
    // A second stop on the finished call reports that nothing was cancelled.
    const again = await api(user, `calls/${call.callId}/cancel`, {});
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, {
      cancellationRequested: false,
      code: 'ALREADY_FINISHED',
      state: 'cancelled',
      message: 'This request has already finished; nothing was cancelled.',
    });
    await ledgerHealthy();
  });
});

void test('a drain that times out or drops falls back to reconciliation pending with its reference and observation', async () => {
  const user = await owner();
  const routeVersionId = await route(
    'llama',
    'meta-llama/llama-4-scout',
    reviewedPricing.llama,
  );
  // Timeout: the provider goes silent after the stop.
  const silent = await queued(user, routeVersionId);
  const quiet = controlledProvider();
  const started = Date.now();
  const run = runNextCall(pool, quiet.provider, keys(), {
    cancelPollMs: 20,
    drainTimeoutMs: 150,
  });
  await waitFor(quiet.ready, 'dispatch');
  quiet.push(chunk('gen-fixture-silent', 'Partial answer.'));
  await waitFor(
    async () => (await state(silent.callId)).provider_reference,
    'provider reference',
  );
  assert.equal(
    (await api(user, `calls/${silent.callId}/cancel`, {})).status,
    202,
  );
  await run;
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(await state(silent.callId), {
    state: 'reconciliation_pending',
    error_code: 'CANCEL_DRAIN_TIMEOUT',
    hold_state: 'reconciliation_pending',
    captured: null,
    maximum: silent.quote.maximumUsd6,
    provider_reference: 'gen-fixture-silent',
    cancel_requested: true,
  });
  assert.deepEqual(await reconciliation(silent.holdId), {
    reason_code: 'CANCEL_DRAIN_TIMEOUT',
    observed: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    stopped: true,
    overage: null,
    resolution: null,
    resolved: null,
  });
  assert.equal(
    (
      await pool.query(
        'SELECT output_ciphertext IS NOT NULL AS saved FROM calls WHERE id=$1',
        [silent.callId],
      )
    ).rows[0].saved,
    true,
  );
  // Drop: usage arrived, then the connection reset before [DONE].
  const dropped = await queued(user, routeVersionId);
  const lossy = controlledProvider();
  const second = runNextCall(pool, lossy.provider, keys(), fast);
  await waitFor(lossy.ready, 'dispatch');
  lossy.push(chunk('gen-fixture-dropped', 'Partial answer.'));
  lossy.push(
    finish(
      'gen-fixture-dropped',
      '{"prompt_tokens":19,"completion_tokens":35,"total_tokens":54,"cost":0.0000124}',
    ),
  );
  await waitFor(
    async () => (await state(dropped.callId)).provider_reference,
    'provider reference',
  );
  assert.equal(
    (await api(user, `calls/${dropped.callId}/cancel`, {})).status,
    202,
  );
  await sleep(100);
  lossy.drop();
  await second;
  const pending = await state(dropped.callId);
  assert.equal(pending.state, 'reconciliation_pending');
  assert.equal(pending.error_code, 'PPQ_PROVIDER_UNAVAILABLE');
  assert.equal(pending.provider_reference, 'gen-fixture-dropped');
  assert.deepEqual(await reconciliation(dropped.holdId), {
    reason_code: 'PPQ_PROVIDER_UNAVAILABLE',
    observed: '13',
    input_tokens: 19,
    output_tokens: 35,
    total_tokens: 54,
    stopped: true,
    overage: null,
    resolution: null,
    resolved: null,
  });
  assert.equal(
    (await getBalance(pool, user.id)).reservedUsd6,
    (
      BigInt(silent.quote.maximumUsd6) + BigInt(dropped.quote.maximumUsd6)
    ).toString(),
  );
  await ledgerHealthy();
});

void test('a stopped call drains until its own chat deadline, never a fixed bound', () => {
  // Live regression: llama stopped at 4.5 s needed about 110 s more to reach
  // its 2048-token cap; the old fixed 60 s drain left it pending.
  const bound = drainBoundMs({
    dispatchedAt: 0,
    stoppedAt: 4_500,
    chatTimeoutMs: 120_000,
  });
  assert.ok(bound > 110_000);
  assert.ok(bound > 60_000);
  // The provider's own deadline fires first; the backstop sits just after it.
  assert.equal(bound, 120_000 - 4_500 + 5_000);
  assert.equal(
    drainBoundMs({ dispatchedAt: 1000, stoppedAt: 2000, chatTimeoutMs: 3000 }),
    7000,
  );
  // A fake provider without a declared deadline uses the client default.
  assert.equal(drainBoundMs({ dispatchedAt: 0, stoppedAt: 0 }), 605_000);
  // drainTimeoutMs is only an optional, tighter cap.
  assert.equal(
    drainBoundMs({
      dispatchedAt: 0,
      stoppedAt: 4_500,
      chatTimeoutMs: 120_000,
      drainTimeoutMs: 150,
    }),
    150,
  );
  assert.equal(
    drainBoundMs({
      dispatchedAt: 0,
      stoppedAt: 200_000,
      chatTimeoutMs: 120_000,
    }),
    0,
  );
  assert.equal(createPpqClient({ apiKey: 'k' }).chatTimeoutMs, 600_000);
  assert.equal(
    createPpqClient({ apiKey: 'k', timeouts: { chatMs: 2500 } }).chatTimeoutMs,
    2500,
  );
});

void test('a slow drain past half the chat deadline settles exactly while the lease keeps renewing through transient errors', async () => {
  const user = await owner();
  const routeVersionId = await route(
    'llama',
    'meta-llama/llama-4-scout',
    reviewedPricing.llama,
  );
  const call = await queued(user, routeVersionId);
  // Scaled timeline: a 2.5 s chat deadline stands in for 120 s, so a drain
  // longer than 1.25 s is the live case that outlasted the old 60 s bound.
  const chatMs = 2500;
  const stub = controlledProvider({ chatMs });
  const flaky = flakyHeartbeats();
  const run = runNextCall(flaky.pool, stub.provider, keys(), {
    cancelPollMs: 20,
    heartbeatMs: 25,
  });
  await waitFor(stub.ready, 'dispatch');
  stub.push(chunk('gen-fixture-slow', before300));
  await waitFor(
    async () => (await state(call.callId)).provider_reference,
    'provider reference',
  );
  assert.equal(
    (await api(user, `calls/${call.callId}/cancel`, {})).status,
    202,
  );
  const stoppedAt = Date.now();
  await sleep(100);
  const leaseAtStop = await leaseExpiry(call.callId);
  const renewalsAtStop = flaky.stats().renewals;
  // Transient renewal failures during the drain must not abort it.
  flaky.failNext(4);
  let midDrainLease;
  for (let index = 0; index < 13; index++) {
    stub.push(chunk('gen-fixture-slow', 'AFTER THE STOP '));
    await sleep(100);
    if (index === 8) midDrainLease = await leaseExpiry(call.callId);
  }
  assert.ok(Date.now() - stoppedAt > chatMs / 2);
  stub.push(
    finish(
      'gen-fixture-slow',
      '{"prompt_tokens":19,"completion_tokens":2048,"total_tokens":2067,"cost":0.00065}',
    ),
  );
  stub.push('data: [DONE]\n\n');
  stub.close();
  assert.equal(await run, true);
  assert.equal(flaky.stats().failures, 4);
  assert.ok(flaky.stats().renewals - renewalsAtStop >= 10);
  assert.ok(midDrainLease.getTime() > leaseAtStop.getTime());
  assert.deepEqual(await state(call.callId), {
    state: 'cancelled',
    error_code: null,
    hold_state: 'captured',
    captured: '650',
    maximum: call.quote.maximumUsd6,
    provider_reference: 'gen-fixture-slow',
    cancel_requested: true,
  });
  assert.equal(await reconciliation(call.holdId), null);
  const read = await api(user, `calls/${call.callId}`);
  assert.equal(read.body.call.output, before300);
  assert.deepEqual(await getBalance(pool, user.id), {
    availableUsd6: '9999350',
    reservedUsd6: '0',
    currency: 'USD6',
  });
  await ledgerHealthy();
});

void test('when the overall chat deadline fires during a drain the call stays pending as before', async () => {
  const user = await owner();
  const routeVersionId = await route(
    'llama',
    'meta-llama/llama-4-scout',
    reviewedPricing.llama,
  );
  const call = await queued(user, routeVersionId);
  const stub = controlledProvider({ chatMs: 600 });
  const run = runNextCall(pool, stub.provider, keys(), {
    cancelPollMs: 20,
    heartbeatMs: 25,
  });
  await waitFor(stub.ready, 'dispatch');
  stub.push(chunk('gen-fixture-deadline', 'Partial answer.'));
  await waitFor(
    async () => (await state(call.callId)).provider_reference,
    'provider reference',
  );
  assert.equal(
    (await api(user, `calls/${call.callId}/cancel`, {})).status,
    202,
  );
  await run;
  const result = await state(call.callId);
  assert.equal(result.state, 'reconciliation_pending');
  assert.equal(result.error_code, 'PPQ_TIMEOUT');
  assert.equal(result.hold_state, 'reconciliation_pending');
  assert.equal(result.provider_reference, 'gen-fixture-deadline');
  const record = await reconciliation(call.holdId);
  assert.equal(record.reason_code, 'PPQ_TIMEOUT');
  assert.equal(record.stopped, true);
  assert.equal(
    (await getBalance(pool, user.id)).reservedUsd6,
    call.quote.maximumUsd6,
  );
});

void test('cancel before dispatch never contacts the provider and releases the whole hold', async () => {
  const user = await owner();
  const routeVersionId = await route(
    'llama',
    'meta-llama/llama-4-scout',
    reviewedPricing.llama,
  );
  const call = await queued(user, routeVersionId);
  assert.equal(
    (await api(user, `calls/${call.callId}/cancel`, {})).status,
    202,
  );
  const stub = controlledProvider();
  await runNextCall(pool, stub.provider, keys(), fast);
  assert.equal(stub.requests(), 0);
  const result = await state(call.callId);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.hold_state, 'released');
  assert.equal(result.captured, '0');
  assert.equal(await reconciliation(call.holdId), null);
  assert.deepEqual(await getBalance(pool, user.id), {
    availableUsd6: '10000000',
    reservedUsd6: '0',
    currency: 'USD6',
  });
});

void test('the provider reference is stored from the first chunk even when the stream fails', async () => {
  const user = await owner();
  const routeVersionId = await route(
    'llama',
    'meta-llama/llama-4-scout',
    reviewedPricing.llama,
  );
  const call = await queued(user, routeVersionId);
  await runNextCall(
    pool,
    createPpqClient({
      apiKey: 'test-key-not-a-credential',
      fetch: async () =>
        new Response(
          chunk('gen-fixture-first-frame', 'Partial') +
            'data: {"choices":[],"usage":{"cost":"-1"}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    }),
    keys(),
    fast,
  );
  const result = await state(call.callId);
  assert.equal(result.state, 'reconciliation_pending');
  assert.equal(result.error_code, 'PPQ_INVALID_RESPONSE');
  assert.equal(result.provider_reference, 'gen-fixture-first-frame');
  assert.equal(
    (await reconciliation(call.holdId)).reason_code,
    'PPQ_INVALID_RESPONSE',
  );
});

void test('capture never exceeds the hold: an excess cost captures exactly the reservation and records the overage', async () => {
  for (const fee of [null, [500, 5000]]) {
    const work = async () => {
      const user = await owner();
      const routeVersionId = await route(
        'gpt',
        'gpt-6.1-sol',
        reviewedPricing.gpt,
      );
      const call = await queued(user, routeVersionId, 16);
      const terms = (
        await pool.query(
          'SELECT base_maximum_usd6::text AS base FROM quote_platform_fees WHERE quote_id=$1',
          [call.quote.id],
        )
      ).rows[0];
      const baseMaximum = BigInt(terms?.base ?? call.quote.maximumUsd6);
      const excess = baseMaximum + 12345n;
      await runNextCall(
        pool,
        {
          async *chat() {
            yield { type: 'reference', providerId: 'gen-fixture-excess' };
            yield { type: 'text', text: 'A long answer.' };
            yield {
              type: 'done',
              finishReason: 'length',
              usage: null,
              costUsd6: Number(excess),
            };
          },
        },
        keys(),
        fast,
      );
      const result = await state(call.callId);
      assert.equal(result.state, 'succeeded');
      assert.equal(result.hold_state, 'captured');
      assert.equal(result.captured, call.quote.maximumUsd6);
      assert.deepEqual(await reconciliation(call.holdId), {
        reason_code: 'COST_EXCEEDS_RESERVATION',
        observed: excess.toString(),
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        stopped: false,
        overage: '12345',
        resolution: 'capped',
        resolved: call.quote.maximumUsd6,
      });
      if (fee) {
        const split = splitPlatformFee(baseMaximum, ...fee);
        assert.equal(split.totalUsd6.toString(), call.quote.maximumUsd6);
        assert.deepEqual(await feeRow(call.holdId), {
          base: baseMaximum.toString(),
          fee: split.platformFeeUsd6.toString(),
          burn: split.burnReserveUsd6.toString(),
        });
      } else assert.equal(await feeRow(call.holdId), null);
      assert.deepEqual(await getBalance(pool, user.id), {
        availableUsd6: (
          10_000_000n - BigInt(call.quote.maximumUsd6)
        ).toString(),
        reservedUsd6: '0',
        currency: 'USD6',
      });
    };
    if (fee) await withFee(...fee, work);
    else await work();
  }
  await ledgerHealthy();
});

void test('reconcile CLI is operator-only and resolves each action exactly once with the fee and burn split', async () => {
  for (const env of [
    {},
    { ...operatorEnv, CONCLAVE_INTERNAL_TESTING: 'false' },
    { ...operatorEnv, NODE_ENV: 'production' },
    { ...operatorEnv, CONCLAVE_ENVIRONMENT: 'production' },
    {
      ...operatorEnv,
      CONCLAVE_DATABASE_URL: 'postgresql://user@db.example/x_test',
    },
    { ...operatorEnv, CONCLAVE_APP_ORIGIN: 'https://conclave.example' },
  ])
    await assert.rejects(reconcileFromCli([], env), /Refused/);
  for (const argv of [
    ['--all'],
    ['--hold', randomUUID()],
    ['--yes'],
    ['--release', '--yes'],
    ['--all', '--hold', randomUUID(), '--release'],
    ['--all', '--release', '--settle-max'],
    ['--hold', 'not-a-uuid', '--release'],
    ['--list', '--all', '--release'],
    ['--unknown'],
  ])
    await assert.rejects(
      reconcileFromCli(argv, operatorEnv),
      /Usage|--hold/,
      argv.join(' '),
    );

  await withFee(500, 5000, async () => {
    // Clear holds left pending by earlier tests so --all touches only these.
    await reconcileFromCli(['--all', '--release', '--yes'], operatorEnv);
    const user = await owner();
    const routeVersionId = await route(
      'llama',
      'meta-llama/llama-4-scout',
      reviewedPricing.llama,
    );
    const pendingWith = async (frames) => {
      const call = await queued(user, routeVersionId);
      await runNextCall(
        pool,
        createPpqClient({
          apiKey: 'test-key-not-a-credential',
          fetch: async () =>
            new Response(frames, {
              headers: { 'content-type': 'text/event-stream' },
            }),
        }),
        keys(),
        fast,
      );
      assert.equal(
        (await state(call.callId)).hold_state,
        'reconciliation_pending',
      );
      return call;
    };
    // A: usage seen, then the stream ended without [DONE].
    const usageSeen = await pendingWith(
      chunk('gen-fixture-a', 'Answer A.') +
        finish(
          'gen-fixture-a',
          '{"prompt_tokens":19,"completion_tokens":35,"total_tokens":54,"cost":0.0000124}',
        ),
    );
    // B: finished, but no usage or cost was ever reported.
    const unconfirmed = await pendingWith(
      chunk('gen-fixture-b', 'Answer B.') +
        `data: {"id":"gen-fixture-b","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
        'data: [DONE]\n\n',
    );
    // C: interrupted before any usage.
    const interrupted = await pendingWith(chunk('gen-fixture-c', 'Answer C.'));
    // D: usage beyond the reservation (recorded observation exceeds the cap).
    const overrun = await pendingWith(
      chunk('gen-fixture-d', 'Answer D.') +
        finish(
          'gen-fixture-d',
          '{"prompt_tokens":19,"completion_tokens":35,"total_tokens":54,"cost":5.5}',
        ),
    );
    const listed = await reconcileFromCli(['--list'], operatorEnv);
    assert.equal(listed.count, 4);
    const byHold = new Map(listed.pending.map((hold) => [hold.holdId, hold]));
    const a = byHold.get(usageSeen.holdId);
    assert.equal(a.reasonCode, 'PPQ_STREAM_INTERRUPTED');
    assert.equal(a.observedUsd6, '13');
    assert.equal(a.providerReference, 'gen-fixture-a');
    assert.deepEqual(a.usage, {
      inputTokens: 19,
      outputTokens: 35,
      totalTokens: 54,
    });
    assert.equal(a.platformFeeBps, 500);
    assert.deepEqual(a.plans['settle-usage'], {
      applicable: true,
      baseUsd6: '13',
      platformFeeUsd6: '0',
      burnReserveUsd6: '0',
      capturedUsd6: '13',
      releasedUsd6: (BigInt(usageSeen.quote.maximumUsd6) - 13n).toString(),
      overageUsd6: '0',
    });
    assert.equal(
      byHold.get(unconfirmed.holdId).reasonCode,
      'USAGE_UNCONFIRMED',
    );
    assert.deepEqual(byHold.get(unconfirmed.holdId).plans['settle-usage'], {
      applicable: false,
      reason: 'NO_USAGE_RECORDED',
    });
    assert.equal(
      byHold.get(interrupted.holdId).reasonCode,
      'PPQ_STREAM_INTERRUPTED',
    );
    assert.equal(byHold.get(overrun.holdId).observedUsd6, '5500000');
    assert.equal(
      listed.reservedUsd6,
      [usageSeen, unconfirmed, interrupted, overrun]
        .reduce((sum, call) => sum + BigInt(call.quote.maximumUsd6), 0n)
        .toString(),
    );
    assert.ok(!JSON.stringify(listed).includes('Answer'));

    // Dry run writes nothing.
    const balanceBefore = await getBalance(pool, user.id);
    const dry = await reconcileFromCli(
      ['--hold', usageSeen.callId, '--settle-usage'],
      operatorEnv,
    );
    assert.equal(dry.dryRun, true);
    assert.equal(dry.written, false);
    assert.equal(dry.results[0].capturedUsd6, '13');
    assert.deepEqual(await getBalance(pool, user.id), balanceBefore);
    assert.equal(
      (await state(usageSeen.callId)).hold_state,
      'reconciliation_pending',
    );

    // --settle-usage charges the recorded canonical cost.
    const settled = await reconcileFromCli(
      ['--hold', usageSeen.holdId, '--settle-usage', '--yes'],
      operatorEnv,
    );
    assert.equal(settled.written, true);
    assert.equal(settled.results[0].changed, true);
    assert.equal(settled.results[0].callState, 'succeeded');
    assert.deepEqual(await state(usageSeen.callId), {
      state: 'succeeded',
      error_code: null,
      hold_state: 'captured',
      captured: '13',
      maximum: usageSeen.quote.maximumUsd6,
      provider_reference: 'gen-fixture-a',
      cancel_requested: false,
    });
    // 13 µ$ is below the fee floor: the split records base 13, fee 0.
    assert.deepEqual(await feeRow(usageSeen.holdId), {
      base: '13',
      fee: '0',
      burn: '0',
    });
    assert.equal(
      (await reconciliation(usageSeen.holdId)).resolution,
      'settled_usage',
    );
    // Idempotent: repeating changes nothing.
    const repeat = await reconcileFromCli(
      ['--hold', usageSeen.holdId, '--settle-usage', '--yes'],
      operatorEnv,
    );
    assert.equal(repeat.written, false);
    assert.equal(repeat.results[0].changed, false);
    assert.equal(repeat.results[0].capturedUsd6, '13');

    // --settle-usage never applies without a recorded cost.
    const refused = await reconcileFromCli(
      ['--hold', unconfirmed.holdId, '--settle-usage', '--yes'],
      operatorEnv,
    );
    assert.equal(refused.results[0].changed, false);
    assert.equal(refused.results[0].skipped, 'NO_USAGE_RECORDED');

    // --settle-max charges exactly the hold: base maximum plus the fee maximum.
    const terms = (
      await pool.query(
        'SELECT base_maximum_usd6::text AS base FROM quote_platform_fees WHERE quote_id=$1',
        [unconfirmed.quote.id],
      )
    ).rows[0];
    const maxSplit = splitPlatformFee(BigInt(terms.base), 500, 5000);
    assert.equal(maxSplit.totalUsd6.toString(), unconfirmed.quote.maximumUsd6);
    const reserveBefore = (
      await pool.query(
        "SELECT balance_usd6::text AS balance FROM ledger_accounts WHERE owner_id IS NULL AND kind='burn_reserve'",
      )
    ).rows[0].balance;
    await reconcileFromCli(
      ['--hold', unconfirmed.holdId, '--settle-max', '--yes'],
      operatorEnv,
    );
    assert.equal(
      (await state(unconfirmed.callId)).captured,
      unconfirmed.quote.maximumUsd6,
    );
    assert.equal((await state(unconfirmed.callId)).state, 'succeeded');
    assert.deepEqual(await feeRow(unconfirmed.holdId), {
      base: terms.base,
      fee: maxSplit.platformFeeUsd6.toString(),
      burn: maxSplit.burnReserveUsd6.toString(),
    });
    assert.equal(
      (
        await pool.query(
          "SELECT balance_usd6::text AS balance FROM ledger_accounts WHERE owner_id IS NULL AND kind='burn_reserve'",
        )
      ).rows[0].balance,
      (BigInt(reserveBefore) + maxSplit.burnReserveUsd6).toString(),
    );
    assert.equal(
      (await reconciliation(unconfirmed.holdId)).resolution,
      'settled_max',
    );

    // --settle-usage above the reservation is capped and the excess recorded.
    const capped = await reconcileFromCli(
      ['--hold', overrun.holdId, '--settle-usage', '--yes'],
      operatorEnv,
    );
    assert.equal(capped.results[0].capturedUsd6, overrun.quote.maximumUsd6);
    const overrunTerms = (
      await pool.query(
        'SELECT base_maximum_usd6::text AS base FROM quote_platform_fees WHERE quote_id=$1',
        [overrun.quote.id],
      )
    ).rows[0];
    assert.deepEqual(
      {
        resolution: (await reconciliation(overrun.holdId)).resolution,
        overage: (await reconciliation(overrun.holdId)).overage,
      },
      {
        resolution: 'settled_usage',
        overage: (5_500_000n - BigInt(overrunTerms.base)).toString(),
      },
    );

    // --release charges nothing and records no fee.
    await reconcileFromCli(
      ['--hold', interrupted.holdId, '--release', '--yes'],
      operatorEnv,
    );
    const released = await state(interrupted.callId);
    assert.equal(released.hold_state, 'released');
    assert.equal(released.captured, '0');
    assert.equal(released.state, 'failed');
    assert.equal(released.error_code, 'PPQ_STREAM_INTERRUPTED');
    assert.equal(await feeRow(interrupted.holdId), null);
    assert.equal(
      (await reconciliation(interrupted.holdId)).resolution,
      'released',
    );

    // Nothing remains pending, and the account is exactly the sum of captures.
    assert.equal((await reconcileFromCli([], operatorEnv)).count, 0);
    assert.deepEqual(
      (await reconcileFromCli(['--all', '--settle-max', '--yes'], operatorEnv))
        .results,
      [],
    );
    const captured =
      13n +
      BigInt(unconfirmed.quote.maximumUsd6) +
      BigInt(overrun.quote.maximumUsd6);
    assert.deepEqual(await getBalance(pool, user.id), {
      availableUsd6: (10_000_000n - captured).toString(),
      reservedUsd6: '0',
      currency: 'USD6',
    });
  });
  // Resolved records are immutable.
  await assert.rejects(
    pool.query(
      "UPDATE hold_reconciliations SET resolution='released' WHERE resolution IS NOT NULL",
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query('DELETE FROM hold_reconciliations'),
    (error) => error.code === '23514',
  );
  await ledgerHealthy();
});

void test('a stopped legacy hold is resolved as cancelled; maintenance reports pending holds by code', async () => {
  const user = await owner();
  const routeVersionId = await route(
    'llama',
    'meta-llama/llama-4-scout',
    reviewedPricing.llama,
  );
  await reconcileFromCli(['--all', '--release', '--yes'], operatorEnv);
  // A hold stopped by the old worker: pending with no reconciliation record.
  const legacy = await queued(user, routeVersionId);
  await pool.query(
    "UPDATE holds SET state='reconciliation_pending',cancel_requested_at=now() WHERE id=$1",
    [legacy.holdId],
  );
  await pool.query(
    "UPDATE calls SET state='reconciliation_pending',error_code='PPQ_CANCELLED' WHERE id=$1",
    [legacy.callId],
  );
  await pool.query("UPDATE jobs SET state='dead' WHERE reference=$1", [
    `inference:${legacy.callId}`,
  ]);
  const second = await queued(user, routeVersionId);
  await runNextCall(
    pool,
    createPpqClient({
      apiKey: 'test-key-not-a-credential',
      fetch: async () =>
        new Response(
          chunk('gen-fixture-maint', 'Answer.') + 'data: [DONE]\n\n',
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    }),
    keys(),
    fast,
  );
  assert.equal(
    (await state(second.callId)).error_code,
    'PPQ_STREAM_INTERRUPTED',
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./maintenance.mjs', import.meta.url)),
    ],
    { env: { ...process.env, CONCLAVE_DATABASE_URL: connection } },
  );
  const report = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(report.pending_holds, '2');
  assert.equal(report.pending_holds_ppq_cancelled, '1');
  assert.equal(report.pending_holds_ppq_stream_interrupted, '1');
  assert.equal(
    report.pending_reserved_usd6,
    (
      BigInt(legacy.quote.maximumUsd6) + BigInt(second.quote.maximumUsd6)
    ).toString(),
  );
  assert.equal(report.imbalanced, '0');
  assert.equal(report.balance_drift, '0');
  assert.ok(Number(report.capped_settlements) >= 2);
  assert.ok(!stdout.includes(user.id));

  const result = await reconcileFromCli(
    ['--hold', legacy.holdId, '--settle-max', '--yes'],
    operatorEnv,
  );
  assert.equal(result.results[0].callState, 'cancelled');
  assert.equal(result.results[0].reasonCode, 'PPQ_CANCELLED');
  const resolved = await state(legacy.callId);
  assert.equal(resolved.state, 'cancelled');
  assert.equal(resolved.error_code, 'PPQ_CANCELLED');
  assert.equal(resolved.captured, legacy.quote.maximumUsd6);
  assert.deepEqual(
    {
      reason: (await reconciliation(legacy.holdId)).reason_code,
      stopped: (await reconciliation(legacy.holdId)).stopped,
      resolution: (await reconciliation(legacy.holdId)).resolution,
    },
    { reason: 'PPQ_CANCELLED', stopped: true, resolution: 'settled_max' },
  );
  await ledgerHealthy();
});

void test('an account whose recent settlements overran their reservations beyond the configured limit cannot reserve again', async () => {
  const user = await owner();
  const routeVersionId = await route('gpt', 'gpt-6.1-sol', reviewedPricing.gpt);
  const call = await queued(user, routeVersionId, 16);
  const excess = BigInt(call.quote.maximumUsd6) + 12345n;
  await runNextCall(
    pool,
    {
      async *chat() {
        yield { type: 'reference', providerId: 'gen-fixture-breaker' };
        yield { type: 'text', text: 'A long answer.' };
        yield {
          type: 'done',
          finishReason: 'length',
          usage: null,
          costUsd6: Number(excess),
        };
      },
    },
    keys(),
    fast,
  );
  assert.equal((await reconciliation(call.holdId)).overage, '12345');
  const item = {
    projectId: user.projectId,
    routeVersionId,
    messages: [{ role: 'user', content: 'A recorded fixture' }],
    maxOutputTokens: 16,
    privacy: 'standard',
  };
  const attempt = async () => {
    const quote = await api(user, 'quotes', item);
    assert.equal(quote.status, 201, quote.text);
    return api(user, 'calls', {
      ...item,
      quoteId: quote.body.quote.id,
      idempotencyKey: randomUUID(),
    });
  };
  process.env.CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6 = '12344';
  try {
    const refused = await attempt();
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.body.error.code, 'OVERAGE_LIMIT_REACHED');
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM holds WHERE account_id=$1', [user.id])).rows[0].n,
      1,
    );
    // Another account is unaffected by this account's overage.
    const other = await owner();
    const theirs = await queued(other, routeVersionId, 16);
    assert.ok(theirs.holdId);
    process.env.CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6 = '12345';
    const allowed = await attempt();
    assert.equal(allowed.status, 202, allowed.text);
    process.env.CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6 = '12,345';
    const invalid = await attempt();
    assert.equal(invalid.status, 503, invalid.text);
    assert.equal(invalid.body.error.code, 'CONFIGURATION_REQUIRED');
  } finally {
    delete process.env.CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6;
  }
});

void test('stopping a long native stream still allows time to reconcile its final usage', () => {
 assert.equal(drainBoundMs({dispatchedAt:0, stoppedAt:3600000, chatTimeoutMs:600000, idleTimeout:true}),605000);
});

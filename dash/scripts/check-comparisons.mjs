import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import {
  creditVerifiedDeposit,
  getBalance,
  settleHold,
} from '../server/ledger/ledger.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { migrate } from './migrate.mjs';
import { configuredKeyring, encryptText } from '../server/core/encryption.ts';
import {
  issueCallReceipt,
  receiptTrustFromValues,
} from '../server/receipts/service.ts';
import { receiptPublicKey } from '../server/receipts/index.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set CONCLAVE_TEST_DATABASE_URL to an isolated local test database.',
  );
const url = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('An isolated loopback test database is required.');
Object.assign(process.env, {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.test',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_DATA_KEYS: JSON.stringify({
    test: randomBytes(32).toString('base64'),
  }),
  CONCLAVE_ACTIVE_DATA_KEY: 'test',
  PPQ_API_KEY: 'fixture-not-a-provider-key',
  CONCLAVE_INFERENCE_ENABLED: 'true',
});
const pool = createDatabase(connection, 12);
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.end();
});
async function owner(balance = '1000000', distinctPrices = false) {
  const id = randomUUID(),
    token = generateSessionToken(),
    projectId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), id],
  );
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Owned comparison')",
    [projectId, id],
  );
  if (balance !== '0')
    await creditVerifiedDeposit(pool, {
      accountId: id,
      reference: `fixture_${randomUUID()}`,
      amountUsd6: balance,
    });
  const items = [];
  for (const [family, model] of [
    ['claude', 'claude-opus-5.5'],
    ['gemini', 'google/gemini-3.1-pro-preview'],
    ['gpt', 'gpt-6.1-sol'],
    ['grok', 'x-ai/grok-4.7'],
  ]) {
    const routeVersionId = randomUUID();
    await pool.query(
      `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
      VALUES($1,$2,1,$3,$4,'chat',true,$5,$6,now()+interval '1 hour')`,
      [
        routeVersionId,
        randomUUID(),
        model,
        family,
        {
          reviewed: true,
          retentionDisclosure: 'Test only.',
          evidenceUrl: 'https://example.test/terms',
          evidenceDate: '2026-10-09',
        },
        {
          inputPerMillionUsd6: String(
            1000000 * (distinctPrices ? items.length + 1 : 1),
          ),
          outputPerMillionUsd6: '1000000',
          markupBps: 0,
          maxInputBytes: 32768,
          maxOutputTokens: 2048,
        },
      ],
    );
    items.push({
      routeVersionId,
      messages: [{ role: 'user', content: 'Compare the tradeoffs.' }],
      maxOutputTokens: 128,
      privacy: 'standard',
    });
  }
  return { id, projectId, items, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}
async function api(
  user,
  path,
  body,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method,
      headers: {
        origin: 'https://conclave.test',
        cookie: user.cookie,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}
async function quoted(user, blind = false) {
  const response = await api(user, 'comparison-quotes', {
    projectId: user.projectId,
    items: user.items,
    blind,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return {
    projectId: user.projectId,
    blind,
    idempotencyKey: randomUUID(),
    items: user.items.map((item, index) => ({
      ...item,
      quoteId: response.body.quotes[index].id,
    })),
    maximum: response.body.maximumUsd6,
  };
}

async function completedSnapshot(user, callId) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/calls/${callId}/events`, {
      headers: { cookie: user.cookie },
    }),
  );
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n\n');
  assert.ok(events.some((event) => event.includes('event: complete\n')));
  const snapshot = events.find((event) => event.includes('event: snapshot\n'));
  assert.ok(snapshot, 'A completed request must produce a durable snapshot.');
  return JSON.parse(
    snapshot
      .split('\n')
      .find((line) => line.startsWith('data: '))
      .slice(6),
  );
}

void test('four-model reservation is atomic and concurrent retries create one comparison and four jobs', async () => {
  const user = await owner(),
    body = await quoted(user);
  const responses = await Promise.all(
    Array.from({ length: 6 }, () => api(user, 'comparisons', body)),
  );
  assert.equal(responses.filter((result) => result.status === 202).length, 1);
  assert.ok(
    responses.every((result) => [200, 202].includes(result.status)),
    JSON.stringify(responses),
  );
  const ids = responses.map((result) => result.body.comparison.id);
  assert.equal(new Set(ids).size, 1);
  assert.equal(responses[0].body.comparison.calls.length, 4);
  assert.equal((await getBalance(pool, user.id)).reservedUsd6, body.maximum);
  const jobs = await pool.query(
    "SELECT j.id FROM jobs j JOIN calls c ON j.payload->>'callId'=c.id::text WHERE c.account_id=$1",
    [user.id],
  );
  assert.equal(jobs.rowCount, 4);
  assert.equal(
    (await api(user, 'comparisons', { ...body, blind: true })).status,
    409,
  );
});

void test('a configured hold buffer reserves the buffered maximum for every child and releases the unused part', async () => {
  const user = await owner('1000000', true);
  const quoteBody = {
    projectId: user.projectId,
    items: user.items,
    blind: false,
  };
  const listed = await api(user, 'comparison-quotes', quoteBody);
  assert.equal(listed.status, 201);
  process.env.CONCLAVE_HOLD_BUFFER_BPS = '1000';
  let holds;
  try {
    const widened = await api(user, 'comparison-quotes', quoteBody);
    assert.equal(widened.status, 201, JSON.stringify(widened.body));
    let total = 0n;
    for (const [index, quote] of widened.body.quotes.entries()) {
      const base = BigInt(listed.body.quotes[index].maximumUsd6),
        buffered = base + (base * 1000n + 9999n) / 10000n;
      assert.deepEqual(quote.reservation, {
        bufferBps: 1000,
        baseMaximumUsd6: base.toString(),
        bufferedBaseMaximumUsd6: buffered.toString(),
      });
      assert.equal(quote.maximumUsd6, buffered.toString());
      assert.equal(quote.platformFee, undefined);
      total += buffered;
    }
    assert.equal(widened.body.maximumUsd6, total.toString());
    assert.ok(BigInt(total) > BigInt(listed.body.maximumUsd6));
    // Accepting the comparison reserves the buffered total for each child.
    const created = await api(user, 'comparisons', {
      projectId: user.projectId,
      blind: false,
      idempotencyKey: randomUUID(),
      items: user.items.map((item, index) => ({
        ...item,
        quoteId: widened.body.quotes[index].id,
      })),
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(
      (await getBalance(pool, user.id)).reservedUsd6,
      total.toString(),
    );
    holds = (
      await pool.query(
        `SELECT c.hold_id,h.maximum_usd6::text FROM comparison_calls cc
        JOIN calls c ON c.id=cc.call_id JOIN holds h ON h.id=c.hold_id
        WHERE cc.comparison_id=$1 ORDER BY cc.position`,
        [created.body.comparison.id],
      )
    ).rows;
    assert.deepEqual(
      holds.map((hold) => hold.maximum_usd6),
      widened.body.quotes.map((quote) => quote.maximumUsd6),
    );
    // A child billed above its listed price but within the buffer settles in
    // full and releases the remainder; beyond the buffer it still refuses.
    const bill = BigInt(listed.body.quotes[0].maximumUsd6) + 1n;
    const settled = await settleHold(pool, {
      accountId: user.id,
      holdId: holds[0].hold_id,
      actualUsd6: bill.toString(),
      providerReference: 'fixture-provider',
    });
    assert.equal(settled.overageUsd6, 0n);
    assert.equal(settled.hold.captured_usd6, bill.toString());
    assert.equal(
      (await getBalance(pool, user.id)).reservedUsd6,
      (total - BigInt(holds[0].maximum_usd6)).toString(),
    );
    await assert.rejects(
      settleHold(pool, {
        accountId: user.id,
        holdId: holds[1].hold_id,
        actualUsd6: (BigInt(holds[1].maximum_usd6) + 1n).toString(),
        providerReference: null,
      }),
      (error) => error.code === 'COST_EXCEEDS_RESERVATION',
    );
  } finally {
    delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
  }
  // An explicit zero buffer leaves the response fields and amounts unchanged.
  process.env.CONCLAVE_HOLD_BUFFER_BPS = '0';
  try {
    const zero = await api(user, 'comparison-quotes', quoteBody);
    assert.equal(zero.status, 201);
    const shape = (quote) => [Object.keys(quote).sort().join(), quote.maximumUsd6];
    assert.deepEqual(
      zero.body.quotes.map(shape),
      listed.body.quotes.map(shape),
    );
    assert.equal(zero.body.maximumUsd6, listed.body.maximumUsd6);
  } finally {
    delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
  }
  // An invalid buffer fails closed without creating quotes.
  process.env.CONCLAVE_HOLD_BUFFER_BPS = '10%';
  try {
    const before = (
      await pool.query('SELECT count(*)::int AS n FROM quotes WHERE account_id=$1', [
        user.id,
      ])
    ).rows[0].n;
    const invalid = await api(user, 'comparison-quotes', quoteBody);
    assert.equal(invalid.status, 503);
    assert.equal(invalid.body.error.code, 'CONFIGURATION_REQUIRED');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM quotes WHERE account_id=$1',
          [user.id],
        )
      ).rows[0].n,
      before,
    );
  } finally {
    delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
  }
});
void test('insufficient aggregate balance rolls back every child, ledger movement and job', async () => {
  const user = await owner('2000'),
    body = await quoted(user);
  assert.ok(BigInt(body.maximum) > 2000n);
  assert.equal((await api(user, 'comparisons', body)).status, 402);
  for (const table of ['calls', 'holds', 'comparisons'])
    assert.equal(
      (
        await pool.query(`SELECT id FROM ${table} WHERE account_id=$1`, [
          user.id,
        ])
      ).rowCount,
      0,
    );
  assert.deepEqual(await getBalance(pool, user.id), {
    availableUsd6: '2000',
    reservedUsd6: '0',
    currency: 'USD6',
  });
});

void test('a disabled route, expired quote or changed question cannot partially reserve a comparison', async () => {
  const user = await owner(),
    body = await quoted(user);
  const bad = structuredClone(body);
  bad.items[2].messages[0].content = 'A changed question.';
  assert.equal((await api(user, 'comparisons', bad)).status, 400);
  await pool.query('UPDATE route_versions SET enabled=false WHERE id=$1', [
    user.items[3].routeVersionId,
  ]);
  assert.equal((await api(user, 'comparisons', body)).status, 409);
  await pool.query('UPDATE route_versions SET enabled=true WHERE id=$1', [
    user.items[3].routeVersionId,
  ]);
  await pool.query(
    "UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
    [body.items[3].quoteId],
  );
  assert.equal((await api(user, 'comparisons', body)).status, 409);
  assert.equal((await getBalance(pool, user.id)).reservedUsd6, '0');
});

void test('accepted comparison survives provider disable and quote expiration without a second reservation', async () => {
  const user = await owner(),
    body = await quoted(user),
    first = await api(user, 'comparisons', body);
  assert.equal(first.status, 202);
  await pool.query(
    'UPDATE route_versions SET enabled=false WHERE id=ANY($1::uuid[])',
    [user.items.map((item) => item.routeVersionId)],
  );
  await pool.query(
    "UPDATE quotes SET expires_at=now()-interval '1 second' WHERE account_id=$1",
    [user.id],
  );
  process.env.CONCLAVE_INFERENCE_ENABLED = 'false';
  try {
    const retry = await api(user, 'comparisons', body);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.comparison.id, first.body.comparison.id);
  } finally {
    process.env.CONCLAVE_INFERENCE_ENABLED = 'true';
  }
  assert.equal((await getBalance(pool, user.id)).reservedUsd6, body.maximum);
});

void test('owned history and blind assignments persist; a foreign or unfinished vote never reveals identity', async () => {
  const user = await owner(),
    other = await owner('0'),
    body = await quoted(user, true),
    created = await api(user, 'comparisons', body);
  const comparison = created.body.comparison;
  assert.equal(created.status, 202);
  assert.ok(
    comparison.calls.every(
      (call) =>
        call.modelId === null &&
        call.family === null &&
        call.routeVersionId === null,
    ),
  );
  assert.equal((await api(other, `comparisons/${comparison.id}`)).status, 404);
  assert.equal(
    (await api(other, `comparisons?projectId=${user.projectId}`)).status,
    404,
  );
  assert.equal(
    (
      await api(user, `comparisons/${comparison.id}/vote`, {
        callId: comparison.calls[0].id,
      })
    ).status,
    409,
  );
  const history = await api(user, `comparisons?projectId=${user.projectId}`);
  assert.deepEqual(
    history.body.comparisons[0].calls.map((call) => call.id),
    comparison.calls.map((call) => call.id),
  );
  await pool.query("UPDATE calls SET state='succeeded' WHERE id=$1", [
    comparison.calls[1].id,
  ]);
  const voted = await api(user, `comparisons/${comparison.id}/vote`, {
    callId: comparison.calls[1].id,
  });
  assert.equal(voted.status, 200);
  assert.equal(voted.body.comparison.votedCallId, comparison.calls[1].id);
  assert.ok(
    voted.body.comparison.calls.every((call) => call.modelId && call.family),
  );
  assert.equal(
    (
      await api(user, `comparisons/${comparison.id}/vote`, {
        callId: comparison.calls[0].id,
      })
    ).status,
    409,
  );
});

void test('group cancellation records all active siblings while archival is revision-safe and keeps accounting', async () => {
  const user = await owner(),
    body = await quoted(user),
    created = await api(user, 'comparisons', body),
    id = created.body.comparison.id;
  assert.equal((await api(user, `comparisons/${id}/cancel`, {})).status, 200);
  assert.equal(
    (
      await pool.query(
        'SELECT id FROM holds WHERE account_id=$1 AND cancel_requested_at IS NOT NULL',
        [user.id],
      )
    ).rowCount,
    4,
  );
  assert.equal(
    (await api(user, `projects/${user.projectId}`, { revision: 2 }, 'DELETE'))
      .status,
    409,
  );
  assert.equal(
    (await api(user, `projects/${user.projectId}`, { revision: 1 }, 'DELETE'))
      .status,
    200,
  );
  assert.equal((await api(user, 'projects')).body.projects.length, 0);
  assert.equal((await getBalance(pool, user.id)).reservedUsd6, body.maximum);
  assert.equal((await api(user, `comparisons/${id}`)).status, 200);
});

void test('foreign comparison quotes, calls, cancellation, votes and event streams never cross ownership', async () => {
  const user = await owner(),
    other = await owner(),
    body = await quoted(user, true);
  const foreignQuote = await api(other, 'comparison-quotes', {
    projectId: user.projectId,
    items: user.items,
  });
  assert.equal(foreignQuote.status, 404);
  const comparison = (await api(user, 'comparisons', body)).body.comparison;
  for (const operation of ['cancel', 'reveal', 'vote']) {
    assert.equal(
      (
        await api(other, `comparisons/${comparison.id}/${operation}`, {
          callId: comparison.calls[0].id,
        })
      ).status,
      404,
    );
  }
  for (const call of comparison.calls) {
    assert.equal((await api(other, `calls/${call.id}`)).status, 404);
    assert.equal((await api(other, `calls/${call.id}/cancel`, {})).status, 404);
    assert.equal((await api(other, `calls/${call.id}/events`)).status, 404);
  }
  assert.ok(
    (
      await api(user, `comparisons/${comparison.id}`)
    ).body.comparison.calls.every((call) => call.modelId === null),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT id FROM holds WHERE account_id=$1 AND cancel_requested_at IS NOT NULL',
        [user.id],
      )
    ).rowCount,
    0,
  );
});

void test('cross-owner reversed shared-route order does not deadlock or duplicate reservations', async () => {
  const a = await owner(),
    b = await owner();
  b.items = [...a.items].reverse();
  const [qa, qb] = await Promise.all([quoted(a, true), quoted(b, true)]);
  const results = await Promise.all([
    api(a, 'comparisons', qa),
    api(b, 'comparisons', qb),
    api(a, 'comparisons', qa),
    api(b, 'comparisons', qb),
  ]);
  assert.ok(
    results.every((result) => [200, 202].includes(result.status)),
    JSON.stringify(
      results.map((result) => ({
        status: result.status,
        error: result.body.error?.code,
      })),
    ),
  );
  assert.equal(results.filter((result) => result.status === 202).length, 2);
  assert.equal((await getBalance(pool, a.id)).reservedUsd6, qa.maximum);
  assert.equal((await getBalance(pool, b.id)).reservedUsd6, qb.maximum);
});

void test('racing a single request against the same comparison quote reserves only the winning request', async () => {
  const user = await owner(),
    body = await quoted(user),
    first = body.items[0];
  const single = {
    projectId: user.projectId,
    ...first,
    idempotencyKey: randomUUID(),
  };
  const [group, call] = await Promise.all([
    api(user, 'comparisons', body),
    api(user, 'calls', single),
  ]);
  assert.deepEqual(
    [group.status, call.status].sort((a, b) => a - b),
    [202, 409],
  );
  const holds = await pool.query(
    'SELECT maximum_usd6 FROM holds WHERE account_id=$1',
    [user.id],
  );
  assert.equal(holds.rowCount, group.status === 202 ? 4 : 1);
  assert.equal(
    (await getBalance(pool, user.id)).reservedUsd6,
    holds.rows
      .reduce((sum, row) => sum + BigInt(row.maximum_usd6), 0n)
      .toString(),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer AS count FROM holds WHERE quote_id=$1',
        [first.quoteId],
      )
    ).rows[0].count,
    1,
  );
});

void test('archival racing acceptance either rejects every child or preserves the accepted group for cancellation', async () => {
  const user = await owner(),
    body = await quoted(user);
  const [accepted, archived] = await Promise.all([
    api(user, 'comparisons', body),
    api(user, `projects/${user.projectId}`, { revision: 1 }, 'DELETE'),
  ]);
  assert.equal(archived.status, 200);
  assert.ok([202, 404, 409].includes(accepted.status));
  if (accepted.status === 202) {
    const id = accepted.body.comparison.id;
    const cancellations = await Promise.all(
      Array.from({ length: 3 }, () =>
        api(user, `comparisons/${id}/cancel`, {}),
      ),
    );
    assert.ok(cancellations.every((result) => result.status === 200));
    assert.equal((await api(user, `comparisons/${id}`)).status, 200);
    assert.equal((await getBalance(pool, user.id)).reservedUsd6, body.maximum);
  } else {
    assert.equal((await getBalance(pool, user.id)).reservedUsd6, '0');
    assert.equal(
      (await pool.query('SELECT id FROM calls WHERE account_id=$1', [user.id]))
        .rowCount,
      0,
    );
  }
});

void test('disabled inference and secret-bearing input fail before any child reservation', async () => {
  const user = await owner(),
    body = await quoted(user);
  process.env.CONCLAVE_INFERENCE_ENABLED = 'false';
  try {
    assert.equal((await api(user, 'comparisons', body)).status, 503);
  } finally {
    process.env.CONCLAVE_INFERENCE_ENABLED = 'true';
  }
  const secret = 'sk-' + 'x'.repeat(40);
  const guarded = structuredClone(user.items);
  for (const item of guarded) item.messages[0].content = secret;
  const blocked = await api(user, 'comparison-quotes', {
    projectId: user.projectId,
    items: guarded,
  });
  assert.equal(blocked.status, 422);
  assert.ok(!JSON.stringify(blocked.body).includes(secret));
  assert.equal((await getBalance(pool, user.id)).reservedUsd6, '0');
  assert.equal(
    (
      await pool.query('SELECT id FROM comparisons WHERE account_id=$1', [
        user.id,
      ])
    ).rowCount,
    0,
  );
});

void test('owned encrypted outputs load while malformed ciphertext never leaks data or database details', async () => {
  const user = await owner(),
    other = await owner(),
    body = await quoted(user);
  const comparison = (await api(user, 'comparisons', body)).body.comparison;
  const callId = comparison.calls[0].id,
    output = 'A private synthetic comparison answer.';
  const cipher = await encryptText(
    output,
    `${user.id}:call-output:${callId}`,
    configuredKeyring(),
  );
  await pool.query('UPDATE calls SET output_ciphertext=$2 WHERE id=$1', [
    callId,
    cipher,
  ]);
  assert.equal(
    (await api(user, `comparisons/${comparison.id}`)).body.comparison.calls[0]
      .output,
    output,
  );
  assert.equal((await api(other, `comparisons/${comparison.id}`)).status, 404);
  await pool.query('UPDATE calls SET output_ciphertext=$2 WHERE id=$1', [
    callId,
    'invalid-private-fixture',
  ]);
  const failed = await api(user, `comparisons/${comparison.id}`);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, 'CONTENT_UNAVAILABLE');
  for (const forbidden of [
    output,
    cipher,
    'invalid-private-fixture',
    'SELECT',
    'postgres',
  ])
    assert.ok(!JSON.stringify(failed.body).includes(forbidden));
});

void test('blind comparisons must not expose per-answer quote amounts that identify shuffled models', async () => {
  const user = await owner('1000000', true),
    body = await quoted(user, true);
  const comparison = (await api(user, 'comparisons', body)).body.comparison;
  assert.ok(comparison.calls.every((call) => call.modelId === null));
  for (const call of comparison.calls)
    assert.equal(
      call.billing.maximumUsd6,
      null,
      'Per-answer quote amounts must remain hidden until reveal.',
    );
});

void test('a predictable child idempotency key must not reveal a blind call-to-route assignment', async () => {
  const user = await owner(),
    body = await quoted(user, true);
  const comparison = (await api(user, 'comparisons', body)).body.comparison;
  const mapped = await api(user, 'calls', {
    projectId: user.projectId,
    ...body.items[0],
    idempotencyKey: `${body.idempotencyKey}_0`,
  });
  assert.notEqual(
    mapped.status,
    200,
    'Single-call replay must not reveal an unrevealed comparison child.',
  );
  assert.ok(!comparison.calls.some((call) => call.id === mapped.body.call?.id));
  assert.equal((await getBalance(pool, user.id)).reservedUsd6, body.maximum);
});

void test('blind child identity stays hidden through direct call reads, events, known-key replay and receipts until reveal', async () => {
  const user = await owner('1000000', true),
    other = await owner('0'),
    body = await quoted(user, true);
  const comparison = (await api(user, 'comparisons', body)).body.comparison;
  assert.equal(comparison.billing.maximumUsd6, body.maximum);
  const callId = comparison.calls[0].id;
  const stored = (
    await pool.query(
      `SELECT c.hold_id,c.route_version_id,h.idempotency_key,h.quote_id,h.maximum_usd6
    FROM calls c JOIN holds h ON h.id=c.hold_id WHERE c.id=$1`,
      [callId],
    )
  ).rows[0];
  const original = body.items.find((item) => item.quoteId === stored.quote_id);
  assert.ok(original);
  const replay = await api(user, 'calls', {
    projectId: user.projectId,
    ...original,
    idempotencyKey: stored.idempotency_key,
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'BLIND_COMPARISON');
  await settleHold(pool, {
    accountId: user.id,
    holdId: stored.hold_id,
    actualUsd6: '100',
    providerReference: null,
  });
  await pool.query("UPDATE calls SET state='succeeded' WHERE id=$1", [callId]);
  const seed = new Uint8Array(randomBytes(32));
  try {
    const registered = {
      keyId: `test-${randomUUID()}`,
      epoch: 1,
      publicKey: receiptPublicKey(seed),
      validFrom: new Date(Date.now() - 60000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      revoked: false,
    };
    const { receipt } = await issueCallReceipt(
      pool,
      { accountId: user.id, callId },
      {
        keyId: registered.keyId,
        epoch: 1,
        seed,
        trust: receiptTrustFromValues([registered]),
      },
    );
    const receiptId = receipt.payload.receiptId;
    for (const snapshot of [
      (await api(user, `calls/${callId}`)).body.call,
      await completedSnapshot(user, callId),
    ]) {
      assert.equal(snapshot.billing.maximumUsd6, null);
      assert.equal(snapshot.billing.actualUsd6, null);
      for (const forbidden of [
        stored.route_version_id,
        original.quoteId,
        stored.idempotency_key,
      ])
        assert.ok(!JSON.stringify(snapshot).includes(forbidden));
    }
    assert.equal((await api(user, 'receipts')).body.receipts.length, 0);
    for (const suffix of ['', '/proof']) {
      const hidden = await api(user, `receipts/${receiptId}${suffix}`);
      assert.equal(hidden.status, 409);
      assert.equal(hidden.body.error.code, 'BLIND_COMPARISON');
      assert.equal(
        (await api(other, `receipts/${receiptId}${suffix}`)).status,
        404,
      );
    }
    const revealed = await api(user, `comparisons/${comparison.id}/reveal`, {});
    assert.equal(revealed.status, 200);
    assert.equal(
      revealed.body.comparison.calls[0].routeVersionId,
      stored.route_version_id,
    );
    for (const snapshot of [
      (await api(user, `calls/${callId}`)).body.call,
      await completedSnapshot(user, callId),
    ]) {
      assert.equal(snapshot.billing.maximumUsd6, stored.maximum_usd6);
      assert.equal(snapshot.billing.actualUsd6, '100');
    }
    assert.equal((await api(user, 'receipts')).body.receipts[0].id, receiptId);
    for (const suffix of ['', '/proof']) {
      const visible = await api(user, `receipts/${receiptId}${suffix}`);
      assert.equal(visible.status, 200);
      assert.equal(
        visible.body.receipt.payload.routeVersion,
        stored.route_version_id,
      );
      assert.equal(visible.body.batch, null);
    }
  } finally {
    seed.fill(0);
  }
});

void test('history labels 16000-character previews and owned detail reads retain the complete encrypted answer', async () => {
  const user = await owner(),
    other = await owner('0'),
    body = await quoted(user);
  const comparison = (await api(user, 'comparisons', body)).body.comparison;
  const callId = comparison.calls[0].id,
    output = 'Synthetic answer with details. '.repeat(900);
  assert.ok(output.length > 16000);
  await pool.query('UPDATE calls SET output_ciphertext=$2 WHERE id=$1', [
    callId,
    await encryptText(
      output,
      `${user.id}:call-output:${callId}`,
      configuredKeyring(),
    ),
  ]);
  const history = await api(user, `comparisons?projectId=${user.projectId}`);
  const preview = history.body.comparisons[0].calls[0];
  assert.equal(preview.output, output.slice(0, 16000));
  assert.equal(preview.outputTruncated, true);
  assert.equal(preview.outputLength, output.length);
  const detail = (await api(user, `comparisons/${comparison.id}`)).body
    .comparison.calls[0];
  assert.equal(detail.output, output);
  assert.equal(detail.outputTruncated, false);
  assert.equal(detail.outputLength, output.length);
  assert.equal((await api(user, `calls/${callId}`)).body.call.output, output);
  assert.equal(
    (await api(other, `comparisons?projectId=${user.projectId}`)).status,
    404,
  );
  assert.equal((await api(other, `calls/${callId}`)).status, 404);
});

void test('cancellation racing settlement preserves the captured charge and only flags unsettled siblings', async () => {
  const user = await owner(),
    body = await quoted(user);
  const comparison = (await api(user, 'comparisons', body)).body.comparison;
  const hold = (
    await pool.query(
      'SELECT h.id,h.maximum_usd6 FROM holds h JOIN calls c ON c.hold_id=h.id WHERE c.id=$1',
      [comparison.calls[0].id],
    )
  ).rows[0];
  const outcomes = await Promise.all([
    api(user, `comparisons/${comparison.id}/cancel`, {}),
    settleHold(pool, {
      accountId: user.id,
      holdId: hold.id,
      actualUsd6: '100',
      providerReference: null,
    }),
    api(user, `comparisons/${comparison.id}/cancel`, {}),
  ]);
  assert.equal(outcomes[0].status, 200);
  assert.equal(outcomes[2].status, 200);
  const holds = (
    await pool.query(
      'SELECT id,state,captured_usd6,cancel_requested_at FROM holds WHERE account_id=$1',
      [user.id],
    )
  ).rows;
  assert.equal(holds.find((item) => item.id === hold.id).state, 'captured');
  assert.equal(holds.find((item) => item.id === hold.id).captured_usd6, '100');
  assert.ok(
    holds
      .filter((item) => item.id !== hold.id)
      .every((item) => item.state === 'held' && item.cancel_requested_at),
  );
  assert.deepEqual(await getBalance(pool, user.id), {
    availableUsd6: (
      1000000n -
      BigInt(body.maximum) +
      BigInt(hold.maximum_usd6) -
      100n
    ).toString(),
    reservedUsd6: (BigInt(body.maximum) - BigInt(hold.maximum_usd6)).toString(),
    currency: 'USD6',
  });
  assert.equal(
    (
      await settleHold(pool, {
        accountId: user.id,
        holdId: hold.id,
        actualUsd6: '100',
        providerReference: null,
      })
    ).replayed,
    true,
  );
});

void test('simultaneous conflicting blind votes reveal exactly one immutable winner', async () => {
  const user = await owner(),
    body = await quoted(user, true);
  const comparison = (await api(user, 'comparisons', body)).body.comparison;
  await pool.query(
    "UPDATE calls SET state='succeeded' WHERE id=ANY($1::uuid[])",
    [comparison.calls.map((call) => call.id)],
  );
  const votes = await Promise.all(
    comparison.calls.map((call) =>
      api(user, `comparisons/${comparison.id}/vote`, { callId: call.id }),
    ),
  );
  assert.equal(votes.filter((vote) => vote.status === 200).length, 1);
  assert.equal(votes.filter((vote) => vote.status === 409).length, 3);
  const winner = votes.find((vote) => vote.status === 200).body.comparison
    .votedCallId;
  const detail = (await api(user, `comparisons/${comparison.id}`)).body
    .comparison;
  assert.equal(detail.votedCallId, winner);
  assert.ok(detail.revealedAt);
  assert.ok(
    detail.calls.every(
      (call) => call.modelId && call.routeVersionId && call.family,
    ),
  );
});

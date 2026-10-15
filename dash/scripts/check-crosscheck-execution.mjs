import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import test, { before, beforeEach, afterEach, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  configuredKeyring,
  encryptText,
  decryptText,
} from '../server/core/encryption.ts';
import {
  generateSessionToken,
  hashToken,
  serializeSessionCookie,
} from '../server/auth/index.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import {
  parseChatInput,
  callRequestHash,
} from '../server/routes/call-contract.ts';
import { runNextCall } from '../server/routes/call-worker.ts';
import {
  creditVerifiedDeposit,
  getBalance,
  settleHold,
} from '../server/ledger/ledger.ts';
import { PpqError, PPQ_MODEL_ALLOWLIST } from '../server/ppq/index.ts';
import {
  saveProvidedSource,
  prepareOwnedCrossCheck,
  getOwnedCrossCheck,
} from '../server/crosscheck/store.ts';
import {
  quoteCrossCheck,
  enqueueCrossCheck,
  runCrossCheckSweep,
  crossCheckCapability,
  crossCheckExecutionStatus,
} from '../server/crosscheck/execution.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set CONCLAVE_TEST_DATABASE_URL to an isolated PostgreSQL test database.',
  );
const url = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('Tests require an isolated local test database.');
process.env.CONCLAVE_MODE = 'service';
process.env.CONCLAVE_APP_ORIGIN = 'https://conclave.test';
process.env.CONCLAVE_DATABASE_URL = connection;
process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
  test: randomBytes(32).toString('base64'),
});
process.env.CONCLAVE_ACTIVE_DATA_KEY = 'test';
process.env.PPQ_API_KEY = 'fixture-not-a-provider-key';
process.env.CONCLAVE_INFERENCE_ENABLED = 'true';
const keyring = configuredKeyring();
const pool = createDatabase(connection, 12);
const sourceText = 'The archive opens at 09:00. The archive closes at 17:00.';
const passage = 'The archive opens at 09:00.';
const families = ['gpt', 'claude', 'deepseek'];
let defaultRoster;

async function clearUndispatchedFixtures() {
  const pending =
    await pool.query(`SELECT c.id,c.account_id,c.hold_id FROM calls c JOIN holds h ON h.id=c.hold_id
    WHERE c.state='queued' AND h.state='held'`);
  for (const call of pending.rows) {
    await settleHold(pool, {
      accountId: call.account_id,
      holdId: call.hold_id,
      actualUsd6: '0',
      providerReference: null,
    });
    await pool.query(
      "UPDATE calls SET state='failed',error_code='FIXTURE_COMPLETE' WHERE id=$1",
      [call.id],
    );
    await pool.query(
      "UPDATE jobs SET state='dead' WHERE kind='inference' AND payload->>'callId'=$1 AND state='queued'",
      [call.id],
    );
  }
}
before(async () => {
  await migrate(pool);
  defaultRoster = await roster();
});
beforeEach(async () => {
  process.env.CONCLAVE_CROSSCHECK_ENABLED = 'true';
  await clearUndispatchedFixtures();
});
afterEach(clearUndispatchedFixtures);
after(async () => {
  await pool.end();
});

async function roster(options = {}) {
  const reviewers = [];
  for (const family of families) {
    const routeVersionId = randomUUID();
    await pool.query(
      `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
      VALUES($1,$2,1,$3,$4,'chat',true,$5,$6,now()+interval '2 days')`,
      [
        routeVersionId,
        randomUUID(),
        PPQ_MODEL_ALLOWLIST[family].id,
        family,
        {
          reviewed: true,
          level: 'UNVERIFIED',
          retentionDisclosure: 'Synthetic privacy disclosure.',
          evidenceUrl: 'https://example.test/terms',
          evidenceDate: '2026-10-09',
        },
        {
          inputPerMillionUsd6: '1000000',
          outputPerMillionUsd6: options.outputPrice ?? '1000000',
          markupBps: 0,
          maxOutputTokens: 8192,
          // Non-reasoning fixture route: balance thresholds below assume no reasoning reserve.
          maxReasoningTokens: 0,
          maxInputBytes: 32768,
        },
      ],
    );
    reviewers.push({
      routeVersionId,
      modelVersion: 'fixture-v1',
      distribution: family === 'deepseek' ? 'open-weight' : 'proprietary',
    });
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO crosscheck_rosters(id,label,version,reviewers,reviewed_at,expires_at,enabled)
    VALUES($1,'Synthetic execution roster',1,$2,now(),now()+interval '1 day',true)`,
    [id, JSON.stringify(reviewers)],
  );
  return { id, reviewers };
}
async function fixture(options = {}) {
  const accountId = randomUUID(),
    projectId = randomUUID(),
    token = generateSessionToken();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Review execution fixture')",
    [projectId, accountId],
  );
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), accountId],
  );
  const source = await saveProvidedSource(
    pool,
    {
      accountId,
      projectId,
      title: 'Source fixture',
      text: options.sourceText ?? sourceText,
    },
    keyring,
  );
  const prepared = await prepareOwnedCrossCheck(
    pool,
    {
      accountId,
      projectId,
      rosterId: options.rosterId ?? defaultRoster.id,
      sourceIds: [source.id],
      claims: Array.from({ length: options.claimCount ?? 1 }, (_, index) => ({
        id: `claim-${index}`,
        text: passage,
      })),
    },
    keyring,
  );
  if (options.balance !== '0')
    await creditVerifiedDeposit(pool, {
      accountId,
      reference: `fixture_${randomUUID()}`,
      amountUsd6: options.balance ?? '10000000',
    });
  return {
    accountId,
    projectId,
    cookie: serializeSessionCookie(token),
    source,
    runId: prepared.crosscheck.id,
  };
}
async function api(f, path, body, method = body ? 'POST' : 'GET') {
  return dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method,
      headers: {
        origin: 'https://conclave.test',
        ...(f ? { cookie: f.cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
async function quoted(f, maxOutputTokens = 1024) {
  return quoteCrossCheck(
    pool,
    { accountId: f.accountId, runId: f.runId, maxOutputTokens },
    keyring,
  );
}
function approval(f, quote) {
  return {
    accountId: f.accountId,
    runId: f.runId,
    quoteGroupId: quote.quoteGroupId,
    idempotencyKey: randomUUID(),
    approveMaximumUsd6: quote.maximumUsd6,
  };
}
async function queued(f) {
  const quote = await quoted(f);
  const input = approval(f, quote);
  return {
    quote,
    input,
    queued: await enqueueCrossCheck(pool, input, keyring),
  };
}
function provider(options = {}) {
  const seen = [];
  return {
    seen,
    async *chat(input) {
      seen.push(input);
      assert.equal(input.messages.length, 2);
      assert.equal(input.messages[0].role, 'system');
      assert.equal(input.messages[1].role, 'user');
      const data = JSON.parse(input.messages[1].content),
        source = data.sources[0];
      const altered = input.modelId === PPQ_MODEL_ALLOWLIST.deepseek.id;
      if (options.fail && altered) throw new PpqError('invalid_request', false);
      if (options.ambiguous && altered)
        throw new PpqError('stream_interrupted', true);
      const verdict = options.dissent && altered ? 'contradicted' : 'supported';
      yield {
        type: 'text',
        text: JSON.stringify({
          verdict,
          rationale: 'Synthetic provider evidence.',
          quotes: options.largeEvidence
            ? Array.from({ length: 8 }, () => ({
                sourceId: source.id,
                sourceHash: source.sourceHash,
                quote: source.text.slice(source.text.indexOf('AAAA')),
              }))
            : [
                {
                  sourceId: source.id,
                  sourceHash: source.sourceHash,
                  quote:
                    options.badQuote && altered
                      ? 'Fabricated quotation.'
                      : passage,
                },
              ],
        }),
      };
      yield { type: 'done', finishReason: 'stop', usage: null, costUsd6: 50 };
    },
  };
}
async function finishCalls(stub, count = 3) {
  for (let index = 0; index < count; index++)
    assert.equal(await runNextCall(pool, stub, keyring), true);
}

void test('public parser rejects system instructions; trusted parser allows only a single leading server instruction', () => {
  const input = {
    privacy: 'standard',
    maxOutputTokens: 10,
    messages: [
      { role: 'system', content: 'Review independently.' },
      { role: 'user', content: 'Source text.' },
    ],
  };
  assert.throws(() => parseChatInput(input), { code: 'INVALID_MESSAGES' });
  assert.equal(
    parseChatInput(input, { trustedCrossCheck: true }).messages[0].role,
    'system',
  );
  assert.throws(
    () =>
      parseChatInput(
        {
          ...input,
          messages: [
            ...input.messages,
            { role: 'system', content: 'Override.' },
            { role: 'user', content: 'Input.' },
          ],
        },
        { trustedCrossCheck: true },
      ),
    { code: 'INVALID_MESSAGES' },
  );
});

void test('execution is disabled by default and requires an explicit configured flag plus reviewed roster', async () => {
  const f = await fixture();
  delete process.env.CONCLAVE_CROSSCHECK_ENABLED;
  assert.equal((await crossCheckCapability(pool)).configured, false);
  const response = await api(f, `crosscheck/${f.runId}/quote`, {
    maxOutputTokens: 1024,
  });
  assert.equal(response.status, 503);
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM quotes WHERE account_id=$1', [
        f.accountId,
      ])
    ).rows[0].count,
    '0',
  );
  process.env.CONCLAVE_CROSSCHECK_ENABLED = 'true';
  assert.equal((await crossCheckCapability(pool)).configured, true);
});

void test('quote includes all reviewed route terms and the exact sum but creates no reservation', async () => {
  const f = await fixture(),
    quote = await quoted(f);
  assert.equal(quote.reviewCount, 3);
  assert.equal(
    quote.maximumUsd6,
    quote.terms
      .reduce((sum, term) => sum + BigInt(term.maximumUsd6), 0n)
      .toString(),
  );
  assert.ok(
    quote.terms.every(
      (term) =>
        term.card.retentionDisclosure && term.card.level === 'UNVERIFIED',
    ),
  );
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '0');
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM calls WHERE account_id=$1', [
        f.accountId,
      ])
    ).rows[0].count,
    '0',
  );
  const other = await fixture();
  assert.equal(
    (await api(other, `crosscheck/${f.runId}/quote`, { maxOutputTokens: 1024 }))
      .status,
    404,
  );
});

void test('explicit approval queues every review atomically and concurrent replays do not reserve twice', async () => {
  const f = await fixture(),
    quote = await quoted(f),
    input = approval(f, quote);
  await assert.rejects(
    enqueueCrossCheck(pool, { ...input, approveMaximumUsd6: '1' }, keyring),
    { code: 'CROSSCHECK_APPROVAL_MISMATCH' },
  );
  const [first, second] = await Promise.all([
    enqueueCrossCheck(pool, input, keyring),
    enqueueCrossCheck(pool, input, keyring),
  ]);
  assert.equal(first.id, second.id);
  assert.deepEqual(
    [first.replayed, second.replayed].sort((a, b) => Number(a) - Number(b)),
    [false, true],
  );
  assert.equal(
    (await getBalance(pool, f.accountId)).reservedUsd6,
    quote.maximumUsd6,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM calls WHERE account_id=$1', [
        f.accountId,
      ])
    ).rows[0].count,
    '3',
  );
  await assert.rejects(
    enqueueCrossCheck(
      pool,
      { ...input, idempotencyKey: randomUUID() },
      keyring,
    ),
    { code: 'CROSSCHECK_ALREADY_STARTED' },
  );
  await assert.rejects(
    enqueueCrossCheck(pool, { ...input, approveMaximumUsd6: '2' }, keyring),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

void test('insufficient funds roll back all holds, calls, jobs and execution records', async () => {
  const f = await fixture({ balance: '5000' }),
    quote = await quoted(f);
  assert.ok(
    BigInt(quote.terms[0].maximumUsd6) < 5000n &&
      BigInt(quote.maximumUsd6) > 5000n,
  );
  await assert.rejects(enqueueCrossCheck(pool, approval(f, quote), keyring), {
    code: 'INSUFFICIENT_BALANCE',
  });
  assert.deepEqual(await getBalance(pool, f.accountId), {
    availableUsd6: '5000',
    reservedUsd6: '0',
    currency: 'USD6',
  });
  for (const table of ['holds', 'calls', 'crosscheck_executions'])
    assert.equal(
      (
        await pool.query(`SELECT count(*) FROM ${table} WHERE account_id=$1`, [
          f.accountId,
        ])
      ).rows[0].count,
      '0',
    );
});

void test('input, group-call and total-budget limits fail before any child quote is persisted', async () => {
  const pricey = await roster({ outputPrice: '4000000000' });
  for (const [options, code] of [
    [{ sourceText: 'x'.repeat(32700) }, 'PROMPT_TOO_LARGE'],
    [{ claimCount: 9 }, 'CROSSCHECK_CALL_LIMIT'],
    [{ rosterId: pricey.id }, 'CROSSCHECK_BUDGET_LIMIT'],
  ]) {
    const f = await fixture(options);
    await assert.rejects(quoted(f), { code });
    assert.equal(
      (
        await pool.query('SELECT count(*) FROM quotes WHERE account_id=$1', [
          f.accountId,
        ])
      ).rows[0].count,
      '0',
    );
  }
});

void test('parallel accounts can quote the same roster without lock-upgrade deadlocks', async () => {
  const first = await fixture(),
    second = await fixture();
  const results = await Promise.all([quoted(first), quoted(second)]);
  assert.equal(results.length, 2);
});

void test('worker dispatch is independent, settles exact costs and durable sweep completes without browser involvement', async () => {
  const f = await fixture();
  await queued(f);
  const stub = provider();
  await finishCalls(stub);
  assert.equal(stub.seen.length, 3);
  assert.equal(new Set(stub.seen.map((input) => input.modelId)).size, 3);
  assert.equal(
    new Set(stub.seen.map((input) => JSON.stringify(input.messages))).size,
    1,
  );
  assert.equal(
    (await crossCheckExecutionStatus(pool, f.accountId, f.runId)).state,
    'awaiting_evaluation',
  );
  await runCrossCheckSweep(pool, keyring);
  const result = await getOwnedCrossCheck(pool, f.accountId, f.runId, keyring);
  assert.equal(result.result.verdict, 'HOLDS');
  assert.equal(
    (await crossCheckExecutionStatus(pool, f.accountId, f.runId)).state,
    'reviewed',
  );
  assert.deepEqual(await getBalance(pool, f.accountId), {
    availableUsd6: '9999850',
    reservedUsd6: '0',
    currency: 'USD6',
  });
  assert.equal(await runNextCall(pool, stub, keyring), false);
  await runCrossCheckSweep(pool, keyring);
  assert.equal(stub.seen.length, 3);
});

void test('dissent, fabricated quotes and a failed reviewer cannot be selected away by the sweep', async () => {
  for (const options of [
    { dissent: true },
    { badQuote: true },
    { fail: true },
  ]) {
    const f = await fixture();
    await queued(f);
    await finishCalls(provider(options));
    await runCrossCheckSweep(pool, keyring);
    const run = await getOwnedCrossCheck(pool, f.accountId, f.runId, keyring);
    assert.equal(run.result.verdict, 'NO_CONSENSUS');
    assert.equal(run.result.claims[0].reviews.length, 3);
  }
});

void test('cancellation before dispatch releases every hold without calling the provider', async () => {
  const f = await fixture();
  await queued(f);
  assert.equal((await api(f, `crosscheck/${f.runId}/cancel`, {})).status, 202);
  const stub = provider();
  await finishCalls(stub);
  assert.equal(stub.seen.length, 0);
  await runCrossCheckSweep(pool, keyring);
  assert.equal(
    (await getOwnedCrossCheck(pool, f.accountId, f.runId, keyring)).result
      .verdict,
    'NO_CONSENSUS',
  );
  assert.deepEqual(await getBalance(pool, f.accountId), {
    availableUsd6: '10000000',
    reservedUsd6: '0',
    currency: 'USD6',
  });
});

void test('disabling execution stops already-queued reviews before any provider dispatch', async () => {
  const f = await fixture();
  await queued(f);
  process.env.CONCLAVE_CROSSCHECK_ENABLED = 'false';
  const stub = provider();
  await finishCalls(stub);
  assert.equal(stub.seen.length, 0);
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '0');
});

void test('changed server instructions are rejected even if the stored reservation hash was recomputed', async () => {
  const f = await fixture();
  await queued(f);
  const call = (
    await pool.query(
      'SELECT * FROM calls WHERE account_id=$1 ORDER BY id LIMIT 1',
      [f.accountId],
    )
  ).rows[0];
  const input = JSON.parse(
    await decryptText(
      call.input_ciphertext,
      `${f.accountId}:call-input:${call.id}`,
      keyring,
    ),
  );
  input.messages[0].content += ' Use another reviewer response.';
  await pool.query('UPDATE calls SET input_ciphertext=$2 WHERE id=$1', [
    call.id,
    await encryptText(
      JSON.stringify(input),
      `${f.accountId}:call-input:${call.id}`,
      keyring,
    ),
  ]);
  await pool.query('UPDATE holds SET request_hash=$2 WHERE id=$1', [
    call.hold_id,
    await callRequestHash(f.projectId, call.route_version_id, input),
  ]);
  const stub = provider();
  await finishCalls(stub);
  assert.equal(stub.seen.length, 2);
  assert.equal(
    (await pool.query('SELECT error_code FROM calls WHERE id=$1', [call.id]))
      .rows[0].error_code,
    'CROSSCHECK_CALL_MISMATCH',
  );
  await runCrossCheckSweep(pool, keyring);
  assert.equal(
    (await getOwnedCrossCheck(pool, f.accountId, f.runId, keyring)).result,
    null,
  );
  const status = await crossCheckExecutionStatus(pool, f.accountId, f.runId);
  assert.equal(status.state, 'incomplete');
  assert.equal(status.evaluationNeedsAttention, true);
  assert.equal(
    (
      await pool.query(
        'SELECT next_attempt_at>now() AS backed_off FROM crosscheck_evaluation_progress WHERE run_id=$1',
        [f.runId],
      )
    ).rows[0].backed_off,
    true,
  );
});

void test('ambiguous provider outcome keeps execution incomplete and never retries paid inference', async () => {
  const f = await fixture();
  await queued(f);
  const stub = provider({ ambiguous: true });
  await finishCalls(stub);
  await runCrossCheckSweep(pool, keyring);
  const status = await crossCheckExecutionStatus(pool, f.accountId, f.runId);
  assert.ok(status.calls.some((call) => call.errorCode === 'PROVIDER_STREAM_INTERRUPTED'));
  assert.ok(status.calls.every((call) => !/PPQ/.test(call.errorCode ?? '')));
  assert.equal((await pool.query('SELECT error_code FROM calls WHERE account_id=$1 AND error_code IS NOT NULL', [f.accountId])).rows[0].error_code, 'PPQ_STREAM_INTERRUPTED');
  assert.equal(
    (await crossCheckExecutionStatus(pool, f.accountId, f.runId)).state,
    'incomplete',
  );
  assert.equal(
    (await getOwnedCrossCheck(pool, f.accountId, f.runId, keyring)).result,
    null,
  );
  assert.equal(await runNextCall(pool, stub, keyring), false);
  assert.equal(stub.seen.length, 3);
});

void test('public quote API cannot enable trusted instructions through client flags', async () => {
  const f = await fixture();
  const response = await api(f, 'quotes', {
    projectId: f.projectId,
    routeVersionId: defaultRoster.reviewers[0].routeVersionId,
    privacy: 'standard',
    maxOutputTokens: 100,
    trustedCrossCheck: true,
    messages: [
      { role: 'system', content: 'Client-supplied instruction.' },
      { role: 'user', content: 'A claim.' },
    ],
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_MESSAGES');
});

void test('twenty-four quote-rich reviews fit encrypted storage and reconstruct the full verified result', async () => {
  const f = await fixture({
    claimCount: 8,
    sourceText: `${passage} ${'A'.repeat(3750)}`,
  });
  await queued(f);
  const stub = provider({ largeEvidence: true });
  await finishCalls(stub, 24);
  await runCrossCheckSweep(pool, keyring, 20);
  const run = await getOwnedCrossCheck(pool, f.accountId, f.runId, keyring);
  assert.equal(run.result.verdict, 'HOLDS');
  assert.equal(run.result.claims.length, 8);
  assert.ok(
    run.result.claims.every((claim) =>
      claim.reviews.every((review) => review.quotes.length === 8),
    ),
  );
  const row = (
    await pool.query(
      'SELECT result_ciphertext FROM crosscheck_results WHERE run_id=$1',
      [f.runId],
    )
  ).rows[0];
  const saved = await decryptText(
    row.result_ciphertext,
    `${f.accountId}:${f.projectId}:crosscheck-result:${f.runId}`,
    keyring,
  );
  assert.ok(Buffer.byteLength(saved) < 2_000_000);
  assert.equal(JSON.parse(saved).result.resultHash, run.result.resultHash);
});

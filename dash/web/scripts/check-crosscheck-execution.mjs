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
import { GatewayError, GATEWAY_MODEL_ALLOWLIST } from '../server/gateway/index.ts';
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
process.env.GATEWAY_API_KEY = 'fixture-not-a-provider-key';
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
        GATEWAY_MODEL_ALLOWLIST[family].id,
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
      const altered = input.modelId === GATEWAY_MODEL_ALLOWLIST.deepseek.id;
      if (options.fail && altered) throw new GatewayError('invalid_request', false);
      if (options.ambiguous && altered)
        throw new GatewayError('stream_interrupted', true);
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

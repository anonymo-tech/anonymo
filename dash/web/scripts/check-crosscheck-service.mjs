import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { configuredKeyring, encryptText } from '../server/core/encryption.ts';
import { digestText } from '../server/core/digest.ts';
import { handleApi, assertSameOrigin } from '../server/core/http.ts';
import { ServiceError } from '../server/core/errors.ts';
import {
  generateSessionToken,
  hashToken,
  serializeSessionCookie,
} from '../server/auth/index.ts';
import { getSession } from '../server/routes/session.ts';
import { crosscheckRoutes } from '../server/routes/crosscheck.ts';
import {
  saveProvidedSource,
  prepareOwnedCrossCheck,
  getOwnedCrossCheck,
  getProvidedSource,
  plannedReviewCalls,
  completeCrossCheckFromCalls,
  listReviewerRosters,
  CROSSCHECK_STORAGE_LIMITS,
} from '../server/crosscheck/store.ts';
import { CROSSCHECK_TTL_MS } from '../server/crosscheck/index.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set CONCLAVE_TEST_DATABASE_URL to an isolated PostgreSQL test database.',
  );
const databaseUrl = new URL(connection);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) ||
  !databaseUrl.pathname.endsWith('_test')
)
  throw new Error('Tests require an isolated local test database.');
process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
  test: randomBytes(32).toString('base64'),
});
process.env.CONCLAVE_ACTIVE_DATA_KEY = 'test';
const keyring = configuredKeyring();
const pool = createDatabase(connection, 8);
const origin = 'https://conclave.test';
const sourceText = 'The archive opens at 09:00. The archive closes at 17:00.';
const quote = 'The archive opens at 09:00.';
let defaultRoster;
before(async () => {
  await migrate(pool);
  defaultRoster = await seedRoster();
});
after(async () => {
  await pool.end();
});

async function seedRoster({
  families = ['family-a', 'family-b', 'family-c'],
  distributions = ['proprietary', 'proprietary', 'open-weight'],
  reviewed = true,
  expiresAt = new Date(Date.now() + 3 * CROSSCHECK_TTL_MS),
  enabled = true,
} = {}) {
  const reviewers = [];
  for (const [index, family] of families.entries()) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
      VALUES($1,$2,1,$3,$4,'chat',true,$5,$6,$7)`,
      [
        id,
        randomUUID(),
        `fixture-${index}/model`,
        family,
        {
          reviewed,
          level: 'UNVERIFIED',
          retentionDisclosure: 'Synthetic route fixture.',
          evidenceUrl: 'https://example.test/terms',
          evidenceDate: '2026-10-09',
        },
        {
          inputPerMillionUsd6: '1',
          outputPerMillionUsd6: '1',
          markupBps: 0,
          maxOutputTokens: 2048,
          maxInputBytes: 32768,
        },
        expiresAt,
      ],
    );
    reviewers.push({
      routeVersionId: id,
      modelVersion: 'fixture-v1',
      distribution: distributions[index],
    });
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO crosscheck_rosters(id,label,version,reviewers,reviewed_at,expires_at,enabled)
    VALUES($1,'Synthetic reviewer roster',1,$2,$3,$4,$5)`,
    [
      id,
      JSON.stringify(reviewers),
      new Date(Date.now() - CROSSCHECK_TTL_MS),
      expiresAt,
      enabled,
    ],
  );
  return { id, reviewers };
}

async function owner() {
  const accountId = randomUUID(),
    projectId = randomUUID(),
    token = generateSessionToken();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Cross-Check fixture')",
    [projectId, accountId],
  );
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), accountId],
  );
  return { accountId, projectId, cookie: serializeSessionCookie(token) };
}
async function api(
  user,
  path,
  { method = 'GET', body, requestOrigin = origin } = {},
) {
  const request = new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      origin: requestOrigin,
      ...(user ? { cookie: user.cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Match dispatch's authentication/origin contract without modifying dispatch.
  return handleApi(async () => {
    if (!['GET', 'HEAD'].includes(method)) assertSameOrigin(request, origin);
    const session = await getSession(pool, request);
    const response = await crosscheckRoutes(
      pool,
      request,
      path.split('?')[0],
      session.accountId,
    );
    if (!response) throw new ServiceError(404, 'NOT_FOUND', 'Not found.');
    return response;
  });
}
async function fixture(options = {}) {
  const user = await owner();
  const source = await saveProvidedSource(
    pool,
    {
      ...user,
      title: 'Archive hours',
      text: sourceText,
      uri: 'https://archive.example/hours',
    },
    keyring,
  );
  const input = {
    accountId: user.accountId,
    projectId: user.projectId,
    rosterId: options.rosterId ?? defaultRoster.id,
    sourceIds: [source.id],
    claims: [{ id: 'opening', text: quote }],
  };
  const prepared = await prepareOwnedCrossCheck(pool, input, keyring);
  return { ...user, input, source, run: prepared.crosscheck };
}
function review(source, verdict = 'supported', passage = quote) {
  return JSON.stringify({
    verdict,
    rationale: 'Synthetic evidence review.',
    quotes: [
      { sourceId: source.id, sourceHash: source.snapshotHash, quote: passage },
    ],
  });
}
async function persistedCalls(f, options = {}) {
  const requests = await plannedReviewCalls(
    pool,
    f.accountId,
    f.run.id,
    keyring,
  );
  const calls = [];
  for (const [index, request] of requests.entries()) {
    const id = randomUUID(),
      quoteId = randomUUID(),
      holdId = randomUUID();
    const input = {
      messages: structuredClone(request.messages),
      maxOutputTokens: 1024,
      privacy: 'standard',
    };
    if (options.alterInput && index === 0)
      input.messages[0].content += ' Changed instructions.';
    const accountId = options.owner?.accountId ?? f.accountId,
      projectId = options.owner?.projectId ?? f.projectId;
    const routeVersionId =
      options.wrongRoute && index === 0
        ? // Requests are UUID-sorted; seed-array positions need not differ.
          requests[1].routeVersionId
        : request.routeVersionId;
    if (options.wrongRoute && index === 0)
      assert.notEqual(routeVersionId, request.routeVersionId);
    const requestHash = await digestText(
      'call',
      JSON.stringify({ projectId, routeVersionId, ...input }),
    );
    const state =
      options.failed && index === 0
        ? 'failed'
        : options.pending && index === 0
          ? 'running'
          : 'succeeded';
    const content = options.content?.(index) ?? review(f.source);
    await pool.query(
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
      VALUES($1,$2,$3,$4,$5,1,1024,now()+interval '1 minute')`,
      [quoteId, accountId, projectId, routeVersionId, requestHash],
    );
    await pool.query(
      `INSERT INTO holds(id,account_id,quote_id,idempotency_key,request_hash,maximum_usd6,captured_usd6,state)
      VALUES($1,$2,$3,$4,$5,1,1,$6)`,
      [
        holdId,
        accountId,
        quoteId,
        randomUUID(),
        requestHash,
        state === 'running' ? 'running' : 'captured',
      ],
    );
    await pool.query(
      `INSERT INTO calls(id,account_id,project_id,hold_id,route_version_id,input_ciphertext,output_ciphertext,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        accountId,
        projectId,
        holdId,
        routeVersionId,
        await encryptText(
          JSON.stringify(input),
          `${accountId}:call-input:${id}`,
          keyring,
        ),
        await encryptText(content, `${accountId}:call-output:${id}`, keyring),
        state,
      ],
    );
    calls.push({
      callId: id,
      claimId: request.claimId,
      reviewerId: request.reviewerId,
    });
  }
  return calls;
}
const complete = (f, calls, now) =>
  completeCrossCheckFromCalls(
    pool,
    { accountId: f.accountId, runId: f.run.id, calls },
    keyring,
    now,
  );

void test('source creation and preparation are authenticated, origin checked, encrypted, and explicitly not reviewed', async () => {
  const user = await owner();
  const body = {
    projectId: user.projectId.toUpperCase(),
    title: 'Exact source',
    text: `\n${sourceText}\t`,
    uri: 'http://127.0.0.1/not-fetched',
  };
  assert.equal(
    (await api(null, 'crosscheck/sources', { method: 'POST', body })).status,
    401,
  );
  assert.equal(
    (
      await api(user, 'crosscheck/sources', {
        method: 'POST',
        body,
        requestOrigin: 'https://other.test',
      })
    ).status,
    403,
  );
  const response = await api(user, 'crosscheck/sources', {
    method: 'POST',
    body,
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { source, execution } = await response.json();
  assert.equal(source.text, body.text);
  assert.equal(source.acquisition, 'provided-text');
  assert.equal(execution.enabled, false);
  const prepared = await api(user, 'crosscheck', {
    method: 'POST',
    body: {
      projectId: user.projectId,
      rosterId: defaultRoster.id,
      sourceIds: [source.id],
      claims: [{ id: 'opening', text: quote }],
    },
  });
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { crosscheck } = await prepared.json();
  assert.equal(crosscheck.status, 'prepared');
  assert.equal(crosscheck.result, null);
  assert.equal(crosscheck.cacheUsable, false);
  assert.match(crosscheck.label, /not reviewed/);
  const stored = (
    await pool.query(
      'SELECT snapshot_ciphertext FROM crosscheck_sources WHERE id=$1',
      [source.id],
    )
  ).rows[0];
  assert.ok(!stored.snapshot_ciphertext.includes(sourceText));
  const encrypted = (
    await pool.query(
      'SELECT plan_ciphertext FROM crosscheck_runs WHERE id=$1',
      [crosscheck.id],
    )
  ).rows[0];
  assert.ok(!encrypted.plan_ciphertext.includes(quote));
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM calls WHERE account_id=$1', [
        user.accountId,
      ])
    ).rows[0].count,
    '0',
  );
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM holds WHERE account_id=$1', [
        user.accountId,
      ])
    ).rows[0].count,
    '0',
  );
});

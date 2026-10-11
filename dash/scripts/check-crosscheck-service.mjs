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

void test('source and run IDs cannot cross owners, projects, archived projects or disabled accounts', async () => {
  const f = await fixture(),
    other = await owner();
  for (const path of [
    `crosscheck/sources/${f.source.id}`,
    `crosscheck/${f.run.id}`,
    `crosscheck?projectId=${f.projectId}`,
  ])
    assert.equal((await api(other, path)).status, 404);
  await assert.rejects(
    prepareOwnedCrossCheck(
      pool,
      { ...f.input, accountId: other.accountId, projectId: other.projectId },
      keyring,
    ),
    { code: 'CROSSCHECK_SOURCE_NOT_FOUND' },
  );
  const secondProject = randomUUID();
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Second project')",
    [secondProject, f.accountId],
  );
  await assert.rejects(
    prepareOwnedCrossCheck(
      pool,
      { ...f.input, projectId: secondProject },
      keyring,
    ),
    { code: 'CROSSCHECK_SOURCE_NOT_FOUND' },
  );
  await pool.query('UPDATE projects SET archived_at=now() WHERE id=$1', [
    f.projectId,
  ]);
  assert.equal((await api(f, `crosscheck/${f.run.id}`)).status, 404);
  assert.equal((await api(f, `crosscheck/sources/${f.source.id}`)).status, 404);
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    other.accountId,
  ]);
  assert.equal((await api(other, 'crosscheck/rosters')).status, 401);
});

void test('clients cannot upload reviewer output, set result state or administer rosters', async () => {
  const f = await fixture();
  for (const path of [
    `crosscheck/${f.run.id}/reviews`,
    `crosscheck/${f.run.id}/complete`,
    'crosscheck/rosters',
  ])
    assert.equal(
      (
        await api(f, path, {
          method: 'POST',
          body: { result: 'HOLDS', reviews: [] },
        })
      ).status,
      404,
    );
  const { accountId: _accountId, ...body } = f.input;
  for (const added of [
    { reviewers: [] },
    { result: 'HOLDS' },
    { status: 'reviewed' },
  ])
    assert.equal(
      (
        await api(f, 'crosscheck', {
          method: 'POST',
          body: { ...body, ...added },
        })
      ).status,
      400,
    );
  assert.equal(
    (await getOwnedCrossCheck(pool, f.accountId, f.run.id, keyring)).result,
    null,
  );
});

void test('server-approved rosters exclude duplicate families, unreviewed, expired, disabled and unmixed entries', async () => {
  for (const options of [
    { families: ['family-a', 'family-a', 'family-c'] },
    { reviewed: false },
    { enabled: false },
    { expiresAt: new Date(Date.now() - 1000) },
    { distributions: ['proprietary', 'proprietary', 'proprietary'] },
  ]) {
    const invalid = await seedRoster(options),
      user = await owner();
    const source = await saveProvidedSource(
      pool,
      { ...user, title: 'Source', text: sourceText },
      keyring,
    );
    await assert.rejects(
      prepareOwnedCrossCheck(
        pool,
        {
          ...user,
          rosterId: invalid.id,
          sourceIds: [source.id],
          claims: [{ id: 'claim', text: quote }],
        },
        keyring,
      ),
      { code: 'CROSSCHECK_ROSTER_UNAVAILABLE' },
    );
    assert.ok(
      !(await listReviewerRosters(pool)).some(
        (roster) => roster.id === invalid.id,
      ),
    );
  }
});

void test('disabled route blocks planning and the worker dispatch seam immediately', async () => {
  const configured = await seedRoster(),
    f = await fixture({ rosterId: configured.id });
  await pool.query('UPDATE route_versions SET enabled=false WHERE id=$1', [
    configured.reviewers[0].routeVersionId,
  ]);
  await assert.rejects(prepareOwnedCrossCheck(pool, f.input, keyring), {
    code: 'CROSSCHECK_ROSTER_UNAVAILABLE',
  });
  await assert.rejects(
    plannedReviewCalls(pool, f.accountId, f.run.id, keyring),
    { code: 'CROSSCHECK_ROSTER_UNAVAILABLE' },
  );
});

void test('source byte limits, claim counts, unknown fields and source URI schemes are bounded', async () => {
  const f = await fixture();
  for (const body of [
    { projectId: f.projectId, title: 'Large', text: 'é'.repeat(32769) },
    {
      projectId: f.projectId,
      title: 'Unsupported',
      text: sourceText,
      uri: 'file:///private/source',
    },
    {
      projectId: f.projectId,
      title: 'Unsupported',
      text: sourceText,
      visibility: 'public',
    },
  ])
    assert.equal(
      (await api(f, 'crosscheck/sources', { method: 'POST', body })).status,
      400,
    );
  const { accountId: _accountId, ...body } = f.input;
  assert.equal(
    (
      await api(f, 'crosscheck', {
        method: 'POST',
        body: {
          ...body,
          claims: Array.from({ length: 25 }, (_, id) => ({
            id: `c${id}`,
            text: quote,
          })),
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api(f, 'crosscheck', {
        method: 'POST',
        body: { ...body, sourceIds: Array(9).fill(f.source.id) },
      })
    ).status,
    400,
  );
});

void test('preparation deduplicates concurrent identical requests without marking them reviewed', async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      prepareOwnedCrossCheck(pool, f.input, keyring),
    ),
  );
  assert.ok(
    results.every(
      (result) =>
        result.reused &&
        !result.cacheHit &&
        result.crosscheck.id === f.run.id &&
        result.crosscheck.status === 'prepared',
    ),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM crosscheck_runs WHERE account_id=$1',
        [f.accountId],
      )
    ).rows[0].count,
    '1',
  );
});

void test('prepared review messages are identical per claim, omit peer answers, and remain worker-only', async () => {
  const f = await fixture();
  const requests = await plannedReviewCalls(
    pool,
    f.accountId,
    f.run.id,
    keyring,
  );
  assert.equal(requests.length, 3);
  assert.ok(
    requests.every(
      (request) =>
        JSON.stringify(request.messages) ===
        JSON.stringify(requests[0].messages),
    ),
  );
  assert.match(requests[0].messages[0].content, /untrusted data/);
  assert.ok(!JSON.stringify(requests).includes(f.accountId));
  assert.equal((await api(f, `crosscheck/${f.run.id}/requests`)).status, 404);
});

void test('worker completion accepts only exact independent persisted calls and creates encrypted verifiable results', async () => {
  const f = await fixture(),
    calls = await persistedCalls(f);
  const result = await complete(f, calls);
  assert.equal(result.status, 'reviewed');
  assert.equal(result.result.verdict, 'HOLDS');
  assert.equal(result.cacheUsable, true);
  assert.equal(
    (await complete(f, calls)).result.resultHash,
    result.result.resultHash,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM crosscheck_review_calls WHERE run_id=$1',
        [f.run.id],
      )
    ).rows[0].count,
    '3',
  );
  const stored = (
    await pool.query(
      'SELECT result_ciphertext FROM crosscheck_results WHERE run_id=$1',
      [f.run.id],
    )
  ).rows[0];
  assert.ok(!stored.result_ciphertext.includes(quote));
  const read = await api(f, `crosscheck/${f.run.id}`);
  assert.equal(
    (await read.json()).crosscheck.result.resultHash,
    result.result.resultHash,
  );
  const cached = await prepareOwnedCrossCheck(pool, f.input, keyring);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.crosscheck.id, f.run.id);
});

void test('fabricated quotes and one dissent remain NO_CONSENSUS after persistence and reload', async () => {
  for (const alteration of ['quote', 'dissent', 'failed', 'oversized']) {
    const f = await fixture();
    const calls = await persistedCalls(f, {
      failed: alteration === 'failed',
      content: (index) =>
        index === 0 && alteration === 'oversized'
          ? 'x'.repeat(32769)
          : review(
              f.source,
              index === 0 && alteration === 'dissent'
                ? 'contradicted'
                : 'supported',
              index === 0 && alteration === 'quote'
                ? 'Invented source text.'
                : quote,
            ),
    });
    const result = await complete(f, calls);
    assert.equal(result.result.verdict, 'NO_CONSENSUS');
    assert.equal(
      (await getOwnedCrossCheck(pool, f.accountId, f.run.id, keyring)).result
        .verdict,
      'NO_CONSENSUS',
    );
  }
});

void test('mismatched owner, route, instructions, pending state, missing or duplicate calls fail atomically', async () => {
  for (const alteration of [
    'owner',
    'route',
    'instructions',
    'pending',
    'missing',
    'duplicate',
  ]) {
    const f = await fixture();
    let calls = await persistedCalls(f, {
      owner: alteration === 'owner' ? await owner() : undefined,
      wrongRoute: alteration === 'route',
      alterInput: alteration === 'instructions',
      pending: alteration === 'pending',
    });
    if (alteration === 'missing') calls = calls.slice(1);
    if (alteration === 'duplicate') calls = [calls[0], calls[0], calls[2]];
    await assert.rejects(complete(f, calls), (error) =>
      ['CROSSCHECK_CALL_MISMATCH', 'CROSSCHECK_CALL_PENDING'].includes(
        error.code,
      ),
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM crosscheck_results WHERE run_id=$1',
          [f.run.id],
        )
      ).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM crosscheck_review_calls WHERE run_id=$1',
          [f.run.id],
        )
      ).rows[0].count,
      '0',
    );
  }
});

void test('cache expires exactly at twenty-four hours and new claims or snapshots cannot reuse results', async () => {
  const f = await fixture(),
    calls = await persistedCalls(f);
  await complete(f, calls);
  const expires = f.run.plan.cache.expiresAtMs;
  assert.equal(
    (
      await getOwnedCrossCheck(
        pool,
        f.accountId,
        f.run.id,
        keyring,
        expires - 1,
      )
    ).cacheUsable,
    true,
  );
  assert.equal(
    (await getOwnedCrossCheck(pool, f.accountId, f.run.id, keyring, expires))
      .cacheUsable,
    false,
  );
  const expired = await prepareOwnedCrossCheck(pool, f.input, keyring, expires);
  assert.equal(expired.cacheHit, false);
  assert.notEqual(expired.crosscheck.id, f.run.id);
  const edited = await prepareOwnedCrossCheck(
    pool,
    {
      ...f.input,
      claims: [{ id: 'opening', text: 'The archive closes at 17:00.' }],
    },
    keyring,
  );
  assert.equal(edited.cacheHit, false);
  const newSource = await saveProvidedSource(
    pool,
    { ...f, title: 'Updated source', text: 'The archive now opens at 10:00.' },
    keyring,
  );
  assert.equal(
    (
      await prepareOwnedCrossCheck(
        pool,
        { ...f.input, sourceIds: [newSource.id] },
        keyring,
      )
    ).cacheHit,
    false,
  );
});

void test('copied encrypted source data cannot be decrypted under another snapshot identity', async () => {
  const f = await fixture(),
    copiedId = randomUUID();
  await pool.query(
    `INSERT INTO crosscheck_sources(id,account_id,project_id,snapshot_hash,snapshot_ciphertext,source_bytes,captured_at)
    SELECT $1,account_id,project_id,snapshot_hash,snapshot_ciphertext,source_bytes,captured_at FROM crosscheck_sources WHERE id=$2`,
    [copiedId, f.source.id],
  );
  await assert.rejects(
    getProvidedSource(pool, f.accountId, copiedId, keyring),
    { code: 'CROSSCHECK_CONTENT_UNAVAILABLE' },
  );
  const wrongKeys = {
    active: 'test',
    keys: { test: randomBytes(32).toString('base64') },
  };
  await assert.rejects(
    getOwnedCrossCheck(pool, f.accountId, f.run.id, wrongKeys),
    { code: 'CROSSCHECK_CONTENT_UNAVAILABLE' },
  );
});

void test('database guards prevent source/run/result/roster rewriting and cross-owner inserts', async () => {
  const f = await fixture(),
    other = await owner(),
    calls = await persistedCalls(f);
  await complete(f, calls);
  for (const statement of [
    ['UPDATE crosscheck_sources SET source_bytes=1 WHERE id=$1', f.source.id],
    ['DELETE FROM crosscheck_runs WHERE id=$1', f.run.id],
    [
      'UPDATE crosscheck_results SET finished_at=now() WHERE run_id=$1',
      f.run.id,
    ],
    [
      "UPDATE crosscheck_rosters SET label='Changed' WHERE id=$1",
      defaultRoster.id,
    ],
  ])
    await assert.rejects(pool.query(statement[0], [statement[1]]), {
      code: '23514',
    });
  await assert.rejects(
    pool.query(
      `INSERT INTO crosscheck_sources(id,account_id,project_id,snapshot_hash,snapshot_ciphertext,source_bytes,captured_at)
    SELECT $1,$2,project_id,snapshot_hash,snapshot_ciphertext,source_bytes,captured_at FROM crosscheck_sources WHERE id=$3`,
      [randomUUID(), other.accountId, f.source.id],
    ),
    { code: '23514' },
  );
});

void test('project snapshot quota is serialized and rejects further storage', async () => {
  const f = await fixture();
  await pool.query(
    `INSERT INTO crosscheck_sources(id,account_id,project_id,snapshot_hash,snapshot_ciphertext,source_bytes,captured_at)
    SELECT gen_random_uuid(),s.account_id,s.project_id,s.snapshot_hash,s.snapshot_ciphertext,s.source_bytes,s.captured_at
    FROM crosscheck_sources s CROSS JOIN generate_series(1,$2) WHERE s.id=$1`,
    [f.source.id, CROSSCHECK_STORAGE_LIMITS.sourcesPerProject - 1],
  );
  await assert.rejects(
    saveProvidedSource(
      pool,
      { ...f, title: 'Too many', text: sourceText },
      keyring,
    ),
    { code: 'CROSSCHECK_STORAGE_LIMIT' },
  );
});

void test('prepare rate limits are durable and list pagination stays owned', async () => {
  const f = await fixture();
  const { accountId: _accountId, ...body } = f.input;
  for (let count = 0; count < 10; count++)
    assert.equal(
      (await api(f, 'crosscheck', { method: 'POST', body })).status,
      200,
    );
  assert.equal(
    (await api(f, 'crosscheck', { method: 'POST', body })).status,
    429,
  );
  const listing = await api(f, `crosscheck?projectId=${f.projectId}`);
  assert.equal(listing.status, 200);
  assert.equal((await listing.json()).crosschecks[0].id, f.run.id);
  const sourceListing = await api(
    f,
    `crosscheck/sources?projectId=${f.projectId}`,
  );
  const listed = (await sourceListing.json()).sources[0];
  assert.equal(listed.id, f.source.id);
  assert.equal(listed.text, undefined);
});

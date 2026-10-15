import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { autoRoutingRoutes } from '../server/routes/auto-routing.ts';
import {
  validateRouteReview,
  validateRouteRoutingProfile,
} from '../server/routes/route-registry.ts';
import { quoteMaximum } from '../server/routes/call-contract.ts';
import { creditVerifiedDeposit, getBalance } from '../server/ledger/ledger.ts';
import { dispatch } from '../server/routes/dispatch.ts';

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
const pool = createDatabase(connection, 12);
before(() => migrate(pool));
after(() => pool.end());
const code = (value) => (error) => error.code === value;
const profile = (
  tasks = ['general', 'code', 'reasoning', 'writing', 'long_context'],
) => ({
  version: 1,
  tasks,
  evidenceUrl: 'https://platform.openai.com/docs/models',
  reviewedAt: new Date().toISOString(),
});
async function fixture() {
  const accountId = randomUUID(),
    projectId = randomUUID(),
    token = generateSessionToken();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), accountId],
  );
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Synthetic routing project')",
    [projectId, accountId],
  );
  await creditVerifiedDeposit(pool, {
    accountId,
    reference: `fixture_${randomUUID()}`,
    amountUsd6: '10000000',
  });
  return { accountId, projectId, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}
async function route(options = {}) {
  const id = options.id ?? randomUUID(),
    routeId = options.routeId ?? `fixture-${randomUUID()}`,
    version = options.version ?? 1,
    expiresAt =
      options.expiresAt ?? new Date(Date.now() + 3600000).toISOString();
  const card = {
    reviewed: true,
    retentionDisclosure: 'Synthetic reviewed route terms.',
    evidenceUrl: 'https://ppq.ai/privacy',
    evidenceDate: new Date().toISOString().slice(0, 10),
    ...(options.routing === null
      ? {}
      : { routing: options.routing ?? profile() }),
  };
  const pricing = {
    inputPerMillionUsd6: options.input ?? '1000000',
    outputPerMillionUsd6: options.output ?? '1000000',
    markupBps: options.markup ?? 0,
    maxInputBytes: options.maxInputBytes ?? 32768,
    maxOutputTokens: options.maxOutputTokens ?? 8192,
    // Non-reasoning fixture routes: exact amounts assume no reasoning reserve.
    maxReasoningTokens: options.maxReasoningTokens ?? 0,
  };
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) VALUES($1,$2,$3,$4,'gpt','chat',$5,$6,$7,$8)`,
    [
      id,
      routeId,
      version,
      options.modelId ?? 'gpt-6.1-sol',
      options.enabled ?? true,
      card,
      pricing,
      expiresAt,
    ],
  );
  return { id, routeId, version, expiresAt, card, pricing };
}
const candidate = (
  r,
  messages = [{ role: 'user', content: 'Explain this algorithm.' }],
  maxOutputTokens = 2048,
) => ({ routeVersionId: r.id, messages, maxOutputTokens, privacy: 'standard' });
const body = (f, candidates, extra = {}) => ({
  projectId: f.projectId,
  task: 'code',
  privacy: 'standard',
  budgetUsd6: '10000000',
  candidates,
  ...extra,
});
async function recommend(f, input, provider = true) {
  const response = await autoRoutingRoutes(
    pool,
    new Request('https://conclave.test/api/auto-route-quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'auto-route-quotes',
    f.accountId,
    provider,
  );
  return { status: response.status, body: await response.json() };
}
async function api(
  f,
  path,
  input,
  method = input === undefined ? 'GET' : 'POST',
) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method,
      headers: {
        origin: 'https://conclave.test',
        cookie: f.cookie,
        'content-type': 'application/json',
        'X-Conclave-Account-Id': f.accountId,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}
async function count(table, f) {
  return (
    await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE account_id=$1`,
      [f.accountId],
    )
  ).rows[0].n;
}
function reviewFixture() {
  const now = new Date().toISOString();
  return {
    version: 1,
    routes: [
      {
        id: randomUUID(),
        routeId: `fixture-${randomUUID()}`,
        version: 1,
        modelId: 'gpt-6.1-sol',
        family: 'gpt',
        modality: 'chat',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        card: {
          level: 'unverified',
          reviewed: true,
          provider: 'ppq',
          upstreamProviders: ['Synthetic upstream'],
          plaintextVisibility: 'gateway_and_upstream',
          retentionDays: null,
          trainingUse: 'unknown',
          jurisdiction: null,
          legalHold: 'unknown',
          retentionDisclosure:
            'The gateway and upstream can read plaintext; retention is unverified.',
          evidenceUrl: 'https://ppq.ai/privacy',
          upstreamEvidenceUrls: [],
          evidenceDate: now.slice(0, 10),
          lastVerifiedAt: now,
          routing: profile(),
        },
        pricing: {
          inputPerMillionUsd6: '1000000',
          outputPerMillionUsd6: '1000000',
          markupBps: 0,
          maxInputBytes: 32768,
          maxOutputTokens: 8192,
          maxReasoningTokens: 0,
        },
      },
    ],
  };
}

void test('operator task profiles are optional immutable review metadata with bounded official evidence', () => {
  const document = reviewFixture();
  assert.deepEqual(
    validateRouteReview(document)[0].card.routing,
    document.routes[0].card.routing,
  );
  delete document.routes[0].card.routing;
  assert.equal(validateRouteReview(document)[0].card.routing, undefined);
  for (const change of [
    (p) => (p.tasks = ['vision']),
    (p) => (p.tasks = ['code', 'code']),
    (p) => (p.evidenceUrl = 'https://unreviewed.example/tasks'),
    (p) => (p.reviewedAt = new Date(Date.now() + 60000).toISOString()),
    (p) => (p.reviewedAt = new Date(Date.now() - 86400001).toISOString()),
    (p) => (p.extra = true),
  ]) {
    const d = reviewFixture();
    change(d.routes[0].card.routing);
    assert.throws(() => validateRouteReview(d));
  }
  const p = profile();
  Object.defineProperty(p, 'tasks', {
    enumerable: true,
    get() {
      throw new Error('Accessor must not run');
    },
  });
  assert.throws(
    () =>
      validateRouteRoutingProfile(
        p,
        new Date().toISOString(),
        new Date(Date.now() + 3600000).toISOString(),
      ),
    code('ROUTE_ROUTING_REVIEW_INVALID'),
  );
});
void test('missing task review leaves a route manual-only and creates no automatic quote', async () => {
  const f = await fixture(),
    r = await route({ routing: null }),
    input = body(f, [candidate(r)]);
  await assert.rejects(recommend(f, input), code('ROUTING_REVIEW_REQUIRED'));
  assert.equal(await count('quotes', f), 0);
  const manual = await api(f, 'comparison-quotes', {
    projectId: f.projectId,
    items: input.candidates,
  });
  assert.equal(manual.status, 201);
});
void test('lowest exact maximum wins without a call hold or ledger change', async () => {
  const f = await fixture(),
    a = await route({ input: '2000000' }),
    b = await route(),
    input = body(f, [candidate(a), candidate(b)]),
    before = await getBalance(pool, f.accountId),
    r = await recommend(f, input);
  assert.equal(r.status, 201);
  assert.equal(r.body.quotes.length, 1);
  assert.equal(r.body.recommendation.routeVersionId, b.id);
  assert.equal(r.body.recommendation.eligibleCount, 2);
  assert.equal(r.body.maximumUsd6, quoteMaximum(b, input.candidates[1]));
  assert.match(r.body.recommendation.reason, /supplied candidates/);
  assert.equal(await count('quotes', f), 1);
  assert.equal(await count('holds', f), 0);
  assert.equal(await count('calls', f), 0);
  assert.deepEqual(await getBalance(pool, f.accountId), before);
});
void test('full per-route context determines cost rather than the smallest advertised token rate', async () => {
  const f = await fixture(),
    cheapRate = await route(),
    higherRate = await route({ input: '2000000', output: '2000000' });
  const a = candidate(cheapRate, [
      { role: 'user', content: 'Prior question' },
      { role: 'assistant', content: 'Prior context '.repeat(1800) },
      { role: 'user', content: 'Explain this algorithm.' },
    ]),
    b = candidate(higherRate);
  assert.equal(
    BigInt(quoteMaximum(cheapRate, a)) > BigInt(quoteMaximum(higherRate, b)),
    true,
  );
  const r = await recommend(f, body(f, [a, b]));
  assert.equal(r.body.recommendation.routeVersionId, higherRate.id);
  assert.equal(r.body.maximumUsd6, quoteMaximum(higherRate, b));
});
void test('equal exact quotes use stable version identifier ordering regardless of candidate order', async () => {
  const f = await fixture(),
    a = await route(),
    b = await route(),
    expected = [a.id, b.id].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))[0];
  for (const candidates of [
    [candidate(a), candidate(b)],
    [candidate(b), candidate(a)],
  ])
    assert.equal(
      (await recommend(f, body(f, candidates))).body.recommendation
        .routeVersionId,
      expected,
    );
});
void test('candidate questions and privacy must match while native output budgets may differ', async () => {
  const f = await fixture(),
    a = await route(),
    b = await route();
  await assert.rejects(
    recommend(
      f,
      body(f, [
        candidate(a),
        candidate(b, [{ role: 'user', content: 'Different question' }]),
      ]),
    ),
    code('ROUTING_CANDIDATE_MISMATCH'),
  );

  await assert.rejects(
    recommend(f, body(f, [candidate(a)], { privacy: 'strict' })),
    code('PRIVACY_ROUTE_UNAVAILABLE'),
  );
  await assert.rejects(
    recommend(f, body(f, [{ ...candidate(a), privacy: 'strict' }])),
    code('PRIVACY_ROUTE_UNAVAILABLE'),
  );
  assert.equal(await count('quotes', f), 0);
});
void test('user budget is exact and insufficient budgets create no quote', async () => {
  const f = await fixture(),
    r = await route(),
    c = candidate(r),
    cost = quoteMaximum(r, c);
  await assert.rejects(
    recommend(f, body(f, [c], { budgetUsd6: (BigInt(cost) - 1n).toString() })),
    code('ROUTING_BUDGET_EXCEEDED'),
  );
  assert.equal(await count('quotes', f), 0);
  assert.equal(
    (await recommend(f, body(f, [c], { budgetUsd6: cost }))).body.maximumUsd6,
    cost,
  );
  for (const budgetUsd6 of ['0', '01', '1e6', '10000001', 10000000])
    await assert.rejects(
      recommend(f, body(f, [c], { budgetUsd6 })),
      code('INVALID_ROUTING_BUDGET'),
    );
});
void test('a configured hold buffer prices every candidate on the buffered fee-inclusive maximum', async () => {
  const f = await fixture(),
    a = await route({ input: '2000000' }),
    b = await route(),
    c = candidate(b),
    base = BigInt(quoteMaximum(b, c)),
    widened = base + (base * 1000n + 9999n) / 10000n;
  process.env.CONCLAVE_HOLD_BUFFER_BPS = '1000';
  try {
    const r = await recommend(f, body(f, [candidate(a), c]));
    assert.equal(r.status, 201);
    assert.equal(r.body.recommendation.routeVersionId, b.id);
    assert.equal(r.body.maximumUsd6, widened.toString());
    assert.equal(r.body.recommendation.maximumUsd6, widened.toString());
    assert.equal(r.body.quotes[0].maximumUsd6, widened.toString());
    assert.deepEqual(r.body.quotes[0].reservation, {
      bufferBps: 1000,
      baseMaximumUsd6: base.toString(),
      bufferedBaseMaximumUsd6: widened.toString(),
    });
    assert.equal(r.body.quotes[0].platformFee, undefined);
    assert.equal(
      (
        await pool.query('SELECT max_usd6::text FROM quotes WHERE id=$1', [
          r.body.quotes[0].id,
        ])
      ).rows[0].max_usd6,
      widened.toString(),
    );
    // The user budget is compared against the buffered maximum.
    await assert.rejects(
      recommend(
        f,
        body(f, [c], { budgetUsd6: (widened - 1n).toString() }),
      ),
      code('ROUTING_BUDGET_EXCEEDED'),
    );
    assert.equal(
      (await recommend(f, body(f, [c], { budgetUsd6: widened.toString() })))
        .body.maximumUsd6,
      widened.toString(),
    );
    // With a platform fee the fee is computed on the buffered base.
    process.env.CONCLAVE_PLATFORM_FEE_BPS = '500';
    process.env.CONCLAVE_BURN_SHARE_BPS = '5000';
    const fee = (widened * 500n) / 10000n,
      priced = await recommend(f, body(f, [c]));
    assert.equal(priced.body.maximumUsd6, (widened + fee).toString());
    assert.deepEqual(priced.body.quotes[0].reservation, {
      bufferBps: 1000,
      baseMaximumUsd6: base.toString(),
      bufferedBaseMaximumUsd6: widened.toString(),
    });
    assert.equal(
      priced.body.quotes[0].platformFee.baseMaximumUsd6,
      widened.toString(),
    );
    assert.equal(
      priced.body.quotes[0].platformFee.platformFeeMaximumUsd6,
      fee.toString(),
    );
    delete process.env.CONCLAVE_PLATFORM_FEE_BPS;
    delete process.env.CONCLAVE_BURN_SHARE_BPS;
    // The per-request cap binds on the buffered total: a route that fits at
    // its listed price no longer fits once buffered.
    const dear = await route({ input: '2850000000', output: '2850000000' }),
      d = candidate(dear);
    assert.ok(BigInt(quoteMaximum(dear, d)) <= 10_000_000n);
    assert.ok(
      BigInt(quoteMaximum(dear, d)) +
        (BigInt(quoteMaximum(dear, d)) * 1000n + 9999n) / 10000n >
        10_000_000n,
    );
    await assert.rejects(
      recommend(f, body(f, [d])),
      code('ROUTING_BUDGET_EXCEEDED'),
    );
    delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
    assert.equal((await recommend(f, body(f, [d]))).status, 201);
  } finally {
    delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
    delete process.env.CONCLAVE_PLATFORM_FEE_BPS;
    delete process.env.CONCLAVE_BURN_SHARE_BPS;
  }
});
void test('an invalid hold buffer fails closed before any candidate is priced', async () => {
  const f = await fixture(),
    r = await route(),
    input = body(f, [candidate(r)]);
  process.env.CONCLAVE_HOLD_BUFFER_BPS = '2001';
  try {
    await assert.rejects(recommend(f, input), code('CONFIGURATION_REQUIRED'));
    const response = await api(f, 'auto-route-quotes', input);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'CONFIGURATION_REQUIRED');
    assert.equal(await count('quotes', f), 0);
  } finally {
    delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
  }
  assert.equal((await recommend(f, input)).status, 201);
});
void test('newest disabled or unreviewed versions never fall back to older enabled routes', async () => {
  const f = await fixture(),
    old = await route(),
    latest = await route({ routeId: old.routeId, version: 2, enabled: false });
  await assert.rejects(
    recommend(f, body(f, [candidate(old)])),
    code('ROUTING_CANDIDATES_STALE'),
  );
  await assert.rejects(
    recommend(f, body(f, [candidate(latest)])),
    code('ROUTING_REVIEW_REQUIRED'),
  );
  assert.equal(await count('quotes', f), 0);
});
void test('general is an explicit task and unsupported or stale profiles do not receive a fallback', async () => {
  const f = await fixture(),
    r = await route({ routing: profile(['writing']) });
  await assert.rejects(
    recommend(f, body(f, [candidate(r)], { task: 'general' })),
    code('ROUTING_REVIEW_REQUIRED'),
  );
  const stale = await route({
      routing: {
        ...profile(),
        reviewedAt: new Date(Date.now() - 86400001).toISOString(),
      },
    }),
    unverified = await route({
      routing: { ...profile(), evidenceUrl: 'https://unknown.example/profile' },
    });
  for (const bad of [stale, unverified])
    await assert.rejects(
      recommend(f, body(f, [candidate(bad)])),
      code('ROUTING_REVIEW_REQUIRED'),
    );
  await assert.rejects(
    recommend(f, body(f, [candidate(r)], { task: 'vision' })),
    code('ROUTING_TASK_INVALID'),
  );
});
void test('input and output limits exclude incompatible routes while preserving whole contexts', async () => {
  const f = await fixture(),
    small = await route({ maxInputBytes: 10 }),
    short = await route({ maxOutputTokens: 1024 }),
    full = await route(),
    r = await recommend(
      f,
      body(f, [candidate(small), candidate(short), candidate(full)]),
    );
  assert.equal(r.body.recommendation.routeVersionId, full.id);
  assert.equal(r.body.recommendation.eligibleCount, 1);
  await assert.rejects(
    recommend(f, body(f, [candidate(small)])),
    code('ROUTING_NO_COMPATIBLE_ROUTE'),
  );
  await assert.rejects(
    recommend(
      f,
      body(f, [
        candidate(full, [{ role: 'user', content: 'x'.repeat(16 * 1024 * 1024 + 1) }]),
      ]),
    ),
    code('PROMPT_TOO_LARGE'),
  );
});
void test('sensitive content in any supplied context blocks routing even if that route would lose', async () => {
  const f = await fixture(),
    a = await route(),
    b = await route({ input: '9000000' }),
    secret = [
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'about',
    ].join(' ');
  await assert.rejects(
    recommend(
      f,
      body(f, [
        candidate(a),
        candidate(b, [
          { role: 'user', content: 'Prior question' },
          { role: 'assistant', content: secret },
          { role: 'user', content: 'Explain this algorithm.' },
        ]),
      ]),
    ),
    code('SENSITIVE_CONTENT'),
  );
  assert.equal(await count('quotes', f), 0);
});
void test('foreign archived and disabled account scopes fail before quoting', async () => {
  const f = await fixture(),
    foreign = await fixture(),
    r = await route();
  await assert.rejects(
    recommend(f, body(f, [candidate(r)], { projectId: foreign.projectId })),
    code('PROJECT_NOT_FOUND'),
  );
  await pool.query('UPDATE projects SET archived_at=now() WHERE id=$1', [
    f.projectId,
  ]);
  await assert.rejects(
    recommend(f, body(f, [candidate(r)])),
    code('PROJECT_NOT_FOUND'),
  );
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    foreign.accountId,
  ]);
  await assert.rejects(
    recommend(foreign, body(foreign, [candidate(r)])),
    code('ACCOUNT_UNAVAILABLE'),
  );
  assert.equal(await count('quotes', f), 0);
});
void test('automatic quote approval uses the existing exact request hash and durable comparison path', async () => {
  const f = await fixture(),
    r = await route(),
    c = candidate(r),
    q = await recommend(f, body(f, [c]));
  const input = {
    projectId: f.projectId,
    items: [{ ...c, quoteId: q.body.quotes[0].id }],
    idempotencyKey: randomUUID(),
  };
  const wrong = await api(f, 'comparisons', {
    ...input,
    items: [
      {
        ...input.items[0],
        messages: [{ role: 'user', content: 'Substituted prompt' }],
      },
    ],
  });
  assert.equal(wrong.status, 409);
  assert.equal(await count('holds', f), 0);
  const accepted = await api(f, 'comparisons', input);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.comparison.calls[0].routeVersionId, r.id);
  assert.equal((await api(f, 'comparisons', input)).body.replayed, true);
  assert.equal(await count('holds', f), 1);
  assert.equal(await count('calls', f), 1);
});
void test('quote expiry never exceeds the selected route and task review windows', async () => {
  const f = await fixture(),
    r = await route({ expiresAt: new Date(Date.now() + 30000).toISOString() }),
    q = await recommend(f, body(f, [candidate(r)]));
  assert.equal(
    Date.parse(q.body.quotes[0].expiresAt) <= Date.parse(r.expiresAt),
    true,
  );
  assert.equal(
    Date.parse(q.body.quotes[0].expiresAt) <=
      Date.parse(r.card.routing.reviewedAt) + 86400000,
    true,
  );
});
void test('freshness uses actual time after waiting for the owner lock', async () => {
  const f = await fixture(),
    r = await route({ expiresAt: new Date(Date.now() + 400).toISOString() }),
    client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
    f.accountId,
  ]);
  const pending = recommend(f, body(f, [candidate(r)])).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  await client.query('COMMIT');
  client.release();
  assert.equal((await pending).error?.code, 'ROUTING_REVIEW_REQUIRED');
  assert.equal(await count('quotes', f), 0);
});
void test('registry publication during a waiting request prevents stale-version recommendations', async () => {
  const f = await fixture(),
    old = await route(),
    client = await pool.connect();
  await client.query('BEGIN');
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('conclave_route_registry_v1'))",
  );
  const pending = recommend(f, body(f, [candidate(old)])).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await route({ routeId: old.routeId, version: 2, enabled: false });
  await client.query('COMMIT');
  client.release();
  assert.equal((await pending).error?.code, 'ROUTING_CANDIDATES_STALE');
  assert.equal(await count('quotes', f), 0);
});
void test('duplicate canonical identifiers malformed bodies and provider-disabled requests cannot create quotes', async () => {
  const f = await fixture(),
    r = await route();
  await assert.rejects(
    recommend(
      f,
      body(f, [
        candidate(r),
        { ...candidate(r), routeVersionId: r.id.toUpperCase() },
      ]),
    ),
    code('DUPLICATE_MODEL'),
  );
  await assert.rejects(
    recommend(f, body(f, [candidate(r)], { extra: true })),
    code('ROUTING_CANDIDATES_INVALID'),
  );
  await assert.rejects(
    recommend(
      f,
      body(
        f,
        Array.from({ length: 257 }, () => candidate(r)),
      ),
    ),
    code('ROUTING_CANDIDATES_INVALID'),
  );
  await assert.rejects(
    recommend(f, body(f, [candidate(r)]), false),
    code('PROVIDER_UNAVAILABLE'),
  );
  assert.equal(await count('quotes', f), 0);
});
void test('authenticated routing dispatch enforces the account header and same-origin boundary', async () => {
  const f = await fixture(),
    r = await route(),
    input = body(f, [candidate(r)]),
    normal = await api(f, 'auto-route-quotes', input);
  assert.equal(normal.status, 201);
  for (const headers of [
    { origin: 'https://foreign.test', 'X-Conclave-Account-Id': f.accountId },
    { origin: 'https://conclave.test', 'X-Conclave-Account-Id': randomUUID() },
  ]) {
    const response = await dispatch(
      new Request('https://conclave.test/api/auto-route-quotes', {
        method: 'POST',
        headers: {
          cookie: f.cookie,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(input),
      }),
    );
    assert.equal([401, 403].includes(response.status), true);
  }
});

async function waitingApproval(f, input) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
    f.accountId,
  ]);
  const pending = api(f, 'comparisons', input);
  let waiting = false;
  for (let i = 0; i < 10 && !waiting; i++) {
    waiting = (
      await pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM accounts WHERE id=$1 AND disabled_at%') AS waiting",
      )
    ).rows[0].waiting;
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    assert.equal(waiting, true);
    await new Promise((resolve) => setTimeout(resolve, 450));
  } finally {
    await client.query('COMMIT');
    client.release();
  }
  return pending;
}
void test('comparison approval rejects a quote that expires while waiting for its account lock', async () => {
  const f = await fixture(),
    r = await route(),
    c = candidate(r),
    q = await recommend(f, body(f, [c]));
  await pool.query(
    "UPDATE quotes SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
    [q.body.quotes[0].id],
  );
  const response = await waitingApproval(f, {
    projectId: f.projectId,
    items: [{ ...c, quoteId: q.body.quotes[0].id }],
    idempotencyKey: randomUUID(),
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'QUOTE_EXPIRED');
  assert.equal(await count('holds', f), 0);
  assert.equal(await count('calls', f), 0);
});
void test('comparison approval cannot outlive a reviewed route window while waiting for a lock', async () => {
  const f = await fixture(),
    r = await route({ expiresAt: new Date(Date.now() + 400).toISOString() }),
    c = candidate(r),
    q = await recommend(f, body(f, [c]));
  const response = await waitingApproval(f, {
    projectId: f.projectId,
    items: [{ ...c, quoteId: q.body.quotes[0].id }],
    idempotencyKey: randomUUID(),
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'QUOTE_EXPIRED');
  assert.equal(await count('holds', f), 0);
});

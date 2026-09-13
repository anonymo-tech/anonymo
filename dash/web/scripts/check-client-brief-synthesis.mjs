import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BriefSynthesisError,
  createBriefSynthesisClient,
  parseSynthesisRun,
  sameSynthesisTerms,
  synthesisApproval,
} from '../lib/client/brief-synthesis.ts';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const accountId = uuid(1),
  briefId = uuid(2),
  projectId = uuid(3),
  runId = uuid(4),
  routeId = uuid(5),
  callId = uuid(6);
const date = '2026-10-10T00:00:00.000Z';
const scope = {
  briefId,
  projectId,
  document: {
    version: 1,
    savedAt: date,
    evidenceHash: 'a'.repeat(64),
    evidence: [
      {
        callId,
        comparisonId: uuid(7),
        routeVersionId: uuid(8),
        modelId: 'source-model',
        question: 'What should we use?',
        answer: 'Use the archive.',
        answerHash: 'b'.repeat(64),
        actualUsd6: null,
        billingState: 'running',
      },
    ],
    analysis: { decision: 'Owner notes stay private.', notes: [], matrix: [] },
  },
};
const card = {
  level: 'standard',
  reviewed: true,
  retentionDisclosure: 'Provider can read requests.',
  evidenceUrl: 'https://example.com/terms',
  evidenceDate: date,
  plaintextVisibility: 'provider',
  trainingUse: 'no',
  upstreamProviders: ['example'],
};
const quote = () => ({
  id: uuid(9),
  maximumUsd6: '200',
  expiresAt: '2026-10-10T00:02:00.000Z',
  maxOutputTokens: 2048,
  inputBytes: 1200,
  requestHash: 'c'.repeat(64),
  routeVersionId: routeId,
  modelId: 'analysis-model',
  family: 'test',
  card,
  markupBps: 100,
});
const fixture = () => ({
  id: runId,
  briefId,
  sourceBriefId: briefId,
  projectId,
  evidenceHash: scope.document.evidenceHash,
  promptVersion: 1,
  outputVersion: 1,
  createdAt: date,
  approvalKey: `bs_${runId}`,
  state: 'quoted',
  quote: quote(),
  callId: null,
  errorCode: null,
  billing: null,
  result: null,
});
const queued = () => ({
  ...fixture(),
  state: 'queued',
  callId: uuid(10),
  billing: { state: 'held', maximumUsd6: '200', actualUsd6: null },
});
const analysis = () => ({
  version: 1,
  summaries: [
    {
      callId,
      text: 'The response recommends the archive.',
      quotes: [{ text: 'Use the archive.', start: 0, end: 16 }],
    },
  ],
  matrix: [
    {
      topic: 'Archive use',
      positions: [
        {
          callId,
          position: 'agrees',
          quote: { text: 'Use the archive.', start: 0, end: 16 },
        },
      ],
    },
  ],
});
const completed = () => ({
  ...queued(),
  state: 'valid',
  billing: { state: 'captured', maximumUsd6: '200', actualUsd6: '123' },
  result: {
    status: 'valid',
    analysis: analysis(),
    invalidReason: null,
    outputHash: 'd'.repeat(64),
    createdAt: date,
  },
});
const client = (fetch, signal) =>
  createBriefSynthesisClient({ accountId, fetch, signal }, scope);
const json = (value) => Response.json(value);
const copy = (value) => structuredClone(value);

void test('saved plans are bound to account header, Brief, project and evidence', async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push({ url, options });
    return json({ run: fixture() });
  });
  assert.equal((await c.get(runId)).id, runId);
  assert.equal(calls[0].url, `/api/brief-syntheses/${runId}`);
  assert.equal(calls[0].options.headers['X-Conclave-Account-Id'], accountId);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.mode, 'same-origin');
  for (const change of [
    (r) => (r.projectId = uuid(30)),
    (r) => (r.sourceBriefId = uuid(30)),
    (r) => (r.briefId = uuid(30)),
    (r) => (r.evidenceHash = 'e'.repeat(64)),
    (r) => (r.approvalKey = 'new-key'),
  ]) {
    const r = fixture();
    change(r);
    assert.throws(() => parseSynthesisRun(r, scope));
  }
});

void test('quote sends only immutable evidence hash and explicit route version and output budget', async () => {
  let body;
  const run = await client(async (_url, options) => {
    body = JSON.parse(options.body);
    return json({ plan: fixture(), quote: quote() });
  }).quote(routeId, 2048);
  assert.deepEqual(body, {
    evidenceHash: scope.document.evidenceHash,
    routeVersionId: routeId,
    maxOutputTokens: 2048,
  });
  assert.ok(!JSON.stringify(body).includes('Owner notes'));
  assert.equal(run.approvalKey, `bs_${runId}`);
  await assert.rejects(() =>
    client(async () =>
      json({ plan: fixture(), quote: { ...quote(), maximumUsd6: '201' } }),
    ).quote(routeId, 2048),
  );
});

void test('uncertain paid approval does not retry and explicit recovery preserves identical key and maximum', async () => {
  const bodies = [],
    run = parseSynthesisRun(fixture(), scope);
  const c = client(async (_url, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) throw new Error('connection lost');
    return json({ run: queued(), replayed: true });
  });
  const approval = synthesisApproval(run);
  assert.ok(Object.isFrozen(approval));
  await assert.rejects(
    () => c.approve(run, approval),
    (e) => e instanceof BriefSynthesisError && e.outcomeUnknown,
  );
  assert.equal(bodies.length, 1);
  assert.equal((await c.approve(run, approval)).replayed, true);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[0]), {
    quoteId: quote().id,
    idempotencyKey: `bs_${runId}`,
    approveMaximumUsd6: '200',
  });
});

void test('approval rejects a modified local maximum before dispatch and a swapped saved quote after dispatch', async () => {
  let requests = 0;
  const run = parseSynthesisRun(fixture(), scope);
  const c = client(async () => {
    requests++;
    return json({
      run: { ...queued(), quote: { ...quote(), maximumUsd6: '201' } },
      replayed: false,
    });
  });
  await assert.rejects(() =>
    c.approve(run, { ...synthesisApproval(run), approveMaximumUsd6: '201' }),
  );
  assert.equal(requests, 0);
  await assert.rejects(
    () => c.approve(run),
    (e) => e.outcomeUnknown === true,
  );
  assert.equal(requests, 1);
});

void test('truncated or oversized successful approval responses retain unknown outcome and never expose body text', async () => {
  for (const body of ['{"run":', `{"private":"${'x'.repeat(270000)}"}`]) {
    let count = 0;
    await assert.rejects(
      () =>
        client(async () => {
          count++;
          return new Response(body, {
            headers: { 'content-type': 'application/json' },
          });
        }).approve(parseSynthesisRun(fixture(), scope)),
      (e) => e.outcomeUnknown && !e.message.includes(body.slice(0, 10)),
    );
    assert.equal(count, 1);
  }
});

void test('server failures use fixed safe messages while preserving paid uncertainty', async () => {
  const c = client(async () =>
    Response.json(
      {
        error: {
          code: 'UPSTREAM_FAILURE',
          message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC',
        },
      },
      { status: 503 },
    ),
  );
  await assert.rejects(
    () => c.approve(parseSynthesisRun(fixture(), scope)),
    (e) =>
      e.status === 503 &&
      e.outcomeUnknown &&
      !e.message.includes('SYNTHETIC_PRIVATE'),
  );
});

void test('integer cost parsing rejects rounded, negative, noncanonical or unbounded amounts', () => {
  for (const amount of [0.0002, '-1', '01', '1.0', '9223372036854775808']) {
    const r = fixture();
    r.quote.maximumUsd6 = amount;
    assert.throws(() => parseSynthesisRun(r, scope));
  }
  const r = completed();
  r.billing.actualUsd6 = '201';
  assert.throws(() => parseSynthesisRun(r, scope));
  r.billing = { state: 'released', maximumUsd6: '200', actualUsd6: '1' };
  assert.throws(() => parseSynthesisRun(r, scope));
});

void test('full results independently revalidate literal quotes and all source positions', () => {
  assert.deepEqual(
    parseSynthesisRun(completed(), scope).result.analysis,
    analysis(),
  );
  for (const change of [
    (r) => (r.result.analysis.summaries[0].quotes[0].text = 'Invented quote'),
    (r) => (r.result.analysis.summaries[0].quotes[0].start = 1),
    (r) => (r.result.analysis.matrix[0].positions = []),
    (r) => (r.result.analysis.matrix[0].positions[0].callId = uuid(31)),
  ]) {
    const r = completed();
    change(r);
    assert.throws(() => parseSynthesisRun(r, scope));
  }
});

void test('list metadata cannot masquerade as full analysis; pagination remains bounded', async () => {
  const row = { ...completed(), metadataOnly: true };
  row.result.analysis = null;
  const c = client(async () =>
    json({ runs: [row], nextCursor: 'a'.repeat(512), selectedRunId: runId }),
  );
  const page = await c.list();
  assert.equal(page.runs[0].result.analysis, null);
  assert.equal(page.nextCursor.length, 512);
  assert.throws(() => parseSynthesisRun(row, scope));
  await assert.rejects(() =>
    client(async () =>
      json({ runs: [row, row], nextCursor: null, selectedRunId: null }),
    ).list(),
  );
  await assert.rejects(() =>
    client(async () =>
      json({ runs: [], nextCursor: 'a'.repeat(513), selectedRunId: null }),
    ).list(),
  );
  await assert.rejects(() =>
    client(async () =>
      json({
        runs: [{ ...completed(), metadataOnly: true }],
        nextCursor: null,
        selectedRunId: null,
      }),
    ).list(),
  );
});

void test('invalid generated output preserves its real confirmed charge without fabricated usable result', () => {
  const r = completed();
  r.state = 'invalid';
  r.result = {
    ...r.result,
    status: 'invalid',
    analysis: null,
    invalidReason: 'INVALID_JSON',
  };
  const parsed = parseSynthesisRun(r, scope);
  assert.equal(parsed.billing.actualUsd6, '123');
  assert.equal(parsed.result.analysis, null);
  r.result.analysis = analysis();
  assert.throws(() => parseSynthesisRun(r, scope));
});

void test('saved status reads and deterministic evaluation perform no implicit approval', async () => {
  const urls = [];
  const c = client(async (url, options) => {
    urls.push({ url, body: options.body, method: options.method });
    return json({ run: completed() });
  });
  const original = parseSynthesisRun(fixture(), scope);
  await c.get(runId, original);
  await c.evaluate(original);
  assert.deepEqual(
    urls.map((v) => v.method),
    ['GET', 'POST'],
  );
  assert.equal(urls[1].url, `/api/brief-syntheses/${runId}/evaluate`);
  assert.equal(urls[1].body, '{}');
  assert.ok(urls.every((v) => !v.url.endsWith('/approve')));
});

void test('selection accepts only a refreshed matching Brief and selected run with advanced revision', async () => {
  const r = completed();
  const selected = {
    runId,
    callId: r.callId,
    routeVersionId: routeId,
    modelId: r.quote.modelId,
    evidenceHash: r.evidenceHash,
    promptVersion: 1,
    outputVersion: 1,
    createdAt: date,
    outputHash: r.result.outputHash,
    maximumUsd6: '200',
    actualUsd6: '123',
    billingState: 'captured',
    analysis: analysis(),
  };
  const brief = {
    id: briefId,
    projectId,
    title: 'Saved Brief',
    revision: 2,
    document: { ...scope.document, synthesis: selected },
  };
  let body;
  const c = client(async (_url, options) => {
    body = JSON.parse(options.body);
    return json({ brief });
  });
  assert.equal((await c.select(1, runId)).document.synthesis.runId, runId);
  assert.deepEqual(body, { revision: 1, runId });
  for (const change of [
    (v) => (v.projectId = uuid(30)),
    (v) => (v.revision = 1),
    (v) => (v.document.synthesis.runId = uuid(31)),
    (v) => (v.document.evidenceHash = 'f'.repeat(64)),
  ]) {
    const swapped = copy(brief);
    change(swapped);
    await assert.rejects(() =>
      client(async () => json({ brief: swapped })).select(1, runId),
    );
  }
  const removed = copy(brief);
  delete removed.document.synthesis;
  assert.equal(
    (await client(async () => json({ brief: removed })).select(1, null))
      .document.synthesis,
    undefined,
  );
});

void test('scope abort rejects a late successful response rather than importing stale account data', async () => {
  const controller = new AbortController();
  let release;
  const c = client(async () => {
    await new Promise((resolve) => (release = resolve));
    return json({ run: completed() });
  }, controller.signal);
  const response = c.get(runId);
  controller.abort();
  release();
  await assert.rejects(
    () => response,
    (e) => e.name === 'AbortError',
  );
});

void test('foreign or malformed IDs never become arbitrary request paths', async () => {
  let count = 0;
  const c = client(async () => {
    count++;
    return json({});
  });
  for (const path of [
    'https://example.com/private',
    '../other',
    `${runId}?accountId=${uuid(20)}`,
  ])
    await assert.rejects(() => c.get(path));
  assert.equal(count, 0);
  assert.equal(
    sameSynthesisTerms(
      parseSynthesisRun(fixture(), scope),
      parseSynthesisRun(queued(), scope),
    ),
    true,
  );
});

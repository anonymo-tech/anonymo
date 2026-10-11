import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CrossCheckClientError,
  createCrossCheckClient,
  crossCheckErrorMessage,
  guardCrossCheckText,
  makeCrossCheckApproval,
  parseCrossCheck,
  parseCrossCheckQuote,
  parseExecution,
  parseSource,
} from '../lib/client/crosscheck.ts';
import {
  createSourceSnapshot,
  evaluateCrossCheck,
  prepareCrossCheck,
} from '../server/crosscheck/index.ts';

const uuid = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const accountId = uuid(1),
  projectId = uuid(2),
  sourceId = uuid(3),
  runId = uuid(4),
  rosterId = uuid(5);
const now = Date.UTC(2026, 0, 1);
const scope = { accountId, scopeId: projectId, revision: 'owner-v1' };
const excerpt = 'The archive opens at 09:00.';
const source = await createSourceSnapshot(
  {
    id: sourceId,
    title: 'Archive hours',
    uri: 'https://archive.example/hours',
    text: `${excerpt}\nThe archive closes at 17:00.`,
    scope,
    visibility: 'private',
    capturedAtMs: now,
  },
  now,
);
const reviewers = [
  {
    id: uuid(10),
    family: 'claude',
    modelId: 'anthropic/reviewer',
    version: 'reviewed-v1',
    distribution: 'proprietary',
  },
  {
    id: uuid(11),
    family: 'gpt',
    modelId: 'openai/reviewer',
    version: 'reviewed-v1',
    distribution: 'proprietary',
  },
  {
    id: uuid(12),
    family: 'deepseek',
    modelId: 'deepseek/reviewer',
    version: 'reviewed-v1',
    distribution: 'open-weight',
  },
];
const plan = await prepareCrossCheck({
  scope,
  claims: [{ id: 'claim-1', text: excerpt }],
  sources: [source],
  reviewers,
  now,
});
const notStarted = {
  state: 'not_started',
  calls: [],
  maximumUsd6: null,
  actualUsd6: null,
};
const fixture = () => ({
  id: runId,
  projectId,
  rosterId,
  status: 'prepared',
  label: 'Prepared — not reviewed',
  plan,
  result: null,
  cacheUsable: false,
  execution: notStarted,
});
const clone = (value) => structuredClone(value);
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const quoteFixture = () => ({
  quoteGroupId: uuid(6),
  runId,
  maximumUsd6: '600',
  maxOutputTokens: 2048,
  reviewCount: 3,
  expiresAt: new Date(now + 120_000).toISOString(),
  terms: reviewers.map((reviewer, index) => ({
    claimId: 'claim-1',
    reviewerId: reviewer.id,
    routeVersionId: reviewer.id,
    modelId: reviewer.modelId,
    family: reviewer.family,
    distribution: reviewer.distribution,
    reviewerVersion: reviewer.version,
    maximumUsd6: String((index + 1) * 100),
    markupBps: 1000,
    card: {
      level: 'Standard',
      retentionDisclosure:
        'Plaintext processing; retention as disclosed by the provider.',
      evidenceDate: '2026-01-01',
      evidenceUrl: 'https://provider.example/privacy',
    },
  })),
});
const executionFixture = () => ({
  state: 'queued',
  maximumUsd6: '600',
  actualUsd6: null,
  evaluationNeedsAttention: false,
  calls: reviewers.map((reviewer, index) => ({
    id: uuid(20 + index),
    claimId: 'claim-1',
    reviewerId: reviewer.id,
    state: 'queued',
    errorCode: null,
    billingState: 'held',
    actualUsd6: null,
  })),
});
const submission = (reviewer, verdict = 'supported') => ({
  reviewerId: reviewer.id,
  claimId: 'claim-1',
  content: JSON.stringify({
    verdict,
    rationale: 'The supplied passage states its opening time.',
    quotes:
      verdict === 'insufficient_evidence'
        ? []
        : [{ sourceId, sourceHash: source.snapshotHash, quote: excerpt }],
  }),
});

void test('accepts current owned source/plan contracts without presenting prepared content as reviewed', () => {
  const parsedSource = parseSource(source, accountId, projectId);
  assert.equal(parsedSource.text, source.text);
  const parsed = parseCrossCheck(fixture(), accountId, projectId);
  assert.equal(parsed.result, null);
  assert.equal(parsed.cacheUsable, false);
  assert.equal(parsed.execution.state, 'not_started');
  const preparedResponse = {
    ...fixture(),
    execution: {
      enabled: false,
      status: 'not_connected',
      message: 'Preparation only',
    },
  };
  assert.equal(parseCrossCheck(preparedResponse, accountId).execution, null);
  for (const update of [{ status: 'reviewed' }, { cacheUsable: true }])
    assert.throws(
      () => parseCrossCheck({ ...fixture(), ...update }, accountId),
      CrossCheckClientError,
    );
});

void test('rejects wrong account/project, ambiguous roster families and oversized/malformed source fields', () => {
  assert.throws(
    () => parseSource(source, uuid(90), projectId),
    CrossCheckClientError,
  );
  assert.throws(
    () => parseSource(source, accountId, uuid(90)),
    CrossCheckClientError,
  );
  assert.throws(
    () => parseCrossCheck(fixture(), uuid(90)),
    CrossCheckClientError,
  );
  assert.throws(
    () => parseCrossCheck(fixture(), accountId, uuid(90)),
    CrossCheckClientError,
  );
  for (const mutate of [
    (v) => {
      v.plan.reviewers[1].family = v.plan.reviewers[0].family;
    },
    (v) => {
      v.plan.reviewers.forEach((r) => {
        r.distribution = 'proprietary';
      });
    },
    (v) => {
      v.plan.sources[0].scope.scopeId = uuid(90);
    },
    (v) => {
      v.plan.sources[0].text = '界'.repeat(30_000);
      v.plan.sources[0].normalizedText = v.plan.sources[0].text;
    },
    (v) => {
      v.plan.sources[0].uri = 'javascript:alert(1)';
    },
    (v) => {
      v.plan.sources[0].normalizedText = 'Different content';
    },
    (v) => {
      v.plan.sources.push(
        ...Array.from({ length: 8 }, (_, i) => ({
          ...v.plan.sources[0],
          id: uuid(100 + i),
        })),
      );
    },
  ]) {
    const value = clone(fixture());
    mutate(value);
    assert.throws(
      () => parseCrossCheck(value, accountId),
      CrossCheckClientError,
    );
  }
});

void test('quote must cover every claim/reviewer once with matching route identity and exact summed maximum', () => {
  const run = parseCrossCheck(fixture(), accountId);
  assert.equal(parseCrossCheckQuote(quoteFixture(), run).maximumUsd6, '600');
  for (const mutate of [
    (v) => {
      v.maximumUsd6 = '601';
    },
    (v) => {
      v.maximumUsd6 = '0600';
    },
    (v) => {
      v.runId = uuid(90);
    },
    (v) => {
      v.terms[0].routeVersionId = uuid(90);
    },
    (v) => {
      v.terms[0].reviewerVersion = 'unreviewed';
    },
    (v) => {
      v.terms[0].modelId = 'different/model';
    },
    (v) => {
      v.terms[0].claimId = 'unknown-claim';
    },
    (v) => {
      v.terms[1] = v.terms[0];
    },
    (v) => {
      v.terms.pop();
    },
    (v) => {
      v.terms[0].maximumUsd6 = '10000000';
      v.maximumUsd6 = '10000500';
    },
  ]) {
    const value = quoteFixture();
    mutate(value);
    assert.throws(
      () => parseCrossCheckQuote(value, run),
      CrossCheckClientError,
    );
  }
});

void test('approval snapshots are immutable and preserve one original idempotency key', () => {
  const quote = parseCrossCheckQuote(
    quoteFixture(),
    parseCrossCheck(fixture(), accountId),
  );
  const key = 'crosscheck-request-key-0001';
  const approval = makeCrossCheckApproval(quote, key);
  quote.maximumUsd6 = '1000';
  assert.deepEqual(approval, {
    quoteGroupId: uuid(6),
    idempotencyKey: key,
    approveMaximumUsd6: '600',
  });
  assert.throws(() => {
    approval.idempotencyKey = 'different-key-000000';
  }, TypeError);
  assert.throws(
    () => makeCrossCheckApproval(quote, 'too-short'),
    CrossCheckClientError,
  );
});

void test('literal quote checking preserves disagreement and incomplete review semantics', async () => {
  const result = await evaluateCrossCheck(
    plan,
    reviewers.map((reviewer, index) =>
      submission(reviewer, index === 2 ? 'contradicted' : 'supported'),
    ),
    now + 1000,
  );
  const raw = {
    ...fixture(),
    status: 'reviewed',
    label: 'Reviewed against provided source snapshots',
    result,
    cacheUsable: true,
  };
  const parsed = parseCrossCheck(raw, accountId);
  assert.equal(parsed.result.verdict, 'NO_CONSENSUS');
  assert.equal(parsed.result.claims[0].dissent, true);
  assert.deepEqual(parsed.result.claims[0].uncertainty, ['disagreement']);
  assert.equal(parsed.result.claims[0].reviews[0].quotes[0].normalizedStart, 0);
  const missing = await evaluateCrossCheck(
    plan,
    [submission(reviewers[0])],
    now + 1000,
  );
  const incomplete = parseCrossCheck({ ...raw, result: missing }, accountId);
  assert.equal(incomplete.result.claims[0].validFamilyCount, 1);
  assert.equal(incomplete.result.verdict, 'NO_CONSENSUS');
  assert.ok(
    incomplete.result.claims[0].uncertainty.includes('missing_valid_review'),
  );
  for (const mutate of [
    (v) => {
      v.result.verdict = 'HOLDS';
    },
    (v) => {
      v.result.claims[0].dissent = false;
    },
    (v) => {
      v.result.claims[0].validFamilyCount = 4;
    },
    (v) => {
      v.result.claims[0].reviews[0].quotes[0].normalizedStart = 1;
    },
    (v) => {
      v.result.claims[0].reviews[0].quotes[0].sourceHash = 'a'.repeat(64);
    },
    (v) => {
      v.result.claims[0].reviews[0].quotes[0].quote = 'Invented evidence';
    },
    (v) => {
      v.result.claims[0].reviews[1] = v.result.claims[0].reviews[0];
    },
    (v) => {
      v.result.claims[0].uncertainty.push('disagreement');
    },
    (v) => {
      v.result.requestHash = 'a'.repeat(64);
    },
  ]) {
    const value = clone(raw);
    mutate(value);
    assert.throws(
      () => parseCrossCheck(value, accountId),
      CrossCheckClientError,
    );
  }
});

void test('incomplete execution and unsettled billing stay explicit, with bounded distinct owned calls', () => {
  const execution = executionFixture();
  execution.state = 'incomplete';
  execution.calls[0].state = 'reconciliation_pending';
  execution.calls[0].billingState = 'reconciliation_pending';
  const parsed = parseExecution(execution);
  assert.equal(parsed.state, 'incomplete');
  assert.equal(parsed.actualUsd6, null);
  assert.throws(
    () => parseExecution({ ...execution, actualUsd6: '601' }),
    CrossCheckClientError,
  );
  assert.throws(
    () =>
      parseExecution({
        ...execution,
        calls: [execution.calls[0], execution.calls[0]],
      }),
    CrossCheckClientError,
  );
  execution.calls[0].claimId = 'unowned-claim';
  assert.throws(
    () => parseCrossCheck({ ...fixture(), execution }, accountId),
    CrossCheckClientError,
  );
});

void test('guard blocks source/claim mutation before sending and warnings remain separate from a secret block', async () => {
  let sends = 0;
  const check = async (value) => ({
    redacted: '',
    findings:
      value === 'secret fixture'
        ? [{ severity: 'block', message: 'Secret detected.' }]
        : [{ severity: 'warning', message: 'Instruction-like content.' }],
  });
  await assert.rejects(
    (async () => {
      await guardCrossCheckText(check, ['title', 'secret fixture']);
      sends++;
    })(),
    (error) =>
      error.code === 'SENSITIVE_CONTENT' &&
      !error.message.includes('secret fixture'),
  );
  assert.equal(sends, 0);
  assert.deepEqual(await guardCrossCheckText(check, ['claim', 'source']), [
    'Instruction-like content.',
  ]);
});

void test('preparation is account-bound and sends exactly the guarded draft, without running paid reviews', async () => {
  const requests = [];
  const input = {
    projectId,
    rosterId,
    sourceIds: [sourceId],
    claims: [{ id: 'claim-1', text: excerpt }],
  };
  const client = createCrossCheckClient(accountId, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return json({ crosscheck: fixture(), reused: false, cacheHit: false });
    },
  });
  await client.prepare(input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/crosscheck');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), input);
  assert.equal(requests[0].options.headers['X-Conclave-Account-Id'], accountId);
  for (const key of ['credentials', 'mode'])
    assert.equal(requests[0].options[key], 'same-origin');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(!requests.some((request) => request.url.endsWith('/run')));
});

void test('read/reconnect only GETs saved runs and never obtains a quote or creates a paid call', async () => {
  const requests = [];
  const client = createCrossCheckClient(accountId, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return json({
        crosscheck: { ...fixture(), execution: executionFixture() },
      });
    },
  });
  await client.read(runId, projectId);
  await client.read(runId, projectId);
  assert.deepEqual(
    requests.map((r) => [r.url, r.options.method, r.options.body]),
    [
      [`/api/crosscheck/${runId}`, 'GET', undefined],
      [`/api/crosscheck/${runId}`, 'GET', undefined],
    ],
  );
});

void test('a lost approval response never retries automatically; explicit recovery sends the identical snapshot', async () => {
  const requests = [];
  const approval = makeCrossCheckApproval(
    parseCrossCheckQuote(quoteFixture(), parseCrossCheck(fixture(), accountId)),
    'crosscheck-request-key-0001',
  );
  const client = createCrossCheckClient(accountId, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) throw new TypeError('PRIVATE NETWORK DETAILS');
      return json({
        id: uuid(7),
        runId,
        replayed: true,
        execution: executionFixture(),
      });
    },
  });
  await assert.rejects(
    client.approve(runId, approval),
    (error) =>
      error.code === 'NETWORK_ERROR' && !error.message.includes('PRIVATE'),
  );
  assert.equal(requests.length, 1);
  const replay = await client.approve(runId, approval);
  assert.equal(replay.replayed, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.body, requests[1].options.body);
  assert.deepEqual(JSON.parse(requests[0].options.body), approval);
});

void test('disabled capability and service errors use static text, never provider response bodies', async () => {
  const client = createCrossCheckClient(accountId, {
    fetch: async () =>
      json({
        configured: false,
        reason: 'EXECUTION_DISABLED_OR_UNCONFIGURED',
        limits: { calls: 24, maximumUsd6: '10000000', quoteSeconds: 120 },
      }),
  });
  assert.equal((await client.capability()).configured, false);
  for (const [code, status] of [
    ['CROSSCHECK_EXECUTION_DISABLED', 503],
    ['CROSSCHECK_QUOTE_EXPIRED', 409],
    ['INSUFFICIENT_FUNDS', 402],
    ['INVENTED_ERROR', 500],
  ]) {
    const failed = createCrossCheckClient(accountId, {
      fetch: async () =>
        json({ error: { code, message: 'PRIVATE CONTENT' } }, status),
    });
    await assert.rejects(
      failed.read(runId, projectId),
      (error) =>
        error.status === status &&
        !crossCheckErrorMessage(error).includes('PRIVATE'),
    );
  }
  await assert.rejects(
    createCrossCheckClient(accountId, {
      fetch: async () =>
        new Response('PRIVATE'.repeat(200_000), { status: 401 }),
    }).read(runId, projectId),
    (error) =>
      error.status === 401 &&
      error.code === 'ACCOUNT_CHANGED' &&
      !error.message.includes('PRIVATE'),
  );
});

void test('aborted account requests send nothing and late responses cannot publish private content', async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  await assert.rejects(
    createCrossCheckClient(accountId, {
      signal: controller.signal,
      fetch: async () => {
        requests++;
        return json({ crosscheck: fixture() });
      },
    }).read(runId, projectId),
    (error) => error.name === 'AbortError',
  );
  assert.equal(requests, 0);
  const late = new AbortController();
  await assert.rejects(
    createCrossCheckClient(accountId, {
      signal: late.signal,
      fetch: async () => {
        late.abort();
        return json({ crosscheck: fixture() });
      },
    }).read(runId, projectId),
    (error) => error.name === 'AbortError',
  );
});

void test('response budgets, broken JSON and mismatched run IDs fail without partially rendering', async () => {
  for (const response of [
    new Response(' '.repeat(1_048_577), {
      headers: { 'content-type': 'application/json' },
    }),
    json({ rosters: Array.from({ length: 51 }, () => ({})) }),
    new Response('{broken', {
      headers: { 'content-type': 'application/json' },
    }),
  ]) {
    await assert.rejects(
      createCrossCheckClient(accountId, {
        fetch: async () => response,
      }).rosters(),
      CrossCheckClientError,
    );
  }
  await assert.rejects(
    createCrossCheckClient(accountId, {
      fetch: async () => json({ crosscheck: { ...fixture(), id: uuid(90) } }),
    }).read(runId, projectId),
    CrossCheckClientError,
  );
});

void test('a stalled approval times out without retrying or changing its recovery snapshot', async () => {
  let requests = 0;
  const approval = makeCrossCheckApproval(
    parseCrossCheckQuote(quoteFixture(), parseCrossCheck(fixture(), accountId)),
    'crosscheck-request-key-0001',
  );
  const client = createCrossCheckClient(accountId, {
    timeoutMs: 1,
    fetch: async (_url, { signal }) => {
      requests++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  });
  await assert.rejects(
    client.approve(runId, approval),
    (error) => error.code === 'REQUEST_TIMEOUT',
  );
  assert.equal(requests, 1);
  assert.equal(approval.idempotencyKey, 'crosscheck-request-key-0001');
  assert.equal(approval.approveMaximumUsd6, '600');
});

void test('oversized approval responses do not assert a rollback or automatically retry a possibly accepted request', async () => {
  let requests = 0;
  const approval = makeCrossCheckApproval(
    parseCrossCheckQuote(quoteFixture(), parseCrossCheck(fixture(), accountId)),
    'crosscheck-request-key-0001',
  );
  const client = createCrossCheckClient(accountId, {
    fetch: async () => {
      requests++;
      return new Response(' '.repeat(1_048_577), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(
    client.approve(runId, approval),
    (error) =>
      error.code === 'RESPONSE_TOO_LARGE' &&
      error.status === 0 &&
      error.message.includes('original request key') &&
      !error.message.includes('No saved data was changed'),
  );
  assert.equal(requests, 1);
});

void test('source text and model rationale remain literal strings rather than markup or fetched links', async () => {
  const result = clone(
    await evaluateCrossCheck(
      plan,
      reviewers.map((r) => submission(r)),
      now + 1000,
    ),
  );
  result.claims[0].reviews[0].rationale =
    '<img src=x onerror=bad()> https://example.invalid';
  const parsed = parseCrossCheck(
    { ...fixture(), status: 'reviewed', result, cacheUsable: true },
    accountId,
  );
  assert.equal(
    parsed.result.claims[0].reviews[0].rationale,
    result.claims[0].reviews[0].rationale,
  );
});

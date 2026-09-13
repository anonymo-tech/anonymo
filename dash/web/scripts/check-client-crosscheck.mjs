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

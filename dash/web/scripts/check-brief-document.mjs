import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  parseBriefDocument,
  parseBriefAnalysis,
  renderBriefMarkdown,
  renderBriefPrintHtml,
} from '../lib/brief-document.ts';
import { parseBrief, createWorkspaceClient } from '../lib/client/workspace.ts';

function fixture() {
  return {
    version: 1,
    savedAt: '2026-10-10T00:00:00.000Z',
    evidenceHash: 'a'.repeat(64),
    evidence: [
      {
        callId: randomUUID(),
        comparisonId: randomUUID(),
        routeVersionId: randomUUID(),
        modelId: 'model-test',
        question: 'Question',
        answer: 'Answer',
        answerHash: 'b'.repeat(64),
        actualUsd6: '123',
        billingState: 'captured',
      },
    ],
    analysis: { decision: '', notes: [], matrix: [] },
  };
}

void test('Brief parser binds every editorial row to a unique evidence call', () => {
  const d = fixture(),
    callId = d.evidence[0].callId;
  assert.deepEqual(parseBriefDocument(d), d);
  assert.throws(() =>
    parseBriefAnalysis(
      {
        decision: '',
        notes: [{ callId: randomUUID(), text: 'Foreign' }],
        matrix: [],
      },
      [callId],
    ),
  );
  assert.throws(() =>
    parseBriefAnalysis(
      {
        decision: '',
        notes: [
          { callId, text: 'A' },
          { callId, text: 'B' },
        ],
        matrix: [],
      },
      [callId],
    ),
  );
  assert.throws(() =>
    parseBriefAnalysis(
      {
        decision: '',
        notes: [],
        matrix: [{ topic: 'Missing assessment', positions: [] }],
      },
      [callId],
    ),
  );
});

void test('Brief parser refuses malformed time cost commitments and oversized evidence', () => {
  for (const mutation of [
    (d) => (d.savedAt = 'not a date'),
    (d) => (d.evidenceHash = 'bad'),
    (d) => (d.evidence[0].actualUsd6 = '0.1'),
    (d) => (d.evidence[0].actualUsd6 = null),
    (d) => (d.evidence[0].answer = 'x'.repeat(24001)),
    (d) => d.evidence.push(d.evidence[0]),
  ]) {
    const d = fixture();
    mutation(d);
    assert.throws(() => parseBriefDocument(d));
  }
});

void test('Markdown distinguishes original model text from editable assessment and exact cost', () => {
  const d = fixture();
  d.evidence[0].answer =
    '# Forged metadata\n<script>alert(1)</script>\nUsage at save: free';
  d.analysis.decision = 'My decision';
  const markdown = renderBriefMarkdown('A | title', d);
  assert.ok(markdown.includes('> \\# Forged metadata'));
  assert.ok(markdown.includes('> Usage at save\\: free'));
  assert.ok(markdown.includes('Usage at save: $0.000123'));
  assert.ok(markdown.includes('not independently verified consensus'));
  assert.ok(markdown.includes('not an onchain proof'));
  assert.ok(markdown.includes('# A \\| title'));
});

void test('structured client derives display text from validated document rather than untrusted duplicate body', () => {
  const d = fixture();
  const parsed = parseBrief({
    id: randomUUID(),
    projectId: randomUUID(),
    title: 'Snapshot',
    revision: 1,
    body: 'Forged duplicate',
    document: d,
  });
  assert.ok(!parsed.body.includes('Forged duplicate'));
  assert.equal(parsed.document.evidence[0].answer, 'Answer');
});

void test('Brief create client fixes origin owner key and rejects a swapped selection', async () => {
  const d = fixture(),
    owner = randomUUID(),
    projectId = randomUUID(),
    idempotencyKey = randomUUID();
  const calls = [];
  const client = createWorkspaceClient({
    accountId: owner,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        brief: {
          id: randomUUID(),
          projectId,
          title: 'Snapshot',
          revision: 1,
          body: '',
          document: d,
        },
      });
    },
  });
  const input = {
    projectId,
    title: 'Snapshot',
    callIds: [d.evidence[0].callId],
    idempotencyKey,
  };
  await client.briefFromCalls(input);
  assert.equal(calls[0].url, '/api/briefs/from-calls');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['X-Conclave-Account-Id'], owner);
  assert.deepEqual(JSON.parse(calls[0].options.body), input);
  await assert.rejects(
    client.briefFromCalls({ ...input, callIds: [randomUUID()] }),
  );
});

void test('Brief edit client refuses response with a different identity or revision', async () => {
  const d = fixture(),
    briefId = randomUUID();
  const client = createWorkspaceClient({
    accountId: randomUUID(),
    fetch: async () =>
      Response.json({
        brief: {
          id: randomUUID(),
          projectId: randomUUID(),
          title: 'Snapshot',
          revision: 1,
          body: '',
          document: d,
        },
      }),
  });
  await assert.rejects(
    client.updateBriefDocument(briefId, 'Snapshot', 1, d.analysis),
  );
});

void test('print export escapes source markup and contains no executable or remote content', () => {
  const d = fixture();
  d.evidence[0].answer =
    '</p><script>alert(1)</script><img src="https://example.test/track">';
  d.analysis.decision = '<iframe src="https://example.test"></iframe>';
  const html = renderBriefPrintHtml('<img onerror="bad">', d);
  assert.ok(!/<script|<img|<iframe|onerror="bad"/.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Usage at save $0.000123'));
  assert.ok(html.includes('name="referrer" content="no-referrer"'));
});

void test('Markdown export escapes remote embeds and raw HTML in all owner and model text', () => {
  const d = fixture();
  d.evidence[0].answer =
    '![pixel](https://example.test/track)\n<img src="https://example.test/track">';
  d.analysis.decision = '<script>alert(1)</script>';
  const markdown = renderBriefMarkdown('Snapshot', d);
  assert.ok(!markdown.includes('![pixel]('));
  assert.ok(!markdown.includes('> <img'));
  assert.ok(!markdown.includes('> <script>'));
  assert.ok(markdown.includes('\\!\\[pixel\\]\\('));
});

void test('oversized Brief failures give actionable bounded copy instead of provider response details', async () => {
  const client = createWorkspaceClient({
    accountId: randomUUID(),
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'BRIEF_TOO_LARGE',
            message: 'Do not surface this raw diagnostic.',
          },
        },
        { status: 413 },
      ),
  });
  await assert.rejects(
    client.briefFromCalls({
      projectId: randomUUID(),
      title: 'Too long',
      callIds: [randomUUID()],
      idempotencyKey: randomUUID(),
    }),
    (error) =>
      error.code === 'BRIEF_TOO_LARGE' &&
      error.message.includes('24,000-character') &&
      !error.message.includes('raw diagnostic'),
  );
});

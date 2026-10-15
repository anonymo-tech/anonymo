import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkspaceClient,
  parseComparison,
  parseQuoteResponse,
  quotedInput,
  WorkspaceError,
  formatUsd6,
  formatFriendlyUsd6,
  effectiveReservationCap,
  projectTitleFromPrompt,
  parseCallSnapshot,
  isStoppingCall,
  CANCEL_DRAIN_TIMEOUT,
} from '../lib/client/workspace.ts';
import {
  comparisonTurn,
  mergeHistory,
  conversationItems,
  callHeading,
  streamedCalls,
  prepareWorkspaceRouting,
} from '../components/dashboard/use-live-workspace.ts';

const ids = Array.from(
  { length: 16 },
  (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
);
const now = '2026-10-10T00:00:00.000Z';
const routeCard = {
  level: 'unverified',
  reviewed: true,
  retentionDisclosure: 'Gateway and upstream receive plaintext.',
  evidenceUrl: 'https://ppq.ai/privacy',
  evidenceDate: now,
  plaintextVisibility: 'gateway_and_upstream',
  trainingUse: 'unknown',
  upstreamProviders: ['Example'],
};
const input = {
  projectId: ids[0],
  blind: false,
  items: [
    {
      routeVersionId: ids[1],
      messages: [{ role: 'user', content: 'A synthetic question.' }],
      maxOutputTokens: 100,
      privacy: 'standard',
    },
  ],
};
const quote = {
  quotes: [
    {
      id: ids[2],
      routeVersionId: ids[1],
      maximumUsd6: '1200',
      expiresAt: now,
      requestHash: 'a'.repeat(64),
      markupBps: 1000,
      modelId: 'example/model',
      family: 'claude',
      card: routeCard,
    },
  ],
  maximumUsd6: '1200',
};
const fixture = (overrides = {}) => ({
  id: ids[3],
  projectId: ids[0],
  prompt: input.items[0].messages[0].content,
  createdAt: now,
  blind: false,
  revealedAt: null,
  votedCallId: null,
  billing: { maximumUsd6: '1200', actualUsd6: null },
  calls: [
    {
      id: ids[4],
      label: 'Model A',
      position: 0,
      routeVersionId: ids[1],
      modelId: 'example/model',
      family: 'claude',
      state: 'queued',
      errorCode: null,
      output: '',
      outputTruncated: false,
      outputLength: 0,
      billing: { state: 'held', maximumUsd6: '1200', actualUsd6: null },
    },
  ],
  ...overrides,
});
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const clone = (value) => JSON.parse(JSON.stringify(value));

void test('same-origin credentials and expected account bind private requests; preview uses no protected requests', async () => {
  const requests = [];
  const client = createWorkspaceClient({
    accountId: ids[7],
    fetch: async (url, options) => {
      requests.push({ url, options });
      return json({
        mode: 'preview',
        chat: { configured: false, reason: 'PROVIDER_KEY_REQUIRED' },
      });
    },
  });
  assert.equal((await client.capabilities()).mode, 'preview');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/capabilities');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.mode, 'same-origin');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.headers['X-Conclave-Account-Id'], ids[7]);
});

void test('quote order, selected route, summed amount and unique quote identities are validated', () => {
  assert.equal(parseQuoteResponse(quote, input).maximumUsd6, '1200');
  assert.throws(
    () => parseQuoteResponse({ ...quote, maximumUsd6: '1201' }, input),
    WorkspaceError,
  );
  assert.throws(
    () =>
      parseQuoteResponse(
        { ...quote, quotes: [{ ...quote.quotes[0], routeVersionId: ids[8] }] },
        input,
      ),
    WorkspaceError,
  );
  assert.throws(
    () => parseQuoteResponse({ ...quote, maximumUsd6: '-1' }, input),
    WorkspaceError,
  );
  const duplicate = {
    quotes: [quote.quotes[0], quote.quotes[0]],
    maximumUsd6: '2400',
  };
  assert.throws(
    () =>
      parseQuoteResponse(duplicate, {
        ...input,
        items: [input.items[0], input.items[0]],
      }),
    WorkspaceError,
  );
  assert.equal(formatUsd6('1'), '$0.000001');
  assert.equal(formatUsd6('1000001'), '$1.000001');
  assert.equal(formatFriendlyUsd6('4945253'), '$4.94');
  assert.equal(formatFriendlyUsd6('0'), '$0.00');
  assert.equal(formatFriendlyUsd6('10000'), '$0.01');
  assert.equal(formatFriendlyUsd6('9999'), '$0.009999');
  assert.equal(formatFriendlyUsd6('830'), '$0.00083');
  assert.equal(formatFriendlyUsd6('1234567891'), '$1,234.56');
  assert.throws(() => formatFriendlyUsd6('-1'));
  assert.deepEqual(effectiveReservationCap('10000000', '4945253'), {
    usd6: '4945253',
    limitedByBalance: true,
  });
  assert.deepEqual(effectiveReservationCap('2000000', '4945253'), {
    usd6: '2000000',
    limitedByBalance: false,
  });
  assert.deepEqual(effectiveReservationCap('10000000', null), {
    usd6: '10000000',
    limitedByBalance: false,
  });
  assert.equal(projectTitleFromPrompt('  What year\n\nwas it?  '), 'What year was it?');
  const long = projectTitleFromPrompt(
    'How should I launch my notes app in two weeks without a marketing budget?',
  );
  assert.ok(Array.from(long).length <= 48);
  assert.equal(long, 'How should I launch my notes app in two weeks…');
  assert.equal(Array.from(projectTitleFromPrompt('🌍'.repeat(60))).length, 48);
});

void test('explicit approval payload snapshots inputs and retains original quote and key across interrupted replay', async () => {
  const original = clone(input),
    approval = quotedInput(original, quote, 'synthetic_request_0001');
  original.items[0].messages[0].content = 'Changed after review';
  assert.equal(
    approval.items[0].messages[0].content,
    input.items[0].messages[0].content,
  );
  const bodies = [];
  const client = createWorkspaceClient({
    fetch: async (_url, options) => {
      bodies.push(options.body);
      if (bodies.length === 1) throw new TypeError('private transport details');
      return json({ comparison: fixture(), replayed: true });
    },
  });
  await assert.rejects(
    client.submit(approval),
    (error) =>
      error.code === 'NETWORK_ERROR' &&
      !error.message.includes('private transport details'),
  );
  assert.equal(bodies.length, 1, 'no automatic billing retry');
  assert.equal((await client.submit(approval)).replayed, true);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).idempotencyKey, 'synthetic_request_0001');
  assert.equal(JSON.parse(bodies[1]).items[0].quoteId, ids[2]);
});

void test('submit checks owned project, prompt and requested comparison mode before accepting results', async () => {
  const approval = quotedInput(input, quote, 'synthetic_request_0002');
  for (const changed of [
    { projectId: ids[8] },
    { prompt: 'different' },
    { blind: true },
  ]) {
    const client = createWorkspaceClient({
      fetch: async () =>
        json({ comparison: fixture(changed), replayed: false }),
    });
    await assert.rejects(client.submit(approval), WorkspaceError);
  }
});

void test('raw model HTML remains literal text and native answers beyond the old 500k cap are preserved', () => {
  const value = fixture();
  value.calls[0].output = '<script>untrusted()</script>\n# Plain model text';
  value.calls[0].outputLength = value.calls[0].output.length;
  const turn = comparisonTurn(parseComparison(value));
  assert.deepEqual(turn.answers[0].paragraphs, [value.calls[0].output]);
  value.calls[0].output = 'x'.repeat(500000);
  value.calls[0].outputLength = 500000;
  assert.equal(parseComparison(value).calls[0].output.length, 500000);
  value.calls[0].output += 'x';
  value.calls[0].outputLength++;
  assert.equal(parseComparison(value).calls[0].output.length, 500001);
});

void test('blind identities and price fingerprints are rejected until reveal', () => {
  const blind = fixture({ blind: true });
  assert.throws(() => parseComparison(blind), WorkspaceError);
  Object.assign(blind.calls[0], {
    routeVersionId: null,
    modelId: null,
    family: null,
  });
  assert.throws(
    () => parseComparison(blind),
    WorkspaceError,
    'hidden per-call prices must be null',
  );
  blind.calls[0].billing.maximumUsd6 = null;
  assert.equal(parseComparison(blind).calls[0].billing.maximumUsd6, null);
  assert.equal(
    comparisonTurn(parseComparison(blind)).answers[0].modelId,
    'blind',
  );
  blind.calls[0].billing.actualUsd6 = '1';
  assert.throws(() => parseComparison(blind), WorkspaceError);
});

void test('paginated history sorts old/new turns and a preview never overwrites a full opened response', () => {
  const full = fixture();
  full.calls[0].output = 'Long complete result';
  full.calls[0].outputLength = full.calls[0].output.length;
  const preview = clone(full);
  preview.calls[0].output = 'Long';
  preview.calls[0].outputTruncated = true;
  const older = fixture({ id: ids[5], createdAt: '2026-10-09T00:00:00.000Z' });
  older.calls[0].id = ids[6];
  const newer = fixture({ id: ids[9], createdAt: '2026-10-11T00:00:00.000Z' });
  newer.calls[0].id = ids[10];
  const merged = mergeHistory(
    [comparisonTurn(parseComparison(full))],
    [parseComparison(newer), parseComparison(preview), parseComparison(older)],
  );
  assert.deepEqual(
    merged.map((turn) => turn.id),
    [ids[5], ids[3], ids[9]],
  );
  assert.equal(merged[1].answers[0].live.output, 'Long complete result');
  assert.equal(merged[1].answers[0].live.outputTruncated, false);
  assert.equal(
    comparisonTurn(parseComparison(preview)).answers[0].live.outputTruncated,
    true,
  );
  preview.calls[0].outputLength = 3;
  assert.throws(() => parseComparison(preview), WorkspaceError);
});

void test('account expiry clears through a typed 401 even if error body is malformed; response bodies are not surfaced', async () => {
  const client = createWorkspaceClient({
    fetch: async () =>
      json(
        { error: { code: 'ACCOUNT_CHANGED', message: 'private error body' } },
        401,
      ),
  });
  assert.equal(await client.session(), null);
  await assert.rejects(
    client.projects(),
    (error) =>
      error.status === 401 && !error.message.includes('private error body'),
  );
  const malformed = createWorkspaceClient({
    fetch: async () => new Response('<html>private</html>', { status: 401 }),
  });
  await assert.rejects(malformed.projects(), (error) => error.status === 401);
});

void test('aborted work is not sent and abort during response consumption cannot publish late data', async () => {
  let requests = 0;
  const controller = new AbortController();
  controller.abort();
  const client = createWorkspaceClient({
    signal: controller.signal,
    fetch: async () => {
      requests++;
      return json({});
    },
  });
  await assert.rejects(
    client.projects(),
    (error) => error.name === 'AbortError',
  );
  assert.equal(requests, 0);
  const later = new AbortController();
  const lateClient = createWorkspaceClient({
    signal: later.signal,
    fetch: async () => {
      later.abort();
      return json({ projects: [], nextCursor: null });
    },
  });
  await assert.rejects(
    lateClient.projects(),
    (error) => error.name === 'AbortError',
  );
});

void test('bounded JSON and pagination parsing reject oversized bodies, excessive entries and wrong projects', async () => {
  const oversized = createWorkspaceClient({
    fetch: async () =>
      new Response(' '.repeat(1048577), {
        headers: { 'content-type': 'application/json' },
      }),
  });
  await assert.rejects(
    oversized.capabilities(),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  const excessive = createWorkspaceClient({
    fetch: async () =>
      json({
        projects: Array.from({ length: 51 }, () => ({
          id: ids[0],
          title: 'Project',
          revision: 1,
        })),
        nextCursor: null,
      }),
  });
  await assert.rejects(excessive.projects(), WorkspaceError);
  const wrong = createWorkspaceClient({
    fetch: async () =>
      json({ comparisons: [fixture({ projectId: ids[8] })], nextCursor: null }),
  });
  await assert.rejects(wrong.comparisons(ids[0]), WorkspaceError);
});

function sse(chunks) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
void test('owned call stream parses chunk boundaries and captures expected account header without creating requests', async () => {
  const snapshots = [],
    calls = [];
  const call = fixture().calls[0];
  const payload = `event: snapshot\ndata: ${JSON.stringify(call)}\n\nevent: complete\ndata: {"id":"${call.id}"}\n\n`;
  const client = createWorkspaceClient({
    accountId: ids[7],
    fetch: async (url, options) => {
      calls.push({ url, options });
      return sse([payload.slice(0, 55), payload.slice(55)]);
    },
  });
  await client.streamCall(call.id, (value) => snapshots.push(value));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].id, call.id);
  assert.equal(calls[0].url, `/api/calls/${call.id}/events`);
  assert.equal(calls[0].options.headers['X-Conclave-Account-Id'], ids[7]);
  assert.equal(calls.length, 1);
});

void test('cancelRequested is optional, boolean-only and carried into turns; opaque SSE ids are ignored', async () => {
  const call = fixture().calls[0];
  assert.equal(parseCallSnapshot(call).cancelRequested, false);
  const draining = {
    ...call,
    state: 'running',
    output: 'Frozen partial',
    outputLength: 14,
    billing: { state: 'running', maximumUsd6: '1200', actualUsd6: null },
    cancelRequested: true,
  };
  assert.equal(parseCallSnapshot(draining).cancelRequested, true);
  assert.throws(
    () => parseCallSnapshot({ ...call, cancelRequested: 'yes' }),
    WorkspaceError,
  );
  const comparison = parseComparison(fixture({ calls: [draining] }));
  assert.equal(comparison.calls[0].cancelRequested, true);
  const turn = comparisonTurn(comparison);
  assert.equal(turn.answers[0].live.cancelRequested, true);
  assert.equal(turn.answers[0].heading, '');
  assert.equal(isStoppingCall(comparison.calls[0]), true);
  assert.equal(
    isStoppingCall({ state: 'cancelled', cancelRequested: true }),
    false,
  );
  assert.equal(
    callHeading({ state: 'running', output: '', cancelRequested: true }),
    'Stopping response',
  );
  assert.equal(
    callHeading({ state: 'running', output: '', cancelRequested: false }),
    'Generating response',
  );
  assert.equal(
    callHeading({
      state: 'reconciliation_pending',
      output: '',
      errorCode: CANCEL_DRAIN_TIMEOUT,
    }),
    'Stopped · settlement under review',
  );
  const settled = {
    ...draining,
    state: 'cancelled',
    billing: { state: 'captured', maximumUsd6: '1200', actualUsd6: '317' },
  };
  const snapshots = [];
  const payload =
    `id: 12.4\nevent: snapshot\ndata: ${JSON.stringify(draining)}\n\n` +
    `id: 13.5\nevent: snapshot\ndata: ${JSON.stringify(settled)}\n\n` +
    `id: 13.5\nevent: complete\ndata: {"id":"${call.id}"}\n\n`;
  const client = createWorkspaceClient({
    fetch: async () => sse([payload.slice(0, 31), payload.slice(31)]),
  });
  await client.streamCall(call.id, (value) => snapshots.push(value));
  assert.deepEqual(
    snapshots.map((value) => [
      value.state,
      value.cancelRequested,
      value.billing.actualUsd6,
    ]),
    [
      ['running', true, null],
      ['cancelled', true, '317'],
    ],
  );
});

void test('a stopping turn never blocks a new turn, keeps its stream slot only when free, and is not context', () => {
  const answer = (callId, family, state, cancelRequested) => ({
    id: callId,
    modelId: family,
    heading: '',
    paragraphs: ['Partial'],
    live: {
      callId,
      state,
      errorCode: null,
      billing: { state: 'running', maximumUsd6: '1200', actualUsd6: null },
      output: 'Partial',
      outputTruncated: false,
      outputLength: 7,
      cancelRequested,
    },
  });
  const turn = (id, answers) => ({
    id,
    prompt: `Question ${id}`,
    live: { comparisonId: id, blind: false, createdAt: now },
    answers,
  });
  const stopped = turn('turn-stopped', [
    answer(ids[1], 'claude', 'running', true),
    answer(ids[2], 'gemini', 'running', true),
    answer(ids[3], 'qwen', 'queued', true),
  ]);
  const room = {
    id: ids[0],
    name: 'Owned',
    pinned: false,
    updatedAt: 0,
    draft: '',
    selectedModels: ['claude'],
    live: { revision: 1 },
    turns: [stopped],
  };
  // All draining calls stream while slots are free.
  assert.equal(streamedCalls(room).split(',').length, 3);
  // A new turn keeps every generating call live; stopping calls take what remains.
  const newer = turn('turn-new', [
    answer(ids[4], 'claude', 'running', false),
    answer(ids[5], 'gemini', 'queued', false),
  ]);
  const both = streamedCalls({ ...room, turns: [stopped, newer] }).split(',');
  assert.equal(both.length, 4);
  assert.ok(both.includes(`turn-new:${ids[4]}`));
  assert.ok(both.includes(`turn-new:${ids[5]}`));
  // Stopping the newest turn does not starve an older turn that is still generating.
  const older = turn('turn-old', [answer(ids[6], 'claude', 'running', false)]);
  const newestStopped = turn('turn-newest', [
    answer(ids[7], 'claude', 'running', true),
    answer(ids[8], 'gemini', 'running', true),
    answer(ids[9], 'qwen', 'running', true),
    answer(ids[10], 'llama', 'running', true),
  ]);
  assert.ok(
    streamedCalls({ ...room, turns: [older, newestStopped] })
      .split(',')
      .includes(`turn-old:${ids[6]}`),
  );
  // Preparing the next question succeeds while the earlier turn drains, and
  // the stopping reply is left out of its context until it settles.
  const route = {
    versionId: ids[11],
    id: 'route-claude',
    version: 1,
    modelId: 'claude/model',
    family: 'claude',
    modality: 'chat',
    available: true,
    expiresAt: new Date(Date.parse(now) + 3600000).toISOString(),
    card: routeCard,
    pricing: {
      inputPerMillionUsd6: '100',
      outputPerMillionUsd6: '200',
      markupBps: 0,
      maxOutputTokens: 2048,
      maxInputBytes: 32768,
    },
  };
  const plan = prepareWorkspaceRouting(
    room,
    'Next question',
    ['claude'],
    [route],
    undefined,
    Date.parse(now),
  );
  assert.deepEqual(plan.conversation.items[0].messages, [
    { role: 'user', content: 'Next question' },
  ]);
  assert.deepEqual(plan.conversation.contexts[0].omittedReasons, {
    stopping: 1,
  });
});

void test('stream unavailable, wrong call and oversized events fail without applying another call’s result', async () => {
  let applied = 0;
  for (const payload of [
    'event: unavailable\ndata: {"code":"STREAM_UNAVAILABLE"}\n\n',
    `event: snapshot\ndata: ${JSON.stringify(fixture().calls[0])}\n\n`,
    'x'.repeat(4 * 1024 * 1024 + 1),
  ]) {
    const client = createWorkspaceClient({ fetch: async () => sse([payload]) });
    await assert.rejects(
      client.streamCall(ids[11], () => applied++),
      WorkspaceError,
    );
  }
  assert.equal(applied, 0);
});

void test('revisioned project and Brief deletion use fixed owned endpoints and exact revision', async () => {
  const calls = [];
  const client = createWorkspaceClient({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return json(
        url.includes('projects') ? { archived: true } : { deleted: true },
      );
    },
  });
  await client.archiveProject(ids[0], 7);
  await client.deleteBrief(ids[2], 9);
  assert.deepEqual(
    calls.map((call) => [
      call.url,
      call.options.method,
      JSON.parse(call.options.body),
    ]),
    [
      [`/api/projects/${ids[0]}`, 'DELETE', { revision: 7 }],
      [`/api/briefs/${ids[2]}`, 'DELETE', { revision: 9 }],
    ],
  );
  await assert.rejects(
    client.archiveProject('../../outside', 1),
    WorkspaceError,
  );
  assert.equal(calls.length, 2);
});

void test('continuity uses only complete succeeded live replies from the matching family and reports exclusions', () => {
  const complete = fixture();
  complete.calls[0].state = 'succeeded';
  complete.calls[0].output = 'Owned reply.';
  complete.calls[0].outputLength = 12;
  const saved = comparisonTurn(parseComparison(complete));
  const room = {
    id: ids[0],
    name: 'Owned',
    pinned: false,
    updatedAt: 0,
    draft: '',
    selectedModels: ['claude'],
    live: { revision: 1, historyCursor: 'older-history' },
    turns: [
      { id: 'local-sample', prompt: 'Never send local sample', answers: [] },
      saved,
    ],
  };
  const route = {
    versionId: ids[1],
    family: 'claude',
    pricing: { maxInputBytes: 32768, maxOutputTokens: 2048 },
  };
  const result = conversationItems(room, 'Follow up', [route]);
  assert.deepEqual(result.items[0].messages, [
    { role: 'user', content: input.items[0].messages[0].content },
    { role: 'assistant', content: 'Owned reply.' },
    { role: 'user', content: 'Follow up' },
  ]);
  assert.deepEqual(result.contexts[0], {
    family: 'claude',
    includedExchanges: 1,
    omittedExchanges: 0,
    omittedReasons: {},
    olderHistoryNotLoaded: true,
  });
  for (const [variant, reason] of [
    [
      { ...saved, live: { ...saved.live, blind: true, revealedAt: null } },
      'blind',
    ],
    [
      {
        ...saved,
        answers: [
          {
            ...saved.answers[0],
            live: { ...saved.answers[0].live, state: 'failed' },
          },
        ],
      },
      'unfinished',
    ],
    [
      {
        ...saved,
        answers: [
          {
            ...saved.answers[0],
            live: { ...saved.answers[0].live, outputTruncated: true },
          },
        ],
      },
      'notLoaded',
    ],
    [
      { ...saved, answers: [{ ...saved.answers[0], modelId: 'gemini' }] },
      'otherModel',
    ],
  ]) {
    const excluded = conversationItems(
      { ...room, turns: [variant] },
      'Follow up',
      [route],
    );
    assert.equal(excluded.items[0].messages.length, 1);
    assert.equal(excluded.contexts[0].omittedExchanges, 1);
    assert.deepEqual(excluded.contexts[0].omittedReasons, { [reason]: 1 });
  }
  for (const [state, reason] of [
    ['running', 'inProgress'],
    ['reconciliation_pending', 'unsettled'],
    ['cancelled', 'unfinished'],
  ]) {
    const pending = {
      ...saved,
      answers: [
        { ...saved.answers[0], live: { ...saved.answers[0].live, state } },
      ],
    };
    assert.deepEqual(
      conversationItems({ ...room, turns: [pending] }, 'Follow up', [route])
        .contexts[0].omittedReasons,
      { [reason]: 1 },
    );
  }
  assert.equal(
    conversationItems({ ...room, live: undefined }, 'Follow up', [route])
      .items[0].messages.length,
    1,
  );
});

void test('continuity retains all complete exchanges and refuses oversized context without silent clipping', () => {
  const template = fixture();
  template.calls[0].state = 'succeeded';
  template.calls[0].output = 'Reply';
  template.calls[0].outputLength = 5;
  const room = {
    id: ids[0],
    name: 'Owned',
    pinned: false,
    updatedAt: 0,
    draft: '',
    selectedModels: ['claude'],
    live: { revision: 1 },
    turns: Array.from({ length: 30 }, (_, i) => {
      const turn = comparisonTurn(parseComparison(template));
      turn.id = `turn-${i}`;
      turn.live.comparisonId = turn.id;
      return turn;
    }),
  };
  const route = {
    versionId: ids[1],
    family: 'claude',
    pricing: { maxInputBytes: 32768, maxOutputTokens: 100 },
  };
  const result = conversationItems(room, 'Newest question', [route]);
  assert.equal(result.items[0].messages.length, 61);
  assert.equal(result.contexts[0].includedExchanges, 30);
  assert.equal(result.contexts[0].omittedExchanges, 0);
  assert.deepEqual(result.contexts[0].omittedReasons, {});
  assert.equal(result.items[0].messages.at(-1).content, 'Newest question');
  assert.throws(() => conversationItems(room, 'Newest question', [
    { ...route, pricing: { ...route.pricing, maxInputBytes: 20 } },
  ]), error => error.code === 'PROMPT_TOO_LARGE');
  assert.throws(
    () =>
      conversationItems(room, '🌍🌍🌍🌍🌍🌍', [
        { ...route, pricing: { ...route.pricing, maxInputBytes: 20 } },
      ]),
    WorkspaceError,
  );
});

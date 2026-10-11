import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkspaceClient,
  assertRoutingBudget,
  parseAutoRouteQuote,
  parseRoute,
  quotedInput,
  routingBudgetUsd6,
} from '../lib/client/workspace.ts';
import {
  prepareWorkspaceRouting,
  comparisonTurn,
} from '../components/dashboard/use-live-workspace.ts';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 10),
  date = new Date(now).toISOString();
const routes = ['claude', 'gemini', 'qwen'].map((family, i) => ({
  versionId: uuid(i + 1),
  id: `route-${family}`,
  version: 1,
  modelId: `${family}/model`,
  family,
  modality: 'chat',
  available: true,
  expiresAt: new Date(now + 3600000).toISOString(),
  card: {
    level: 'standard',
    reviewed: true,
    retentionDisclosure: 'Gateway and provider read plaintext.',
    evidenceUrl: 'https://example.com/privacy',
    evidenceDate: date,
    plaintextVisibility: 'gateway_and_upstream',
    trainingUse: 'unknown',
    upstreamProviders: ['Example'],
    routing: {
      version: 1,
      tasks: ['general', 'code', 'long_context'],
      evidenceUrl: 'https://example.com/models',
      reviewedAt: date,
    },
  },
  pricing: {
    inputPerMillionUsd6: '100',
    outputPerMillionUsd6: '200',
    markupBps: 0,
    maxOutputTokens: 4096,
    maxInputBytes: 32768,
  },
}));
const room = {
  id: uuid(10),
  name: 'Project',
  pinned: false,
  updatedAt: now,
  draft: '',
  selectedModels: ['claude'],
  turns: [],
  live: { revision: 1, historyCursor: null },
};
const prefs = { mode: 'auto', task: 'code', budgetUsd: '0.003' };
const build = (
  prompt = 'Review this function.',
  selected = ['claude'],
  catalog = routes,
  preferences = prefs,
) => prepareWorkspaceRouting(room, prompt, selected, catalog, preferences, now);
const input = () => ({
  projectId: room.id,
  task: 'code',
  privacy: 'standard',
  budgetUsd6: '3000',
  candidates: build().conversation.items,
});
const response = () => ({
  quotes: [
    {
      id: uuid(20),
      routeVersionId: routes[1].versionId,
      maximumUsd6: '1000',
      expiresAt: new Date(now + 120000).toISOString(),
      requestHash: 'a'.repeat(64),
      markupBps: 0,
      modelId: routes[1].modelId,
      family: 'gemini',
      card: routes[1].card,
    },
  ],
  maximumUsd6: '1000',
  recommendation: {
    version: 1,
    task: 'code',
    routeVersionId: routes[1].versionId,
    eligibleCount: 3,
    maximumUsd6: '1000',
    reason: 'Lowest maximum among the reviewed supplied candidates.',
  },
});
const copy = (value) => structuredClone(value);

void test('manual remains the default and preserves selected family order and context semantics', () => {
  const plan = prepareWorkspaceRouting(
    room,
    'A question',
    ['gemini', 'claude'],
    routes,
    undefined,
    now,
  );
  assert.equal(plan.auto, null);
  assert.deepEqual(
    plan.routes.map((route) => route.family),
    ['gemini', 'claude'],
  );
  assert.deepEqual(
    plan.conversation.items.map((item) => item.routeVersionId),
    [routes[1].versionId, routes[0].versionId],
  );
});

void test('known and exact model mentions override Auto without changing stored manual selections', () => {
  const selected = ['claude'],
    before = copy(room);
  const plan = build(
    'Please @gemini ask @{qwen/model} to review this.',
    selected,
  );
  assert.equal(plan.auto, null);
  assert.equal(plan.overridesAuto, true);
  assert.deepEqual(
    plan.routes.map((route) => route.versionId),
    [routes[1].versionId, routes[2].versionId],
  );
  assert.equal(plan.prompt, 'Please  ask  to review this.');
  assert.deepEqual(selected, ['claude']);
  assert.deepEqual(room, before);
});

void test('indented first-line code survives the integration without becoming a routing command', () => {
  for (const prompt of [
    '    @gemini is a code value',
    '\t@gemini is a code value',
    '`@gemini` is literal',
    'mail person@gemini.example and see https://example.com/@gemini',
  ]) {
    const plan = build(prompt, ['claude'], routes, {
      ...prefs,
      mode: 'manual',
    });
    assert.equal(plan.mentions.length, 0);
    assert.equal(plan.routes[0].family, 'claude');
  }
});

void test('unavailable or unknown explicit mentions stop before an Auto fallback', () => {
  for (const prompt of ['@{unknown/model} Review it', '@gpt Review it'])
    assert.throws(
      () => build(prompt),
      (error) => error.code === 'MODEL_MENTION_UNAVAILABLE',
    );
  const unavailable = copy(routes);
  unavailable[1].available = false;
  assert.throws(
    () => build('@gemini Review it', ['claude'], unavailable),
    (error) => error.code === 'MODEL_MENTION_UNAVAILABLE',
  );
});

void test('Auto uses task-reviewed fresh candidates with equal output limits and never silently lowers them', () => {
  const catalog = copy(routes);
  catalog[0].pricing.maxOutputTokens = 1024;
  catalog[2].card.routing.tasks = ['writing'];
  const plan = build('A question', ['claude'], catalog);
  assert.deepEqual(
    plan.routes.map((route) => route.family),
    ['gemini'],
  );
  assert.equal(plan.conversation.items[0].maxOutputTokens, 2048);
  assert.equal(plan.auto.budgetUsd6, '3000');
  for (const mutate of [
    (r) => delete r.card.routing,
    (r) => (r.card.routing.reviewedAt = new Date(now - 86400001).toISOString()),
    (r) => (r.card.routing.tasks = ['writing']),
    (r) => (r.pricing.maxOutputTokens = 1000),
  ]) {
    const changed = copy(routes);
    changed.forEach(mutate);
    assert.throws(
      () => build('A question', ['claude'], changed),
      (error) => error.code === 'AUTO_ROUTE_UNAVAILABLE',
    );
  }
});

void test('Auto prices bounded family context and reports omitted or unloaded history per candidate', () => {
  const turnId = uuid(30),
    r = copy(room);
  r.live.historyCursor = 'opaque';
  r.turns = [
    {
      id: turnId,
      prompt: 'Earlier question',
      live: { comparisonId: turnId },
      answers: [
        {
          id: uuid(31),
          modelId: 'claude',
          heading: '',
          paragraphs: ['Answer'],
          live: {
            state: 'succeeded',
            outputTruncated: false,
            output: 'Complete answer',
          },
        },
      ],
    },
  ];
  const plan = prepareWorkspaceRouting(
    r,
    'Follow up',
    ['claude'],
    routes,
    prefs,
    now,
  );
  assert.equal(plan.conversation.items[0].messages.length, 3);
  assert.equal(plan.conversation.items[1].messages.length, 1);
  assert.equal(plan.conversation.contexts[0].includedExchanges, 1);
  assert.equal(plan.conversation.contexts[1].omittedExchanges, 1);
  assert.equal(plan.conversation.contexts[0].olderHistoryNotLoaded, true);
});

void test('decimal budget conversion is exact and bounded without floating point rounding', () => {
  assert.equal(routingBudgetUsd6(''), '10000000');
  assert.equal(routingBudgetUsd6('0.000001'), '1');
  assert.equal(routingBudgetUsd6('0.123456'), '123456');
  assert.equal(routingBudgetUsd6('10.000000'), '10000000');
  for (const amount of [
    '0',
    '-1',
    '10.000001',
    '0.0000001',
    '1e-3',
    '01',
    '.5',
    ' 1',
    'Infinity',
  ])
    assert.throws(() => routingBudgetUsd6(amount));
});

void test('Auto quote binds owner header, one server-selected supplied route and exact budget', async () => {
  let called;
  const client = createWorkspaceClient({
    accountId: uuid(40),
    fetch: async (url, options) => {
      called = { url, options };
      return Response.json(response());
    },
  });
  const result = await client.autoQuote(input());
  assert.equal(called.url, '/api/auto-route-quotes');
  assert.equal(called.options.headers['X-Conclave-Account-Id'], uuid(40));
  assert.equal(called.options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(called.options.body), input());
  assert.equal(result.quotes.length, 1);
  assert.equal(result.recommendation.routeVersionId, routes[1].versionId);
});

void test('foreign recommendations, changed tasks, counts, prices or response order cannot become approval', () => {
  for (const mutate of [
    (r) => (r.recommendation.routeVersionId = uuid(90)),
    (r) => (r.recommendation.task = 'writing'),
    (r) => (r.recommendation.eligibleCount = 4),
    (r) => (r.recommendation.maximumUsd6 = '1001'),
    (r) => (r.quotes[0].routeVersionId = routes[0].versionId),
    (r) => (r.recommendation.version = 2),
    (r) => {
      r.maximumUsd6 = '3001';
      r.quotes[0].maximumUsd6 = '3001';
      r.recommendation.maximumUsd6 = '3001';
    },
  ]) {
    const value = response();
    mutate(value);
    assert.throws(() => parseAutoRouteQuote(value, input()));
  }
});

void test('mismatched candidate questions, output limits, duplicate versions and oversized roster fail before dispatch', async () => {
  let sent = 0;
  const client = createWorkspaceClient({
    accountId: uuid(40),
    fetch: async () => {
      sent++;
      return Response.json(response());
    },
  });
  for (const mutate of [
    (v) => (v.candidates[1].messages[0].content = 'Changed'),
    (v) => (v.candidates[1].maxOutputTokens = 1024),
    (v) => (v.candidates[1].privacy = 'sealed'),
    (v) => v.candidates.push(v.candidates[0]),
    (v) =>
      (v.candidates = Array.from({ length: 17 }, (_, i) => ({
        ...v.candidates[0],
        routeVersionId: uuid(50 + i),
      }))),
    (v) => (v.budgetUsd6 = '10000001'),
    (v) => (v.candidates[0].maxOutputTokens = 1.5),
  ]) {
    const value = input();
    mutate(value);
    await assert.rejects(() => client.autoQuote(value));
  }
  assert.equal(sent, 0);
});

void test('recommended approval snapshots only chosen original candidate and retains key through interruption', async () => {
  const raw = input(),
    result = parseAutoRouteQuote(response(), raw);
  const chosen = raw.candidates.find(
    (item) => item.routeVersionId === result.recommendation.routeVersionId,
  );
  const approved = quotedInput(
    { projectId: raw.projectId, blind: false, items: [chosen] },
    result,
    'synthetic-auto-approval',
  );
  chosen.messages[0].content = 'Changed after review';
  assert.equal(approved.items.length, 1);
  assert.equal(approved.items[0].messages[0].content, 'Review this function.');
  const bodies = [];
  const client = createWorkspaceClient({
    accountId: uuid(40),
    fetch: async (_url, options) => {
      bodies.push(options.body);
      throw new Error('synthetic interruption');
    },
  });
  await assert.rejects(() => client.submit(approved));
  assert.equal(bodies.length, 1);
  await assert.rejects(() => client.submit(approved));
  assert.equal(bodies[0], bodies[1]);
});

void test('routing metadata remains optional for Manual and rejects malformed claims when present', () => {
  const plain = copy(routes[0]);
  delete plain.card.routing;
  assert.equal(parseRoute(plain).card.routing, undefined);
  const malformed = copy(routes[0]);
  malformed.card.routing.tasks = ['vision'];
  assert.throws(() => parseRoute(malformed));
});

void test('Grok and other reviewed live families participate in mentions and Auto without static brand definitions', () => {
  const grok = {
    ...copy(routes[0]),
    versionId: uuid(70),
    id: 'grok-route',
    family: 'grok',
    modelId: 'x-ai/grok-test',
  };
  const newer = {
    ...copy(routes[0]),
    versionId: uuid(71),
    id: 'new-route',
    family: 'newfamily',
    modelId: 'new-provider/model',
  };
  const catalog = [...routes, grok, newer];
  assert.equal(
    build('@grok Review it', ['claude'], catalog).routes[0].versionId,
    grok.versionId,
  );
  assert.equal(
    build('@{new-provider/model} Review it', ['claude'], catalog).routes[0]
      .versionId,
    newer.versionId,
  );
  assert.equal(build('Review it', ['claude'], catalog).routes.length, 5);
  const turn = comparisonTurn({
    id: uuid(72),
    projectId: room.id,
    prompt: 'Question',
    createdAt: date,
    blind: false,
    revealedAt: null,
    votedCallId: null,
    billing: { maximumUsd6: '100', actualUsd6: '10' },
    calls: [
      {
        id: uuid(73),
        label: 'Model A',
        position: 0,
        family: newer.family,
        modelId: newer.modelId,
        routeVersionId: newer.versionId,
        state: 'succeeded',
        output: 'Answer',
        errorCode: null,
        outputTruncated: false,
        outputLength: 6,
        billing: { state: 'captured', maximumUsd6: '100', actualUsd6: '10' },
      },
    ],
  });
  assert.equal(turn.answers[0].modelId, 'newfamily');
  assert.equal(turn.answers[0].live.modelName, 'new-provider/model');
});

void test('Auto never silently drops a reviewed seventeenth eligible candidate', () => {
  const catalog = Array.from({ length: 17 }, (_, index) => ({
    ...copy(routes[0]),
    versionId: uuid(100 + index),
    modelId: `test/model-${index}`,
    family: `family-${index}`,
  }));
  assert.throws(
    () => build('Review it', ['claude'], catalog),
    (error) => error.code === 'AUTO_ROUTE_LIMIT',
  );
});

void test('mentions keep the Auto reservation budget and reject an excessive manual aggregate before approval', () => {
  const plan = build('@claude @gemini Review it', ['qwen'], routes, {
    ...prefs,
    budgetUsd: '0.0002',
  });
  assert.equal(plan.auto, null);
  assert.equal(plan.budgetUsd6, '200');
  assert.doesNotThrow(() => assertRoutingBudget('200', plan.budgetUsd6));
  assert.throws(
    () => assertRoutingBudget('201', plan.budgetUsd6),
    (error) => error.code === 'ROUTING_BUDGET_EXCEEDED',
  );
  assert.equal(
    build('@claude Review it', ['qwen'], routes, { ...prefs, mode: 'manual' })
      .budgetUsd6,
    null,
  );
});

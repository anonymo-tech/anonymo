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

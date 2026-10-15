import assert from 'node:assert/strict';
import test from 'node:test';
import { FEATURE_SWITCHES } from '../components/dashboard/feature-switches.ts';
import { MODELS } from '../components/dashboard/data.ts';
import {
  BASE_CHAT_MODELS,
  MORE_CHAT_MODELS,
  modelReleased,
  releasedModelSelection,
  releasedChatFamilies,
} from '../lib/model-release.ts';
import {
  initialWorkspace,
  parseWorkspace,
  createSampleTurn,
} from '../components/dashboard/canvas-state.ts';
import { assertUsableRoute } from '../server/routes/call-contract.ts';
import { modelForFamily } from '../server/ppq/catalog.ts';
import { assertEndpointReleased } from '../server/core/feature-release.ts';

const allFamilies = [...BASE_CHAT_MODELS, ...MORE_CHAT_MODELS];
const route = (family) => ({
  id: crypto.randomUUID(),
  family,
  model_id: modelForFamily(family),
  enabled: true,
  fresh: true,
  modality: 'chat',
  card: {
    reviewed: true,
    retentionDisclosure: 'Reviewed retention terms',
    evidenceUrl: 'https://example.com/review',
    evidenceDate: '2026-10-14',
  },
});

test('all approved families are selectable and exact routes are usable', () => {
  assert.equal(FEATURE_SWITCHES.moreModels, true);
  assert.deepEqual(
    MODELS.filter((m) => modelReleased(m.id)).map((m) => m.id),
    allFamilies,
  );
  assert.deepEqual(releasedChatFamilies(), allFamilies);
  for (const id of allFamilies) {
    assert.equal(
      createSampleTurn('A local test question', [id]).answers[0].modelId,
      id,
    );
    assert.doesNotThrow(() => assertUsableRoute(route(id)));
  }
  assert.equal(modelReleased('unknown'), false);
});

test('closing the switch restores four-family policy without erasing history', () => {
  const original = FEATURE_SWITCHES.moreModels;
  try {
    FEATURE_SWITCHES.moreModels = false;
    assert.deepEqual(releasedChatFamilies(), [...BASE_CHAT_MODELS]);
    for (const id of MORE_CHAT_MODELS) {
      assert.throws(
        () => createSampleTurn('A local test question', [id]),
        RangeError,
      );
      assert.throws(
        () => assertUsableRoute(route(id)),
        (error) => error.code === 'ROUTE_UNAVAILABLE',
      );
    }
    const saved = initialWorkspace();
    saved.rooms[0].selectedModels = ['deepseek', 'gpt'];
    saved.rooms[0].turns[0].answers[0].modelId = 'deepseek';
    assert.deepEqual(parseWorkspace(JSON.parse(JSON.stringify(saved))), saved);
    assert.deepEqual(releasedModelSelection(saved.rooms[0].selectedModels), [
      'gpt',
    ]);
    assert.deepEqual(releasedModelSelection(['qwen', 'llama']), [
      'claude',
      'gemini',
    ]);
  } finally {
    FEATURE_SWITCHES.moreModels = original;
  }
});

test('new selections retain approved additions and discard unknown models', () => {
  assert.deepEqual(releasedModelSelection(['deepseek', 'gpt']), [
    'deepseek',
    'gpt',
  ]);
  assert.deepEqual(releasedModelSelection(['qwen', 'llama', 'unknown']), [
    'qwen',
    'llama',
  ]);
  assert.deepEqual(releasedModelSelection(['unknown']), ['claude', 'gemini']);
});

test('More choices do not increase four-model comparison limit', () => {
  assert.throws(
    () => createSampleTurn('A local test question', allFamilies.slice(0, 5)),
    RangeError,
  );
  assert.equal(
    createSampleTurn('A local test question', [
      'deepseek',
      'qwen',
      'llama',
      'gpt',
    ]).answers.length,
    4,
  );
});

test('family labels cannot alias another pinned model and held endpoints remain blocked', () => {
  for (const id of allFamilies) {
    assert.throws(
      () => assertUsableRoute({ ...route(id), model_id: 'unreviewed-latest' }),
      (error) => error.code === 'ROUTE_UNAVAILABLE',
    );
    const other = allFamilies.find((family) => family !== id);
    assert.throws(
      () =>
        assertUsableRoute({ ...route(id), model_id: modelForFamily(other) }),
      (error) => error.code === 'ROUTE_UNAVAILABLE',
    );
  }
  for (const path of [
    'second-look/capabilities',
    'token',
  ])
    assert.throws(
      () => assertEndpointReleased(path),
      (error) => error.code === 'FEATURE_UNAVAILABLE',
    );
});

test('new hosted choices do not claim zero retention, private or sealed transport', () => {
  for (const model of MODELS.filter((m) => MORE_CHAT_MODELS.includes(m.id))) {
    assert.equal(model.kind, 'Hosted');
    assert.equal(model.level, 'UNVERIFIED');
    assert.doesNotMatch(model.specialty, /Sanctum|sealed|zero.retention/i);
  }
});

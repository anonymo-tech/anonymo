import assert from 'node:assert/strict';
import { CHAT_CAPACITY, CHAT_LIMITS } from '../lib/chat-limits.ts';
import test from 'node:test';
import { FEATURE_SWITCHES } from '../components/dashboard/feature-switches.ts';
import {
  BASE_CHAT_MODELS,
  releasedChatFamilies,
} from '../lib/model-release.ts';
import {
  baselineCatalogDocument,
  refreshBaselineRoutes,
} from '../server/routes/baseline-catalog.ts';
import { PPQ_MODEL_ALLOWLIST } from '../server/ppq/catalog.ts';
import { normalizeCatalog } from '../server/ppq/catalog.ts';
import { parseProviderJson } from '../server/ppq/codec.ts';
import { CHINESE_CHAT_MODELS } from '../lib/chinese-models.ts';
import { ROUTE_CATALOG_URL } from '../server/routes/route-registry.ts';
const prices = {
  ...Object.fromEntries(releasedChatFamilies().map(family => [family, [100000, 300000]])),
  claude: [4220000, 21100000],
  gpt: [2110000, 10550000],
  gemini: [1000000, 6000000],
  grok: [2110000, 6330000],
  deepseek: [696300, 2088900],
  qwen: [2110000, 6330000],
  llama: [189900, 622450],
};
const catalog = () => ({
  sourceUrl: ROUTE_CATALOG_URL,
  fetchedAt: new Date().toISOString(),
  sha256: 'a'.repeat(64),
  models: Object.entries(prices).map(([family, [input, output]]) => ({
    id: PPQ_MODEL_ALLOWLIST[family].id,
    family,
    modality: 'chat',
    contextLength: 1310720,
    pricing: { inputPerMillionUsd6: input, outputPerMillionUsd6: output },
  })),
});

test('registry installs all released exact models with catalog prices and conservative privacy', () => {
  const source = catalog();
  const document = baselineCatalogDocument(
    source,
    new Map(BASE_CHAT_MODELS.map((family) => [family, 7])),
  );
  assert.deepEqual(
    document.routes.map((route) => route.family),
    releasedChatFamilies(),
  );
  for (const route of document.routes) {
    assert.equal(route.modelId, PPQ_MODEL_ALLOWLIST[route.family].id);
    assert.equal(
      route.version,
      BASE_CHAT_MODELS.includes(route.family) ? 8 : 1,
    );
    assert.equal(
      route.pricing.inputPerMillionUsd6,
      String(prices[route.family][0]),
    );
    assert.equal(
      route.pricing.outputPerMillionUsd6,
      String(prices[route.family][1]),
    );
    assert.equal(route.pricing.markupBps, 0);
    assert.equal(route.pricing.maxOutputTokens, CHAT_CAPACITY[route.family].outputTokens);
    assert.equal(route.card.level, 'unverified');
    assert.equal(route.card.retentionDays, null);
    assert.equal(route.card.trainingUse, 'unknown');
    assert.equal(route.card.plaintextVisibility, 'gateway_and_upstream');
    assert.deepEqual(route.card.routing.tasks, ['general']);
    assert.equal(route.card.routing.version,1);
    assert.match(route.card.retentionDisclosure, /does not verify privacy/);
    assert.ok(
      Date.parse(route.expiresAt) - Date.parse(source.fetchedAt) < 86400000,
    );
  }
});

test('missing, duplicate, mismatched or unpriced added models fail closed', () => {
  for (const family of ['deepseek', 'qwen', 'llama'])
    for (const mutate of [
      (source) => {
        source.models = source.models.filter(
          (model) => model.family !== family,
        );
      },
      (source) =>
        source.models.push(
          source.models.find((model) => model.family === family),
        ),
      (source) => {
        source.models.find((model) => model.family === family).id = '~latest';
      },
      (source) => {
        source.models.find(
          (model) => model.family === family,
        ).pricing.outputPerMillionUsd6 = null;
      },
    ]) {
      const source = catalog();
      mutate(source);
      assert.throws(() => baselineCatalogDocument(source, new Map()));
    }
});

test('closing More models prevents registry from creating additional routes', () => {
  const original = FEATURE_SWITCHES.moreModels;
  try {
    FEATURE_SWITCHES.moreModels = false;
    assert.deepEqual(
      baselineCatalogDocument(catalog(), new Map()).routes.map(
        (route) => route.family,
      ),
      [...BASE_CHAT_MODELS],
    );
  } finally {
    FEATURE_SWITCHES.moreModels = original;
  }
});

test('withdrawn optional variants do not block the existing released models', () => {
  const optional = CHINESE_CHAT_MODELS.find(model => !['deepseek', 'qwen'].includes(model.key));
  const source = catalog();
  source.models = source.models.filter(model => model.family !== optional.key);
  const routes = baselineCatalogDocument(source, new Map()).routes;
  assert.equal(routes.length, releasedChatFamilies().length - 1);
  assert.equal(routes.some(route => route.family === optional.key), false);
  for (const family of ['claude', 'gpt', 'gemini', 'grok', 'deepseek', 'qwen', 'llama'])
    assert.equal(routes.some(route => route.family === family), true);
});

test('fractional published token rates round conservatively without JS money arithmetic', () => {
  const id = PPQ_MODEL_ALLOWLIST.deepseek.id;
  const models = normalizeCatalog(parseProviderJson(`{"data":[{"id":"${id}","type":"chat","pricing":{"currency":"USD","input_per_1M_tokens":1.0077993,"output_per_1M_tokens":2.0155986}}]}`));
  assert.equal(models[0].pricing.inputPerMillionUsd6, 1007800);
  assert.equal(models[0].pricing.outputPerMillionUsd6, 2015599);
});

test('fresh released registry skips network/writes and queries all approved route IDs', async () => {
  let reads = 0;
  const pool = {
    query: async (sql, values) => {
      reads++;
      assert.deepEqual(
        values[0],
        releasedChatFamilies().map((family) => `ppq-${family}`),
      );
      return {
        rows: releasedChatFamilies().map((family) => ({
          family,
          card: {routing:{version:1,tasks:['general'],reviewedAt:new Date().toISOString(),evidenceUrl:'https://example.test'}},
          version: 2,
          pricing: { maxOutputTokens: CHAT_CAPACITY[family].outputTokens, maxInputBytes: CHAT_LIMITS.inputBytes, maxReasoningTokens: CHAT_CAPACITY[family].reasoningTokens, contextTokens: 1310720 },
          expires_at: new Date(Date.now() + 12 * 3600000),
        })),
      };
    },
  };
  assert.deepEqual(await refreshBaselineRoutes(pool), { refreshed: false });
  assert.equal(reads, 1);
});

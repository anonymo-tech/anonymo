import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  publicInferenceErrorCode,
  publicListedRoute,
  publicRouteCard,
} from '../server/routes/public-inference.ts';
import { parseRoutingProfile } from '../lib/model-routing.ts';
import {
  parseCallSnapshot,
  parseQuoteResponse,
  parseRoute,
} from '../lib/client/workspace.ts';
import { callRoutes } from '../server/routes/calls.ts';
import { CHINESE_CHAT_MODELS } from '../lib/chinese-models.ts';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-10-01T00:00:00.000Z';
const internalCard = () => ({
  level: 'unverified',
  reviewed: true,
  provider: 'ppq',
  upstreamProviders: ['Anthropic'],
  plaintextVisibility: 'gateway_and_upstream',
  retentionDays: null,
  trainingUse: 'unknown',
  jurisdiction: null,
  legalHold: 'possible',
  retentionDisclosure: 'PPQ and the upstream model host receive plaintext. Retention is unknown; legal holds may apply. See https://ppq.ai/privacy.',
  evidenceUrl: 'https://ppq.ai/privacy',
  upstreamEvidenceUrls: ['https://privacy.anthropic.com/', 'https://ppq.ai/privacy'],
  evidenceDate: '2026-10-01',
  lastVerifiedAt: date,
  catalogVerification: {
    sourceUrl: 'https://api.ppq.ai/v1/models?type=all',
    fetchedAt: date,
    sha256: 'a'.repeat(64),
    priceCheck: 'matched',
  },
  internalOnly: { privateEndpoint: 'https://api.ppq.ai/v1/chat/completions' },
  routing: {
    version: 1,
    tasks: ['general', 'code'],
    evidenceUrl: 'https://ppq.ai/models',
    reviewedAt: date,
  },
});
const pricing = {
  inputPerMillionUsd6: '3123456',
  outputPerMillionUsd6: '15123456',
  markupBps: 177,
  maxOutputTokens: 4096,
  maxInputBytes: 32768,
  maxReasoningTokens: 8192,
};
const internalRoute = () => ({
  versionId: uuid(1),
  id: 'ppq-claude',
  version: 7,
  modelId: 'claude-opus-5.5',
  family: 'claude',
  modality: 'chat',
  available: true,
  expiresAt: date,
  card: internalCard(),
  pricing: { ...pricing },
});

test('public cards use a field allowlist and preserve material processing disclosures', () => {
  const original = internalCard();
  const before = structuredClone(original);
  const card = publicRouteCard(original);
  assert.doesNotMatch(JSON.stringify(card), /ppq/i);
  assert.equal(card.provider, 'gateway');
  assert.equal(card.plaintextVisibility, original.plaintextVisibility);
  assert.equal(card.level, 'unverified');
  assert.equal(card.reviewed, true);
  assert.equal(card.retentionDays, null);
  assert.equal(card.trainingUse, 'unknown');
  assert.equal(card.legalHold, 'possible');
  assert.equal(card.jurisdiction, null);
  assert.match(card.retentionDisclosure, /upstream model host receive plaintext/);
  assert.match(card.retentionDisclosure, /Retention is unknown; legal holds may apply/);
  assert.deepEqual(card.upstreamProviders, ['Anthropic']);
  assert.equal(card.evidenceDate, original.evidenceDate);
  assert.equal(card.lastVerifiedAt, original.lastVerifiedAt);
  assert.equal('catalogVerification' in card, false);
  assert.equal('internalOnly' in card, false);
  assert.deepEqual(original, before, 'internal review evidence must not be mutated');
});

test('gateway URLs are withheld without fabricating sources; official upstream sources remain', () => {
  const card = publicRouteCard(internalCard());
  assert.equal(card.evidenceUrl, '');
  assert.deepEqual(card.upstreamEvidenceUrls, ['https://privacy.anthropic.com/']);
  assert.equal(card.routing.evidenceUrl, '');
  for (const link of [
    'HTTPS://PPQ.AI/privacy',
    'https://api.ppq.ai/models',
    'https://example.com/ppq-policy',
    'javascript:alert(1)',
    'https://user:pass@example.com/policy',
    'https://example.com/?secret=fixture',
  ]) assert.equal(publicRouteCard({ ...internalCard(), evidenceUrl: link }).evidenceUrl, '');
  assert.equal(publicRouteCard({ ...internalCard(), evidenceUrl: 'https://openai.com/policies/privacy-policy/' }).evidenceUrl, 'https://openai.com/policies/privacy-policy/');
});

test('metadata text removes gateway branding and bare URLs without changing retention terms', () => {
  const card = publicRouteCard({
    ...internalCard(),
    retentionDays: 30,
    trainingUse: 'may_be_used',
    jurisdiction: 'United States; PPQ',
    upstreamProviders: ['OpenAI', 'PPQ'],
    retentionDisclosure: 'PPQ retains data for 30 days. API.PPQ.AI/v1 and ppq.ai/privacy describe exceptions. Training may be used.',
  });
  assert.doesNotMatch(JSON.stringify(card), /ppq/i);
  assert.equal(card.retentionDays, 30);
  assert.equal(card.trainingUse, 'may_be_used');
  assert.match(card.retentionDisclosure, /retains data for 30 days/);
  assert.match(card.retentionDisclosure, /Training may be used/);
  assert.equal(card.upstreamProviders[0], 'OpenAI');
});

test('public route IDs are opaque aliases, while model versions and exact pricing remain unchanged', () => {
  const original = internalRoute();
  const route = publicListedRoute({ ...original, privateNote: 'ppq', pricing: { ...pricing, internalEndpoint: 'ppq' } });
  assert.equal(route.id, `claude-standard-${uuid(1)}`);
  assert.equal(route.versionId, original.versionId);
  assert.equal(route.version, original.version);
  assert.equal(route.modelId, original.modelId);
  assert.equal(route.available, original.available);
  assert.deepEqual(route.pricing, pricing);
  assert.doesNotMatch(JSON.stringify(route), /ppq/i);
  assert.equal('privateNote' in route, false);
  assert.notEqual(publicListedRoute({ ...original, versionId: uuid(2) }).id, route.id);
  assert.throws(() => publicListedRoute({ ...original, modelId: 'ppq/private-model' }), /INVALID_PUBLIC_ROUTE_IDENTITY/);
});

test('client parses withheld evidence without weakening internal routing review validation', () => {
  const route = publicListedRoute(internalRoute());
  const parsed = parseRoute(route);
  assert.equal(parsed.card.evidenceUrl, '');
  assert.deepEqual(parsed.card.routing.tasks, ['general', 'code']);
  assert.equal(parsed.card.routing.reviewedAt, date);
  assert.equal(parsed.card.routing.evidenceUrl, '');
  assert.throws(() => parseRoutingProfile(route.card.routing), /INVALID_ROUTING_PROFILE/);
  assert.deepEqual(parseRoutingProfile(internalCard().routing), internalCard().routing);
  assert.throws(() => parseRoutingProfile({ ...route.card.routing, tasks: ['not-a-task'] }, { allowWithheldEvidence: true }), /INVALID_ROUTING_PROFILE/);
  assert.throws(() => parseRoutingProfile({ ...route.card.routing, evidenceUrl: 'javascript:alert(1)' }, { allowWithheldEvidence: true }), /INVALID_ROUTING_PROFILE/);
});

test('every released Chinese variant survives public serialization and client parsing', () => {
  for (const model of CHINESE_CHAT_MODELS) {
    const value = publicListedRoute({ ...internalRoute(), family: model.key, modelId: model.modelId });
    assert.equal(parseRoute(value).family, model.key);
    assert.equal(parseRoute(value).modelId, model.modelId);
    assert.doesNotMatch(JSON.stringify(value), /ppq/i);
  }
  for (const family of ['../private', 'invalid family', 'x'.repeat(41), 'ppq-secret']) {
    assert.throws(() => publicListedRoute({ ...internalRoute(), family }), /INVALID_PUBLIC_ROUTE_IDENTITY/);
  }
});

test('quote parsing retains exact maximums, fee splits, model identity, and route UUID', () => {
  const maximumUsd6 = '132000';
  const response = {
    maximumUsd6,
    quotes: [{
      id: uuid(3),
      routeVersionId: uuid(1),
      maximumUsd6,
      expiresAt: date,
      requestHash: 'b'.repeat(64),
      markupBps: 177,
      modelId: 'claude-opus-5.5',
      family: 'claude',
      card: publicRouteCard(internalCard()),
      platformFee: {
        baseMaximumUsd6: '120000',
        platformFeeBps: 1000,
        burnShareBps: 2500,
        platformFeeMaximumUsd6: '12000',
        burnReserveMaximumUsd6: '3000',
      },
    }],
  };
  const parsed = parseQuoteResponse(response, { items: [{ routeVersionId: uuid(1) }] });
  assert.equal(parsed.maximumUsd6, maximumUsd6);
  assert.equal(parsed.quotes[0].routeVersionId, uuid(1));
  assert.equal(parsed.quotes[0].modelId, response.quotes[0].modelId);
  assert.deepEqual(parsed.quotes[0].platformFee, response.quotes[0].platformFee);
});

test('persisted gateway error labels become generic codes without changing other call semantics', () => {
  assert.equal(publicInferenceErrorCode(null), null);
  assert.equal(publicInferenceErrorCode('PPQ_TIMEOUT'), 'PROVIDER_TIMEOUT');
  assert.equal(publicInferenceErrorCode('PPQ_PROVIDER_UNAVAILABLE'), 'PROVIDER_UNAVAILABLE');
  assert.equal(publicInferenceErrorCode('PPQ_AUTHENTICATION'), 'PROVIDER_AUTHENTICATION');
  assert.equal(publicInferenceErrorCode('PPQ_UNRECOGNIZED'), 'REQUEST_FAILED');
  assert.equal(publicInferenceErrorCode('https://api.ppq.ai/error'), 'REQUEST_FAILED');
  for (const code of ['USAGE_UNCONFIRMED', 'STREAM_INTERRUPTED', 'CANCEL_DRAIN_TIMEOUT', 'REQUEST_FAILED'])
    assert.equal(publicInferenceErrorCode(code), code);
});

test('actual single-call serializer sanitizes errors and preserves held/uncertain billing', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM calls c JOIN holds h')) return { rows: [{
        id: uuid(4), hold_id: uuid(5), state: 'reconciliation_pending',
        error_code: 'PPQ_TIMEOUT', output_ciphertext: null, updated_at: new Date(date),
        maximum_usd6: '132000', captured_usd6: null, billing_state: 'reconciliation_pending',
        cancel_requested: true, blind: false,
      }] };
      if (sql.includes('hold_platform_fees')) return { rows: [] };
      throw new Error('Unexpected mock database query');
    },
  };
  const response = await callRoutes(pool, new Request(`https://conclave.test/api/calls/${uuid(4)}`), `calls/${uuid(4)}`, uuid(6), true);
  const result = await response.json();
  assert.equal(result.call.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(result.call.state, 'reconciliation_pending');
  assert.equal(result.call.cancelRequested, true);
  assert.deepEqual(result.call.billing, { state: 'reconciliation_pending', maximumUsd6: '132000', actualUsd6: null });
  assert.doesNotMatch(JSON.stringify(result), /ppq/i);
});

test('model text is not censored or rewritten by public client parsing', () => {
  const output = 'The user asked about PPQ and https://ppq.ai/privacy; preserve the answer verbatim.';
  const parsed = parseCallSnapshot({
    id: uuid(4), state: 'succeeded', errorCode: null, output,
    cancelRequested: false, updatedAt: date,
    billing: { state: 'captured', maximumUsd6: '132000', actualUsd6: '123456' },
  });
  assert.equal(parsed.output, output);
  assert.equal(parsed.billing.actualUsd6, '123456');
});

test('every baseline response boundary uses the projection; no global response rewriting', async () => {
  const source = async (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const routes = await source('../server/routes/dispatch.ts');
  const comparisons = await source('../server/routes/comparisons.ts');
  const auto = await source('../server/routes/auto-routing.ts');
  assert.match(routes, /\.map\(publicListedRoute\)/);
  assert.match(comparisons, /card: publicRouteCard\(route\.card\)/);
  assert.match(auto, /card: publicRouteCard\(selected\.route\.card\)/);
  for (const name of ['calls', 'comparisons', 'call-events']) {
    const text = await source(`../server/routes/${name}.ts`);
    assert.match(text, /errorCode: publicInferenceErrorCode\(call\.error_code\)/);
    assert.doesNotMatch(text, /errorCode: call\.error_code/);
  }
  const http = await source('../server/core/http.ts');
  assert.doesNotMatch(http, /publicRouteCard|publicListedRoute|publicInferenceErrorCode/);
  const receipt = await source('../server/routes/receipts.ts');
  assert.doesNotMatch(receipt, /publicRouteCard|publicListedRoute|publicInferenceErrorCode/);
});

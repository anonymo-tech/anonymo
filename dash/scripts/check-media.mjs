import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  assertUsableMediaRoute,
  mediaCapability,
  mediaQuoteAmount,
  mediaRequestHash,
  parseMediaInput,
  parseMediaOptions,
  validateMediaPricing,
} from '../server/media/contract.ts';

const image = { kind: 'image', count: 1, resolution: '1K', aspectRatio: '1:1' };
function route() {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    route_id: 'test-image',
    version: 1,
    model_id: 'nano-banana-2',
    family: 'image',
    modality: 'image',
    enabled: true,
    expires_at: new Date(Date.now() + 300000),
    card: {
      level: 'unverified',
      reviewed: true,
      provider: 'gateway',
      plaintextVisibility: 'gateway_and_upstream',
      retentionDisclosure: 'Gateway and upstream may process plaintext.',
      evidenceUrl: 'https://inference.invalid/privacy',
      lastVerifiedAt: now,
      catalogVerification: {
        sourceUrl: 'https://api.inference.invalid/v1/models?type=all',
        fetchedAt: now,
        sha256: 'a'.repeat(64),
        priceCheck: 'matched',
      },
      mediaTerms: {
        reviewed: true,
        commercialUse: 'allowed',
        evidenceUrls: ['https://inference.invalid/terms'],
        reviewedAt: now,
      },
    },
    pricing: {
      kind: 'media-fixed-v1',
      maxInputBytes: 16000,
      markupBps: 1250,
      variants: [
        {
          options: image,
          providerUsd6: '92000',
          catalogQuality: 'standard',
          catalogSize: '1K',
        },
      ],
    },
  };
}
void test('media capability cannot be enabled by environment storage claims', () => {
  const env = {
    CONCLAVE_MODE: 'service',
    CONCLAVE_APP_ORIGIN: 'https://app.example.invalid',
    CONCLAVE_DATABASE_URL: 'postgresql://fixture.example.invalid/db',
    GATEWAY_API_KEY: randomBytes(16).toString('hex'),
    GATEWAY_API_ORIGIN: 'https://api.inference.invalid',
    GATEWAY_EVIDENCE_ORIGINS: '["https://inference.invalid","https://www.inference.invalid"]',
    CONCLAVE_INFERENCE_ENABLED: 'true',
    CONCLAVE_MEDIA_ENABLED: 'true',
    CONCLAVE_MEDIA_STORAGE_READY: 'true',
    CONCLAVE_ACTIVE_DATA_KEY: 'test',
    CONCLAVE_DATA_KEYS: JSON.stringify({
      test: randomBytes(32).toString('base64'),
    }),
  };
  assert.equal(mediaCapability(env).configured, false);
  assert.equal(mediaCapability(env).reason, 'MEDIA_STORAGE_REQUIRED');
  assert.equal(mediaCapability(env, true).configured, true);
  for (const key of [
    'GATEWAY_API_KEY',
    'CONCLAVE_DATABASE_URL',
    'CONCLAVE_DATA_KEYS',
    'CONCLAVE_MEDIA_ENABLED',
    'CONCLAVE_INFERENCE_ENABLED',
  ])
    assert.equal(
      mediaCapability({ ...env, [key]: '' }, true).configured,
      false,
    );
  assert.equal(mediaCapability(env, true).deliveryReady, true);
  assert.equal(
    mediaCapability({ ...env, GATEWAY_API_KEY: '' }, true).deliveryReady,
    true,
  );
  assert.equal(
    mediaCapability({ ...env, CONCLAVE_DATA_KEYS: '' }, true).deliveryReady,
    false,
  );
  assert.ok(!JSON.stringify(mediaCapability(env)).includes(env.GATEWAY_API_KEY));
});
void test('strict exact media input refuses references, extra fields and oversized UTF-8 text', () => {
  const input = { prompt: 'A stone arch', privacy: 'standard', options: image };
  assert.deepEqual(parseMediaInput(input), input);
  for (const altered of [
    { ...input, imageUrl: 'https://example.invalid/private' },
    { ...input, privacy: 'strict' },
    { ...input, prompt: '' },
    { ...input, prompt: '界'.repeat(5334) },
    { ...input, options: { ...image, count: 2 } },
    { ...input, options: { ...image, extra: true } },
  ])
    assert.throws(() => parseMediaInput(altered));
});
void test('media options preserve model-specific duration quality and ratio restrictions', () => {
  for (const [model, options] of [
    [
      'runway-gen4',
      { kind: 'video', duration: 5, quality: '1080p', aspectRatio: '9:16' },
    ],
    [
      'veo3-fast',
      { kind: 'video', duration: 8, quality: 'standard', aspectRatio: '16:9' },
    ],
    [
      'kling-2.5-turbo',
      { kind: 'video', duration: 10, quality: 'standard', aspectRatio: '1:1' },
    ],
  ])
    assert.deepEqual(parseMediaOptions(options, model), options);
  for (const [model, options] of [
    [
      'runway-gen4',
      { kind: 'video', duration: 10, quality: '1080p', aspectRatio: '16:9' },
    ],
    [
      'veo3-fast',
      { kind: 'video', duration: 5, quality: 'standard', aspectRatio: '16:9' },
    ],
    [
      'veo3-fast',
      { kind: 'video', duration: 8, quality: 'standard', aspectRatio: '1:1' },
    ],
    [
      'kling-2.5-turbo',
      { kind: 'video', duration: 5, quality: '720p', aspectRatio: '16:9' },
    ],
    ['runway-gen4', image],
  ])
    assert.throws(() => parseMediaOptions(options, model));
});
void test('media pricing matches exact option labels and rejects cheaper variant substitution', () => {
  const r = route();
  assert.equal(
    validateMediaPricing(r.pricing, r.model_id).variants[0].providerUsd6,
    '92000',
  );
  for (const edit of [
    (p) => (p.variants[0].catalogSize = '2K'),
    (p) => (p.variants[0].catalogQuality = 'default'),
    (p) => p.variants.push(p.variants[0]),
    (p) => (p.variants[0].providerUsd6 = '0'),
    (p) => (p.variants[0].providerUsd6 = '10000001'),
    (p) => (p.markupBps = -1),
    (p) => (p.maxInputBytes = 16001),
  ]) {
    const p = structuredClone(r.pricing);
    edit(p);
    assert.throws(() => validateMediaPricing(p, r.model_id));
  }
});
void test('fresh immutable media reviews require explicit terms catalog and privacy evidence', () => {
  assert.doesNotThrow(() => assertUsableMediaRoute(route()));
  for (const edit of [
    (r) => (r.enabled = false),
    (r) => (r.expires_at = new Date(0)),
    (r) => (r.family = 'veo'),
    (r) => (r.card.level = 'sealed'),
    (r) => (r.card.mediaTerms.commercialUse = 'unknown'),
    (r) =>
      (r.card.mediaTerms.reviewedAt = new Date(
        Date.now() - 86400001,
      ).toISOString()),
    (r) => (r.card.catalogVerification.sha256 = 'bad'),
    (r) =>
      (r.card.catalogVerification.fetchedAt = new Date(
        Date.now() + 1000,
      ).toISOString()),
    (r) => (r.card.catalogVerification.priceCheck = 'unchecked'),
  ]) {
    const r = route();
    edit(r);
    assert.throws(() => assertUsableMediaRoute(r));
  }
});
void test('quotes use integer markup rounding and bind options rather than broad model base prices', () => {
  const r = route(),
    input = parseMediaInput({
      prompt: 'A stone arch',
      privacy: 'standard',
      options: image,
    });
  assert.deepEqual(mediaQuoteAmount(r, input), {
    providerUsd6: '92000',
    maximumUsd6: '103500',
  });
  r.pricing.variants[0].providerUsd6 = '1';
  assert.equal(mediaQuoteAmount(r, input).maximumUsd6, '2');
  assert.throws(() =>
    mediaQuoteAmount(r, { ...input, options: { ...image, resolution: '2K' } }),
  );
});
void test('request commitment binds owner project route and every generation option', async () => {
  const input = parseMediaInput({
    prompt: 'A stone arch',
    privacy: 'standard',
    options: image,
  });
  const a = randomUUID(),
    b = randomUUID();
  const hash = await mediaRequestHash(a, b, input);
  for (const [project, version, value] of [
    [randomUUID(), b, input],
    [a, randomUUID(), input],
    [a, b, { ...input, prompt: 'Another arch' }],
    [a, b, { ...input, options: { ...image, aspectRatio: '16:9' } }],
  ])
    assert.notEqual(await mediaRequestHash(project, version, value), hash);
});

void test('option enums reject coercible non-string values and UUID commitment is canonical', async () => {
  for (const options of [
    { ...image, aspectRatio: ['1:1'] },
    { ...image, resolution: ['1K'] },
    { kind: 'video', duration: 5, quality: ['720p'], aspectRatio: '16:9' },
    { kind: 'video', duration: 5, quality: '720p', aspectRatio: ['16:9'] },
    { kind: 'video', duration: '5', quality: '720p', aspectRatio: '16:9' },
  ])
    assert.throws(() => parseMediaOptions(options));
  const project = randomUUID(),
    routeId = randomUUID(),
    input = parseMediaInput({
      prompt: 'An arch',
      privacy: 'standard',
      options: image,
    });
  assert.equal(
    await mediaRequestHash(project, routeId, input),
    await mediaRequestHash(project.toUpperCase(), routeId.toUpperCase(), input),
  );
});

void test('media descriptions reject non-text controls before encryption while preserving tabs and line breaks', () => {
  const input = {
    prompt: 'A\tstone\narch\runder stars',
    privacy: 'standard',
    options: image,
  };
  assert.deepEqual(parseMediaInput(input), input);
  for (const code of [
    ...Array.from({ length: 32 }, (_, i) => i).filter(
      (i) => ![9, 10, 13].includes(i),
    ),
    127,
  ]) {
    assert.throws(
      () =>
        parseMediaInput({ ...input, prompt: `A${String.fromCharCode(code)}B` }),
      (error) => error.code === 'INVALID_MEDIA_TEXT' && error.status === 400,
    );
  }
  assert.throws(
    () =>
      parseMediaInput({
        ...input,
        prompt: String.fromCharCode(0).repeat(16000),
      }),
    (error) => error.code === 'INVALID_MEDIA_TEXT' && error.status === 400,
  );
});

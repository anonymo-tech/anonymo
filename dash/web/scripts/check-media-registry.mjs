import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import { ROUTE_CATALOG_URL } from '../server/routes/route-registry.ts';
import { assertUsableMediaRoute } from '../server/media/contract.ts';
import {
  fetchMediaCatalog,
  validateMediaReview,
  validateMediaCatalog,
  installReviewedMediaRoutes,
} from '../server/media/registry.ts';

const endpoint = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL);
const pool = createDatabase(endpoint.href, 8);
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.end();
});

const definitions = {
  runway: {
    modelId: 'runway-gen4',
    modality: 'video',
    origin: 'https://runwayml.com',
    options: {
      kind: 'video',
      duration: 5,
      quality: '720p',
      aspectRatio: '16:9',
    },
    quality: '720p',
    size: '16:9_5',
    amount: '69000',
  },
  veo: {
    modelId: 'veo3-fast',
    modality: 'video',
    origin: 'https://policies.google.com',
    options: {
      kind: 'video',
      duration: 8,
      quality: 'standard',
      aspectRatio: '16:9',
    },
    quality: 'standard',
    size: '16:9_8',
    amount: '1380000',
  },
  kling: {
    modelId: 'kling-2.5-turbo',
    modality: 'video',
    origin: 'https://klingai.com',
    options: {
      kind: 'video',
      duration: 5,
      quality: 'standard',
      aspectRatio: '16:9',
    },
    quality: 'standard',
    size: '16:9_5',
    amount: '402500',
  },
  image: {
    modelId: 'nano-banana-2',
    modality: 'image',
    origin: 'https://policies.google.com',
    options: { kind: 'image', count: 1, resolution: '1K', aspectRatio: '1:1' },
    quality: 'standard',
    size: '1K',
    amount: '92000',
  },
};
function fixture(families = ['runway']) {
  const now = new Date().toISOString();
  return {
    version: 1,
    routes: families.map((family) => {
      const d = definitions[family];
      return {
        id: randomUUID(),
        routeId: `fixture-${randomUUID()}`,
        version: 1,
        modelId: d.modelId,
        family,
        modality: d.modality,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        card: {
          level: 'unverified',
          reviewed: true,
          provider: 'gateway',
          upstreamProviders: ['Synthetic processor'],
          plaintextVisibility: 'gateway_and_upstream',
          retentionDays: null,
          trainingUse: 'unknown',
          jurisdiction: null,
          legalHold: 'unknown',
          retentionDisclosure:
            'The gateway and upstream can read this input; retention remains unverified.',
          evidenceUrl: 'https://inference.invalid/privacy',
          upstreamEvidenceUrls: [],
          evidenceDate: now.slice(0, 10),
          lastVerifiedAt: now,
          mediaTerms: {
            reviewed: true,
            commercialUse: 'allowed',
            evidenceUrls: ['https://inference.invalid/terms', `${d.origin}/terms`],
            reviewedAt: now,
          },
        },
        pricing: {
          kind: 'media-fixed-v1',
          maxInputBytes: 16000,
          markupBps: 0,
          variants: [
            {
              options: structuredClone(d.options),
              providerUsd6: d.amount,
              catalogQuality: d.quality,
              catalogSize: d.size,
            },
          ],
        },
      };
    }),
  };
}
function catalog(families = Object.keys(definitions)) {
  return {
    sourceUrl: ROUTE_CATALOG_URL,
    fetchedAt: new Date().toISOString(),
    sha256: 'a'.repeat(64),
    models: families.map((family) => {
      const d = definitions[family];
      return {
        id: d.modelId,
        family,
        modality: d.modality,
        name: 'Synthetic model',
        contextLength: null,
        privacyLevel: null,
        strictPrivacyAvailable: false,
        supportedParameters: [],
        pricing: {
          inputPerMillionUsd6: null,
          outputPerMillionUsd6: null,
          baseUsd6: 1,
          variants: [
            { quality: d.quality, size: d.size, usd6: Number(d.amount) },
          ],
        },
      };
    }),
  };
}
const mediaError = (error) => error.code.startsWith('MEDIA_');

void test('all supported media families bind exact variants and default disabled', () => {
  const routes = validateMediaReview(fixture(Object.keys(definitions)));
  assert.equal(routes.length, 4);
  assert.ok(routes.every((r) => r.enabled === false));
  assert.equal(validateMediaCatalog(routes, catalog()).priceCheck, 'matched');
  assert.ok(routes.every((r) => r.card.level === 'unverified'));
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  ROUTE_CATALOG_URL,
  fetchRouteCatalog,
  installReviewedRoutes,
  validateRouteCatalog,
  validateRouteReview,
} from '../server/routes/route-registry.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set CONCLAVE_TEST_DATABASE_URL to an isolated PostgreSQL test database.',
  );
const parsed = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
  !parsed.pathname.endsWith('_test')
) {
  throw new Error(
    'Route registry tests require a loopback database whose name ends in _test.',
  );
}
const pool = createDatabase(connection, 8);
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.end();
});

function fixture() {
  const now = new Date().toISOString();
  return {
    version: 1,
    routes: [
      {
        id: randomUUID(),
        routeId: `fixture-${randomUUID()}`,
        version: 1,
        modelId: 'gpt-6.1-sol',
        family: 'gpt',
        modality: 'chat',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        card: {
          level: 'unverified',
          reviewed: true,
          provider: 'gateway',
          upstreamProviders: ['Unknown processing provider'],
          plaintextVisibility: 'gateway_and_upstream',
          retentionDays: null,
          trainingUse: 'unknown',
          jurisdiction: null,
          legalHold: 'unknown',
          retentionDisclosure:
            'The gateway and upstream processors can read this request. Exact retention is unverified.',
          evidenceUrl: 'https://inference.invalid/privacy',
          upstreamEvidenceUrls: [],
          evidenceDate: now.slice(0, 10),
          lastVerifiedAt: now,
        },
        pricing: {
          inputPerMillionUsd6: '791250',
          outputPerMillionUsd6: '4747500',
          markupBps: 0,
          maxOutputTokens: 1024,
          maxInputBytes: 8192,
        },
      },
    ],
  };
}
function catalog() {
  return {
    sourceUrl: ROUTE_CATALOG_URL,
    fetchedAt: new Date().toISOString(),
    sha256: 'a'.repeat(64),
    models: [
      {
        id: 'gpt-6.1-sol',
        family: 'gpt',
        modality: 'chat',
        name: 'Fixture',
        contextLength: 400000,
        privacyLevel: 'zdr',
        strictPrivacyAvailable: false,
        supportedParameters: [],
        pricing: {
          inputPerMillionUsd6: 791250,
          outputPerMillionUsd6: 4747500,
          baseUsd6: null,
          variants: [],
        },
      },
    ],
  };
}
const catalogBody = JSON.stringify({
  data: [
    {
      id: 'gpt-6.1-sol',
      type: 'chat',
      context_length: 400000,
      pricing: {
        currency: 'USD',
        input_per_1M_tokens: '0.79125',
        output_per_1M_tokens: '4.7475',
      },
    },
  ],
});

void test('review validation normalizes disabled default and exact integer USD6, without privacy upgrades', () => {
  const document = fixture();
  const [route] = validateRouteReview(document);
  assert.equal(route.enabled, false);
  assert.equal(route.card.level, 'unverified');
  assert.equal(route.pricing.inputPerMillionUsd6, '791250');
  assert.equal(validateRouteCatalog([route], catalog()).priceCheck, 'matched');
  assert.equal(route.card.level, 'unverified');
});

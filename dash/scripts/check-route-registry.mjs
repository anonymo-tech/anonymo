import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  routeCatalogUrl,
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
    sourceUrl: routeCatalogUrl(),
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

void test('an optional reviewed reasoning cap is accepted and preserved; its absence is preserved too', () => {
  const without = validateRouteReview(fixture())[0];
  assert.equal(Object.hasOwn(without.pricing, 'maxReasoningTokens'), false);
  for (const cap of [0, 8192, 65536]) {
    const document = fixture();
    document.routes[0].pricing.maxReasoningTokens = cap;
    const [route] = validateRouteReview(document);
    assert.equal(route.pricing.maxReasoningTokens, cap);
  }
});

void test('invalid money, unknown fields, unsupported IDs, media and sealed claims fail closed', () => {
  const changes = [
    (r) => {
      r.pricing.inputPerMillionUsd6 = 791250;
    },
    (r) => {
      r.pricing.inputPerMillionUsd6 = '0.79125';
    },
    (r) => {
      r.pricing.inputPerMillionUsd6 = '0791250';
    },
    (r) => {
      r.pricing.inputPerMillionUsd6 = '-1';
    },
    (r) => {
      r.pricing.inputPerMillionUsd6 = '0';
    },
    (r) => {
      r.pricing.inputPerMillionUsd6 = '9000000000000001';
    },
    (r) => {
      r.pricing.markupBps = 10001;
    },
    (r) => {
      r.pricing.maxOutputTokens = 8193;
    },
    (r) => {
      r.pricing.maxReasoningTokens = 65537;
    },
    (r) => {
      r.pricing.maxReasoningTokens = -1;
    },
    (r) => {
      r.pricing.maxReasoningTokens = '0';
    },
    (r) => {
      r.pricing.maxInputBytes = 32769;
    },
    (r) => {
      r.modelId = 'unreviewed-model';
    },
    (r) => {
      r.family = 'constructor';
    },
    (r) => {
      r.modality = 'video';
    },
    (r) => {
      r.card.level = 'sealed';
    },
    (r) => {
      r.card.reviewed = false;
    },
    (r) => {
      r.card.plaintextVisibility = 'none';
    },
    (r) => {
      r.enabled = 'true';
    },
    (r) => {
      r.autoEnable = true;
    },
  ];
  for (const change of changes) {
    const document = fixture();
    change(document.routes[0]);
    assert.throws(
      () => validateRouteReview(document),
      (error) => error.code.startsWith('ROUTE_'),
    );
  }
  const duplicate = fixture();
  duplicate.routes.push(structuredClone(duplicate.routes[0]));
  assert.throws(() => validateRouteReview(duplicate));
  const accessors = fixture();
  Object.defineProperty(accessors.routes[0], 'family', {
    get() {
      throw new Error('Do not execute getters');
    },
    enumerable: true,
  });
  assert.throws(() => validateRouteReview(accessors), {
    code: 'ROUTE_REVIEW_INVALID',
  });
});

void test('evidence fields and one-day review expiry reject stale, future, insecure and unsupported claims', () => {
  const changes = [
    (r) => {
      r.expiresAt = new Date(Date.now() - 1000).toISOString();
    },
    (r) => {
      r.expiresAt = new Date(Date.now() + 2 * 86400000).toISOString();
    },
    (r) => {
      r.card.lastVerifiedAt = new Date(Date.now() - 2 * 86400000).toISOString();
    },
    (r) => {
      r.card.lastVerifiedAt = new Date(Date.now() + 10000).toISOString();
    },
    (r) => {
      r.card.evidenceDate = '2026-02-30';
    },
    (r) => {
      r.card.evidenceUrl = 'http://inference.invalid/privacy';
    },
    (r) => {
      r.card.evidenceUrl = 'https://inference.invalid@127.0.0.1/privacy';
    },
    (r) => {
      r.card.evidenceUrl = 'https://example.com/privacy';
    },
    (r) => {
      r.card.retentionDays = 0;
    },
    (r) => {
      r.card.trainingUse = 'not_used';
    },
    (r) => {
      r.card.jurisdiction = 'Unspecified';
    },
    (r) => {
      r.card.retentionDisclosure = '';
    },
  ];
  for (const change of changes) {
    const document = fixture();
    change(document.routes[0]);
    assert.throws(() => validateRouteReview(document));
  }
});

void test('fresh catalog requires exact model, price and supported context; label never supplies privacy evidence', () => {
  const routes = validateRouteReview(fixture());
  for (const change of [
    (c) => {
      c.fetchedAt = new Date(Date.now() - 16 * 60000).toISOString();
    },
    (c) => {
      c.fetchedAt = new Date(Date.now() + 10000).toISOString();
    },
    (c) => {
      c.sourceUrl = 'https://example.com/models';
    },
    (c) => {
      c.models = [];
    },
    (c) => {
      c.models.push(c.models[0]);
    },
    (c) => {
      c.models[0].pricing.inputPerMillionUsd6 = null;
    },
    (c) => {
      c.models[0].pricing.inputPerMillionUsd6 = 791251;
    },
    (c) => {
      c.models[0].contextLength = 1024;
    },
  ]) {
    const snapshot = catalog();
    change(snapshot);
    assert.throws(() => validateRouteCatalog(routes, snapshot));
  }
});

void test('catalog GET has a fixed public endpoint, no key or credentials, and preserves decimal rates', async () => {
  let calls = 0;
  const snapshot = await fetchRouteCatalog({
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, routeCatalogUrl());
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      assert.equal(options.body, undefined);
      return new Response(catalogBody, {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(snapshot.models[0].pricing.inputPerMillionUsd6, 791250);
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
});

void test('catalog redirects, wrong content, oversized bodies, duplicate models and timeout are sanitized', async () => {
  for (const response of [
    new Response('provider detail that must not escape', {
      status: 302,
      headers: { Location: 'https://example.com' },
    }),
    new Response(catalogBody, { headers: { 'content-type': 'text/html' } }),
    new Response(catalogBody, {
      headers: {
        'content-type': 'application/json',
        'content-length': '4194305',
      },
    }),
    new Response('{invalid', {
      headers: { 'content-type': 'application/json' },
    }),
    new Response(
      JSON.stringify({
        data: [
          ...JSON.parse(catalogBody).data,
          ...JSON.parse(catalogBody).data,
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  ])
    await assert.rejects(fetchRouteCatalog({ fetch: async () => response }), {
      code: 'ROUTE_CATALOG_UNAVAILABLE',
    });
  await assert.rejects(
    fetchRouteCatalog({ timeoutMs: 5, fetch: () => new Promise(() => {}) }),
    { code: 'ROUTE_CATALOG_UNAVAILABLE' },
  );
});

void test('concurrent default installs create one disabled immutable version', async () => {
  const document = fixture();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => installReviewedRoutes(pool, document)),
  );
  assert.equal(
    results.reduce((sum, r) => sum + r.installed, 0),
    1,
  );
  assert.equal(
    results.reduce((sum, r) => sum + r.replayed, 0),
    3,
  );
  const {
    rows: [stored],
  } = await pool.query('SELECT * FROM route_versions WHERE id=$1', [
    document.routes[0].id,
  ]);
  assert.equal(stored.enabled, false);
  assert.equal(stored.card.catalogVerification, null);
  assert.deepEqual(stored.pricing, document.routes[0].pricing);
});

void test('enabled insertion requires independent explicit flag and fresh exact catalog', async () => {
  const document = fixture();
  document.routes[0].enabled = true;
  await assert.rejects(installReviewedRoutes(pool, document), {
    code: 'ROUTE_ENABLE_CONFIRMATION_REQUIRED',
  });
  await assert.rejects(
    installReviewedRoutes(pool, document, { enableReviewed: true }),
    { code: 'ROUTE_CATALOG_REQUIRED' },
  );
  const result = await installReviewedRoutes(pool, document, {
    enableReviewed: true,
    catalog: catalog(),
  });
  assert.deepEqual(result, { installed: 1, replayed: 0, enabled: 1 });
  const {
    rows: [stored],
  } = await pool.query('SELECT card FROM route_versions WHERE id=$1', [
    document.routes[0].id,
  ]);
  assert.equal(stored.card.level, 'unverified');
  assert.equal(stored.card.catalogVerification.priceCheck, 'matched');
});

void test('changing immutable terms or enabled flag on replay requires a new version', async () => {
  const document = fixture();
  await installReviewedRoutes(pool, document);
  const changed = structuredClone(document);
  changed.routes[0].pricing.markupBps = 10;
  await assert.rejects(installReviewedRoutes(pool, changed), {
    code: 'ROUTE_VERSION_CONFLICT',
  });
  const enable = structuredClone(document);
  enable.routes[0].enabled = true;
  await assert.rejects(
    installReviewedRoutes(pool, enable, {
      enableReviewed: true,
      catalog: catalog(),
    }),
    { code: 'ROUTE_VERSION_CONFLICT' },
  );
  const next = structuredClone(document);
  next.routes[0].id = randomUUID();
  next.routes[0].version = 3;
  await assert.rejects(installReviewedRoutes(pool, next), {
    code: 'ROUTE_VERSION_SEQUENCE',
  });
  next.routes[0].version = 2;
  assert.equal((await installReviewedRoutes(pool, next)).installed, 1);
  await assert.rejects(
    pool.query("UPDATE route_versions SET pricing='{}' WHERE id=$1", [
      document.routes[0].id,
    ]),
    { code: '23514' },
  );
});

void test('a conflict rolls back every new route in the operator file', async () => {
  const old = fixture();
  await installReviewedRoutes(pool, old);
  const fresh = fixture(),
    conflict = structuredClone(old.routes[0]);
  conflict.pricing.markupBps = 50;
  fresh.routes.push(conflict);
  await assert.rejects(installReviewedRoutes(pool, fresh), {
    code: 'ROUTE_VERSION_CONFLICT',
  });
  assert.equal(
    (
      await pool.query('SELECT id FROM route_versions WHERE id=$1', [
        fresh.routes[0].id,
      ])
    ).rowCount,
    0,
  );
});

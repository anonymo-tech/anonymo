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
import { routeCatalogUrl } from '../server/routes/route-registry.ts';
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
    sourceUrl: routeCatalogUrl(),
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

void test('media review rejects unknown IDs fields accessor properties and incomplete terms', () => {
  const changes = [
    (r) => {
      r.modelId = 'sora';
    },
    (r) => {
      r.family = 'constructor';
    },
    (r) => {
      r.modality = 'chat';
    },
    (r) => {
      r.extra = true;
    },
    (r) => {
      r.enabled = 'true';
    },
    (r) => {
      r.card.level = 'sealed';
    },
    (r) => {
      r.card.plaintextVisibility = 'none';
    },
    (r) => {
      r.card.mediaTerms.commercialUse = 'unknown';
    },
    (r) => {
      r.card.mediaTerms.reviewed = false;
    },
    (r) => {
      r.card.mediaTerms.evidenceUrls = ['https://inference.invalid/terms'];
    },
    (r) => {
      r.card.mediaTerms.evidenceUrls = ['https://runwayml.com/terms'];
    },
    (r) => {
      r.card.mediaTerms.evidenceUrls = [
        'https://inference.invalid/terms',
        'https://example.test/terms',
      ];
    },
    (r) => {
      r.card.mediaTerms.evidenceUrls = [
        'https://inference.invalid/terms',
        'https://policies.google.com/terms',
      ];
    },
    (r) => {
      r.card.evidenceUrl = 'http://inference.invalid/privacy';
    },
    (r) => {
      r.card.evidenceUrl = 'https://inference.invalid/privacy?key=fixture';
    },
    (r) => {
      r.card.trainingUse = 'not_used';
    },
    (r) => {
      r.card.upstreamProviders = [];
    },
  ];
  for (const change of changes) {
    const doc = fixture();
    change(doc.routes[0]);
    assert.throws(() => validateMediaReview(doc), mediaError);
  }
  const doc = fixture();
  Object.defineProperty(doc.routes[0], 'family', {
    get() {
      throw new Error('Getter must not run');
    },
    enumerable: true,
  });
  assert.throws(() => validateMediaReview(doc), {
    code: 'MEDIA_REVIEW_INVALID',
  });
  const duplicate = fixture();
  duplicate.routes.push(structuredClone(duplicate.routes[0]));
  assert.throws(() => validateMediaReview(duplicate), mediaError);
});

void test('fresh UTC reviews and catalog expiry are mandatory', () => {
  const changes = [
    (r) => {
      r.expiresAt = new Date(Date.now() - 1000).toISOString();
    },
    (r) => {
      r.expiresAt = new Date(Date.now() + 2 * 86400000).toISOString();
    },
    (r) => {
      r.card.lastVerifiedAt = new Date(Date.now() + 10000).toISOString();
    },
    (r) => {
      r.card.mediaTerms.reviewedAt = new Date(
        Date.now() - 2 * 86400000,
      ).toISOString();
    },
    (r) => {
      r.card.mediaTerms.reviewedAt = '2026-10-10T12:00:00-04:00';
    },
    (r) => {
      r.card.evidenceDate = '2026-02-30';
    },
  ];
  for (const change of changes) {
    const doc = fixture();
    change(doc.routes[0]);
    assert.throws(() => validateMediaReview(doc), mediaError);
  }
  for (const change of [
    (c) => {
      c.fetchedAt = new Date(Date.now() - 16 * 60000).toISOString();
    },
    (c) => {
      c.fetchedAt = new Date(Date.now() + 10000).toISOString();
    },
    (c) => {
      c.sourceUrl = 'https://example.test/models';
    },
    (c) => {
      c.sha256 = 'bad';
    },
  ]) {
    const c = catalog();
    change(c);
    assert.throws(
      () => validateMediaCatalog(validateMediaReview(fixture()), c),
      mediaError,
    );
  }
  const doc = fixture(),
    c = catalog();
  c.fetchedAt = new Date(Date.now() - 60000).toISOString();
  doc.routes[0].expiresAt = new Date(
    Date.now() + 86400000 - 1000,
  ).toISOString();
  assert.throws(() => validateMediaCatalog(validateMediaReview(doc), c), {
    code: 'MEDIA_REVIEW_STALE',
  });
});

void test('model-specific options and exact integer prices reject unsupported or duplicate combinations', () => {
  const changes = [
    (r) => {
      r.pricing.variants[0].options.duration = 6;
    },
    (r) => {
      r.pricing.variants[0].options.aspectRatio = '1:1';
    },
    (r) => {
      r.pricing.variants[0].options.duration = 10;
      r.pricing.variants[0].options.quality = '1080p';
    },
    (r) => {
      r.pricing.variants[0].options.imageUrl = 'https://example.test/reference';
    },
    (r) => {
      r.pricing.variants.push(structuredClone(r.pricing.variants[0]));
    },
    (r) => {
      r.pricing.maxInputBytes = 16001;
    },
    (r) => {
      r.pricing.markupBps = 10001;
    },
    ...[69000, '0', '-1', '069000', '0.069', '9000000000000001'].map(
      (amount) => (r) => {
        r.pricing.variants[0].providerUsd6 = amount;
      },
    ),
  ];
  for (const change of changes) {
    const doc = fixture();
    change(doc.routes[0]);
    assert.throws(() => validateMediaReview(doc), mediaError);
  }
  const image = fixture(['image']);
  image.routes[0].pricing.variants[0].options.count = 2;
  assert.throws(() => validateMediaReview(image), mediaError);
  const veo = fixture(['veo']);
  veo.routes[0].pricing.variants[0].options.duration = 5;
  assert.throws(() => validateMediaReview(veo), mediaError);
});

void test('cheaper generic promotional and no-audio variants cannot substitute the quoted tuple', () => {
  for (const size of ['default', '16:9_5', '16:9_8_no_audio']) {
    const doc = fixture(['veo']);
    doc.routes[0].pricing.variants[0].catalogSize = size;
    assert.throws(() => validateMediaReview(doc), mediaError);
  }
  const doc = fixture();
  doc.routes[0].pricing.variants[0].options.duration = 10;
  assert.throws(() => validateMediaReview(doc), mediaError);
  const image = fixture(['image']);
  image.routes[0].pricing.variants[0].catalogSize = 'default';
  assert.throws(() => validateMediaReview(image), mediaError);
});

void test('catalog absence duplicate IDs duplicate variants and wrong exact prices fail closed', () => {
  const changes = [
    (c) => {
      c.models = [];
    },
    (c) => {
      c.models.push(structuredClone(c.models[0]));
    },
    (c) => {
      c.models[0].modality = 'image';
    },
    (c) => {
      c.models[0].pricing.variants = [];
    },
    (c) => {
      c.models[0].pricing.variants.push(
        structuredClone(c.models[0].pricing.variants[0]),
      );
    },
    (c) => {
      c.models[0].pricing.variants[0].usd6 = 68999;
    },
    (c) => {
      c.models[0].pricing.variants[0].usd6 = 0;
    },
    (c) => {
      c.models[0].pricing.variants[0].usd6 = 69000.5;
    },
    (c) => {
      c.models[0].pricing.variants[0].quality = '1080p';
    },
  ];
  for (const change of changes) {
    const c = catalog();
    change(c);
    assert.throws(
      () => validateMediaCatalog(validateMediaReview(fixture()), c),
      mediaError,
    );
  }
});

void test('public catalog fetch is one bounded credential-free GET and preserves exact decimal price', async () => {
  let count = 0;
  const snapshot = await fetchMediaCatalog({
    fetch: async (url, init) => {
      count++;
      assert.equal(url, routeCatalogUrl());
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(init.headers, { Accept: 'application/json' });
      return new Response(
        '{"data":[{"id":"runway-gen4","type":"video","pricing":{"currency":"USD","variants":[{"quality":"720p","options":[{"size":"16:9_5","price":0.069}]}]}}]}',
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  assert.equal(count, 1);
  assert.equal(snapshot.models[0].pricing.variants[0].usd6, 69000);
  assert.equal(
    validateMediaCatalog(validateMediaReview(fixture()), snapshot).priceCheck,
    'matched',
  );
});

void test('catalog rejects invalid media types oversized bodies timeouts and unsafe precision without raw errors', async () => {
  for (const response of [
    new Response('Provider detail', { status: 500 }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'content-length': '4194305',
      },
    }),
    new Response(
      '{"data":[{"id":"runway-gen4","type":"video","pricing":{"currency":"USD","variants":[{"quality":"720p","options":[{"size":"16:9_5","price":0.0690001}]}]}}]}',
      { headers: { 'content-type': 'application/json' } },
    ),
  ])
    await assert.rejects(fetchMediaCatalog({ fetch: async () => response }), {
      code: 'MEDIA_CATALOG_UNAVAILABLE',
    });
  await assert.rejects(
    fetchMediaCatalog({ fetch: () => new Promise(() => {}), timeoutMs: 1 }),
    { code: 'MEDIA_CATALOG_UNAVAILABLE' },
  );
});

void test('CLI validates offline and rejects implicit network install or activation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conclave-media-review-'));
  try {
    const path = join(directory, 'review.json');
    await writeFile(path, JSON.stringify(fixture()));
    const trap =
      'data:text/javascript,' +
      encodeURIComponent(
        'globalThis.fetch=()=>{throw new Error("Unexpected network")};',
      );
    const run = (args) =>
      spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          trap,
          'scripts/configure-media-routes.mjs',
          ...args,
        ],
        {
          cwd: new URL('../', import.meta.url),
          encoding: 'utf8',
          env: {
            ...process.env,
            CONCLAVE_DATABASE_URL:
              'postgresql://fixture@127.0.0.1:1/unused_test',
          },
          timeout: 5000,
        },
      );
    const local = run([path]);
    assert.equal(local.status, 0);
    assert.deepEqual(JSON.parse(local.stdout), {
      action: 'validated_only',
      routes: 1,
      requestedEnabled: 0,
      catalogChecked: false,
      privacyTier: 'unverified',
      databaseChanged: false,
    });
    for (const flags of [
      ['--enable'],
      ['--install'],
      ['--install', '--enable'],
      ['--unknown'],
    ])
      assert.equal(run([path, ...flags]).status, 1);
    const missing = run([join(directory, 'missing.json')]);
    assert.equal(missing.status, 1);
    assert.deepEqual(JSON.parse(missing.stderr), {
      code: 'MEDIA_CONFIGURATION_FAILED',
    });
    assert.ok(!missing.stderr.includes(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('installation requires fresh catalog evidence and separate enable approval', async () => {
  const doc = fixture();
  await assert.rejects(installReviewedMediaRoutes(pool, doc), {
    code: 'MEDIA_CATALOG_REQUIRED',
  });
  doc.routes[0].enabled = true;
  await assert.rejects(
    installReviewedMediaRoutes(pool, doc, { catalog: catalog() }),
    { code: 'MEDIA_ENABLE_CONFIRMATION_REQUIRED' },
  );
  assert.equal(
    (
      await pool.query('SELECT id FROM route_versions WHERE id=$1', [
        doc.routes[0].id,
      ])
    ).rowCount,
    0,
  );
});

void test('disabled install is immutable and exact replay never activates it', async () => {
  const doc = fixture(),
    c = catalog();
  assert.deepEqual(
    await installReviewedMediaRoutes(pool, doc, { catalog: c }),
    { installed: 1, replayed: 0, enabled: 0 },
  );
  assert.deepEqual(
    await installReviewedMediaRoutes(pool, doc, { catalog: c }),
    { installed: 0, replayed: 1, enabled: 0 },
  );
  let row = (
    await pool.query('SELECT * FROM route_versions WHERE id=$1', [
      doc.routes[0].id,
    ])
  ).rows[0];
  assert.equal(row.enabled, false);
  assert.equal(row.card.catalogVerification.priceCheck, 'matched');
  await assert.rejects(
    pool.query("UPDATE route_versions SET pricing='{}' WHERE id=$1", [row.id]),
    /new route version/,
  );
  doc.routes[0].enabled = true;
  await assert.rejects(
    installReviewedMediaRoutes(pool, doc, { catalog: c, enableReviewed: true }),
    { code: 'MEDIA_VERSION_CONFLICT' },
  );
  row = (await pool.query('SELECT * FROM route_versions WHERE id=$1', [row.id]))
    .rows[0];
  assert.equal(row.enabled, false);
});

void test('explicit enabled installation satisfies runtime contract and later versions are sequential', async () => {
  const doc = fixture(Object.keys(definitions));
  for (const r of doc.routes) r.enabled = true;
  assert.deepEqual(
    await installReviewedMediaRoutes(pool, doc, {
      catalog: catalog(),
      enableReviewed: true,
    }),
    { installed: 4, replayed: 0, enabled: 4 },
  );
  for (const r of doc.routes) {
    const row = (
      await pool.query('SELECT * FROM route_versions WHERE id=$1', [r.id])
    ).rows[0];
    assert.doesNotThrow(() => assertUsableMediaRoute(row));
  }
  const next = {
    version: 1,
    routes: [{ ...doc.routes[0], id: randomUUID(), version: 3 }],
  };
  await assert.rejects(
    installReviewedMediaRoutes(pool, next, {
      catalog: catalog(),
      enableReviewed: true,
    }),
    { code: 'MEDIA_VERSION_SEQUENCE' },
  );
  next.routes[0].version = 2;
  assert.equal(
    (
      await installReviewedMediaRoutes(pool, next, {
        catalog: catalog(),
        enableReviewed: true,
      })
    ).installed,
    1,
  );
});

void test('concurrent exact installs deduplicate and batch conflict rolls back earlier inserts', async () => {
  const doc = fixture(),
    c = catalog();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      installReviewedMediaRoutes(pool, doc, { catalog: c }),
    ),
  );
  assert.equal(
    results.reduce((n, r) => n + r.installed, 0),
    1,
  );
  assert.equal(
    results.reduce((n, r) => n + r.replayed, 0),
    3,
  );
  const fresh = fixture(['veo']);
  const conflict = structuredClone(doc.routes[0]);
  conflict.card.retentionDisclosure =
    'A changed operator review must use a new version.';
  await assert.rejects(
    installReviewedMediaRoutes(
      pool,
      { version: 1, routes: [fresh.routes[0], conflict] },
      { catalog: catalog() },
    ),
    { code: 'MEDIA_VERSION_CONFLICT' },
  );
  assert.equal(
    (
      await pool.query('SELECT id FROM route_versions WHERE id=$1', [
        fresh.routes[0].id,
      ])
    ).rowCount,
    0,
  );
});

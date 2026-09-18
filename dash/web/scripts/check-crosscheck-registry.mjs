import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { GATEWAY_MODEL_ALLOWLIST } from '../server/gateway/catalog.ts';
import {
  routeCatalogUrl,
  installReviewedRoutes,
} from '../server/routes/route-registry.ts';
import {
  checkReviewedRosters,
  installReviewedRosters,
  validateCrossCheckReview,
} from '../server/crosscheck/registry.ts';
import { listReviewerRosters } from '../server/crosscheck/store.ts';
import { migrate } from './migrate.mjs';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set CONCLAVE_TEST_DATABASE_URL to an isolated PostgreSQL test database.',
  );
const endpoint = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
  !endpoint.pathname.endsWith('_test')
)
  throw new Error(
    'Cross-check registry tests require a loopback database whose name ends in _test.',
  );
const pool = createDatabase(connection, 8);
const runFile = promisify(execFile);
const originalFetch = globalThis.fetch;
let providerRequests = 0;
let directory;
before(async () => {
  await migrate(pool);
  directory = await mkdtemp(join(tmpdir(), 'conclave-roster-test-'));
  globalThis.fetch = async () => {
    providerRequests++;
    throw new Error('External requests are forbidden in these tests.');
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
  if (directory) await rm(directory, { recursive: true, force: true });
  assert.equal(providerRequests, 0);
});

function fixture() {
  const now = Date.now() - 1000;
  return {
    version: 1,
    rosters: [
      {
        id: randomUUID(),
        label: `Test roster ${randomUUID()}`,
        version: 1,
        reviewed: true,
        reviewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1800000).toISOString(),
        reviewers: ['gpt', 'claude', 'deepseek'].map((family) => ({
          routeVersionId: randomUUID(),
          modelId: GATEWAY_MODEL_ALLOWLIST[family].id,
          family,
          modelVersion: 'reviewed-fixture-v1',
          distribution: family === 'deepseek' ? 'open-weight' : 'proprietary',
        })),
      },
    ],
  };
}
function routeDocument(document, enabled = false) {
  const now = new Date(Date.now() - 1000).toISOString();
  return {
    version: 1,
    routes: document.rosters.flatMap((roster) =>
      roster.reviewers.map((reviewer) => ({
        id: reviewer.routeVersionId,
        routeId: `test-${randomUUID()}`,
        version: 1,
        modelId: reviewer.modelId,
        family: reviewer.family,
        modality: 'chat',
        enabled,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        card: {
          level: 'unverified',
          reviewed: true,
          provider: 'gateway',
          upstreamProviders: ['Unverified upstream'],
          plaintextVisibility: 'gateway_and_upstream',
          retentionDays: null,
          trainingUse: 'unknown',
          jurisdiction: null,
          legalHold: 'unknown',
          retentionDisclosure:
            'Test only. The gateway and upstream can read this request; retention is unverified.',
          evidenceUrl: 'https://inference.invalid/privacy',
          upstreamEvidenceUrls: [],
          evidenceDate: now.slice(0, 10),
          lastVerifiedAt: now,
        },
        pricing: {
          inputPerMillionUsd6: '1000000',
          outputPerMillionUsd6: '1000000',
          markupBps: 0,
          maxOutputTokens: 1024,
          maxInputBytes: 8192,
        },
      })),
    ),
  };
}
function catalog(routes) {
  return {
    sourceUrl: routeCatalogUrl(),
    fetchedAt: new Date(Date.now() - 1000).toISOString(),
    sha256: 'a'.repeat(64),
    models: routes.map((route) => ({
      id: route.modelId,
      family: route.family,
      modality: 'chat',
      name: 'Test model',
      contextLength: 200000,
      privacyLevel: null,
      strictPrivacyAvailable: false,
      supportedParameters: [],
      pricing: {
        inputPerMillionUsd6: 1000000,
        outputPerMillionUsd6: 1000000,
        baseUsd6: null,
        variants: [],
      },
    })),
  };
}
async function seedRoutes(document, enabled = false) {
  const routes = routeDocument(document, enabled);
  await installReviewedRoutes(
    pool,
    routes,
    enabled ? { enableReviewed: true, catalog: catalog(routes.routes) } : {},
  );
  return routes;
}
async function rawRoutes(document, change) {
  const routes = routeDocument(document);
  change(routes.routes[0]);
  for (const route of routes.routes)
    await pool.query(
      `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,expires_at,card,pricing)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        route.id,
        route.routeId,
        route.version,
        route.modelId,
        route.family,
        route.modality,
        route.enabled,
        route.expiresAt,
        JSON.stringify(route.card),
        JSON.stringify(route.pricing),
      ],
    );
}
async function exists(id) {
  return Number(
    (
      await pool.query(
        'SELECT count(*) AS count FROM crosscheck_rosters WHERE id=$1',
        [id],
      )
    ).rows[0].count,
  );
}
async function cli(document, flags = [], env = {}) {
  const file = join(directory, `${randomUUID()}.json`);
  await writeFile(
    file,
    typeof document === 'string' || Buffer.isBuffer(document)
      ? document
      : JSON.stringify(document),
  );
  try {
    const result = await runFile(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/configure-crosscheck.mjs',
        file,
        ...flags,
      ],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, ...env },
        timeout: 10000,
      },
    );
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

void test('local review validation canonicalizes members, defaults disabled and preserves a family mix', () => {
  const document = fixture();
  const [roster] = validateCrossCheckReview(document);
  assert.equal(roster.enabled, false);
  assert.deepEqual(
    roster.reviewers.map((member) => member.routeVersionId),
    roster.reviewers.map((member) => member.routeVersionId).sort(),
  );
  assert.equal(
    new Set(roster.reviewers.map((member) => member.family)).size,
    3,
  );
  assert.equal(document.rosters[0].enabled, undefined);
});

void test('strict envelopes, accessors, holes, unknown keys, duplicates and unreviewed declarations fail', () => {
  const changes = [
    (d) => {
      d.version = 2;
    },
    (d) => {
      d.token = 'fixture';
    },
    (d) => {
      d.rosters[0].enabled = 'true';
    },
    (d) => {
      d.rosters[0].reviewed = false;
    },
    (d) => {
      d.rosters[0].label = ' trailing ';
    },
    (d) => {
      d.rosters[0].version = 1.5;
    },
    (d) => {
      d.rosters[0].id = 'abcdef01-abcd-4abc-8abc-abcdef012345'.toUpperCase();
    },
    (d) => {
      d.rosters.push(structuredClone(d.rosters[0]));
    },
    (d) => {
      const copy = structuredClone(d.rosters[0]);
      copy.id = randomUUID();
      d.rosters.push(copy);
    },
    (d) => {
      d.rosters[0].reviewers = [];
      d.rosters[0].reviewers.length = 3;
    },
    (d) => {
      d.rosters[0].reviewers['4294967295'] = true;
    },
    (d) => {
      d.rosters[0].reviewers[0].extra = true;
    },
    (d) => {
      Object.defineProperty(d.rosters[0], 'enabled', {
        enumerable: true,
        get() {
          throw new Error('Getter must not execute');
        },
      });
    },
    (d) => {
      d.rosters[0].reviewers[Symbol('extra')] = true;
    },
  ];
  for (const change of changes) {
    const document = fixture();
    change(document);
    assert.throws(() => validateCrossCheckReview(document), {
      code: 'CROSSCHECK_REVIEW_INVALID',
    });
  }
});

void test('declared family, distribution and version cannot manufacture independent reviewers', () => {
  const changes = [
    (r) => {
      r.reviewers[0].family = 'constructor';
    },
    (r) => {
      r.reviewers[0].modelId = 'unreviewed-model';
    },
    (r) => {
      r.reviewers[0].distribution = 'open-weight';
    },
    (r) => {
      r.reviewers[0].modelVersion = 'latest';
    },
    (r) => {
      r.reviewers[0].modelVersion = 'UNKNOWN';
    },
    (r) => {
      r.reviewers[0].modelVersion = '';
    },
    (r) => {
      r.reviewers[0].routeVersionId = r.reviewers[1].routeVersionId;
    },
    (r) => {
      r.reviewers[1] = { ...r.reviewers[0], routeVersionId: randomUUID() };
    },
    (r) => {
      r.reviewers[2] = {
        ...r.reviewers[2],
        family: 'grok',
        modelId: GATEWAY_MODEL_ALLOWLIST.grok.id,
        distribution: 'proprietary',
      };
    },
  ];
  for (const change of changes) {
    const document = fixture();
    change(document.rosters[0]);
    assert.throws(
      () => validateCrossCheckReview(document),
      (error) => error.code.startsWith('CROSSCHECK_'),
    );
  }
});

void test('review dates require exact UTC, nonfuture review and an unexpired maximum one-day interval', () => {
  const changes = [
    (r) => {
      r.reviewedAt = '2026-02-30T00:00:00.000Z';
    },
    (r) => {
      r.reviewedAt = new Date().toISOString().replace('Z', '+00:00');
    },
    (r) => {
      r.reviewedAt = new Date(Date.now() + 100000).toISOString();
    },
    (r) => {
      r.reviewedAt = new Date(Date.now() - 86401000).toISOString();
    },
    (r) => {
      r.expiresAt = new Date(Date.now() - 1).toISOString();
    },
    (r) => {
      r.expiresAt = new Date(Date.parse(r.reviewedAt) + 86400001).toISOString();
    },
  ];
  for (const change of changes) {
    const document = fixture();
    change(document.rosters[0]);
    assert.throws(() => validateCrossCheckReview(document));
  }
});

void test('default CLI validates without a database, provider request, token exposure or execution gate change', async () => {
  const document = fixture();
  document.rosters[0].enabled = true;
  const result = await cli(document, [], {
    CONCLAVE_DATABASE_URL: 'invalid-do-not-connect',
    GATEWAY_API_KEY: 'fixture-sensitive-marker',
    GATEWAY_API_ORIGIN: 'https://api.inference.invalid',
    GATEWAY_EVIDENCE_ORIGINS: '["https://inference.invalid","https://www.inference.invalid"]',
    CONCLAVE_CROSSCHECK_ENABLED: 'false',
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: 'validated_only',
    rosters: 1,
    requestedEnabled: 1,
    databaseChecked: false,
    databaseChanged: false,
    providerRequests: 0,
    executionGateChanged: false,
  });
  for (const privateValue of [
    'fixture-sensitive-marker',
    document.rosters[0].id,
    directory,
  ])
    assert.ok(!`${result.stdout}${result.stderr}`.includes(privateValue));
});

void test('CLI bounds input, rejects unsupported arguments and sanitizes errors', async () => {
  for (const body of ['{', Buffer.from([0xff]), ' '.repeat(131073)]) {
    const result = await cli(body);
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      code: 'CROSSCHECK_CONFIGURATION_FAILED',
    });
  }
  for (const flags of [
    ['--enable-reviewed'],
    ['--install', '--install'],
    ['--send-to-provider'],
  ]) {
    const result = await cli(fixture(), flags);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Usage:/);
    assert.ok(!result.stderr.includes(directory));
  }
  const dbError = await cli(fixture(), ['--check-routes'], {
    CONCLAVE_DATABASE_URL: 'invalid-sensitive-database-value',
  });
  assert.equal(dbError.code, 1);
  assert.deepEqual(JSON.parse(dbError.stderr), {
    code: 'CROSSCHECK_CONFIGURATION_FAILED',
  });
});

void test('database preflight is read-only and disabled rosters can stage against disabled reviewed routes', async () => {
  const document = fixture();
  await seedRoutes(document);
  assert.deepEqual(await checkReviewedRosters(pool, document), {
    rosters: 1,
    newVersions: 1,
    replayed: 0,
    requestedEnabled: 0,
    routeVersions: 3,
    enableEligible: 0,
  });
  assert.equal(await exists(document.rosters[0].id), 0);
  const result = await installReviewedRosters(pool, document);
  assert.deepEqual(result, {
    installed: 1,
    replayed: 0,
    enabled: 0,
    routeVersions: 3,
    enableEligible: 0,
  });
  const row = (
    await pool.query('SELECT * FROM crosscheck_rosters WHERE id=$1', [
      document.rosters[0].id,
    ])
  ).rows[0];
  assert.equal(row.enabled, false);
  assert.deepEqual(Object.keys(row.reviewers[0]).sort(), [
    'distribution',
    'modelVersion',
    'routeVersionId',
  ]);
  assert.equal((await checkReviewedRosters(pool, document)).replayed, 1);
});

void test('missing routes, exact identity mismatch and invalid privacy terms fail without partial writes', async () => {
  const absent = fixture();
  await assert.rejects(checkReviewedRosters(pool, absent), {
    code: 'CROSSCHECK_ROUTE_MISMATCH',
  });
  for (const [change, code] of [
    [
      (r) => {
        r.modelId = 'unreviewed-model';
      },
      'CROSSCHECK_ROUTE_MISMATCH',
    ],
    [
      (r) => {
        r.card.reviewed = false;
      },
      'CROSSCHECK_ROUTE_REVIEW_REQUIRED',
    ],
    [
      (r) => {
        r.card = null;
      },
      'CROSSCHECK_ROUTE_REVIEW_REQUIRED',
    ],
    [
      (r) => {
        r.pricing.maxInputBytes = 32769;
      },
      'CROSSCHECK_ROUTE_REVIEW_REQUIRED',
    ],
    [
      (r) => {
        r.card.lastVerifiedAt = new Date(Date.now() - 86401000).toISOString();
      },
      'CROSSCHECK_ROUTE_REVIEW_REQUIRED',
    ],
  ]) {
    const document = fixture();
    await rawRoutes(document, change);
    await assert.rejects(installReviewedRosters(pool, document), { code });
    assert.equal(await exists(document.rosters[0].id), 0);
  }
});

void test('a roster cannot outlive even one installed route or accept an expired route', async () => {
  const early = fixture();
  await rawRoutes(early, (r) => {
    r.expiresAt = new Date(Date.now() + 60000).toISOString();
  });
  await assert.rejects(installReviewedRosters(pool, early), {
    code: 'CROSSCHECK_ROUTE_EXPIRES_FIRST',
  });
  const stale = fixture();
  await rawRoutes(stale, (r) => {
    r.expiresAt = new Date(Date.now() - 100).toISOString();
  });
  await assert.rejects(checkReviewedRosters(pool, stale), {
    code: 'CROSSCHECK_ROUTE_REVIEW_REQUIRED',
  });
});

void test('enabled insertion requires both explicit enable flag and enabled catalog-reviewed routes', async () => {
  const document = fixture();
  document.rosters[0].enabled = true;
  await seedRoutes(document);
  await assert.rejects(installReviewedRosters(pool, document), {
    code: 'CROSSCHECK_ENABLE_CONFIRMATION_REQUIRED',
  });
  await assert.rejects(
    installReviewedRosters(pool, document, { enableReviewed: true }),
    { code: 'CROSSCHECK_ROUTE_NOT_ENABLED' },
  );
  await pool.query(
    'UPDATE route_versions SET enabled=true WHERE id=ANY($1::uuid[])',
    [document.rosters[0].reviewers.map((r) => r.routeVersionId)],
  );
  await assert.rejects(
    installReviewedRosters(pool, document, { enableReviewed: true }),
    { code: 'CROSSCHECK_ROUTE_NOT_ENABLED' },
  );
  assert.equal(await exists(document.rosters[0].id), 0);
});

void test('enabled current roster integrates with runtime discovery and does not alter execution gates', async () => {
  const document = fixture();
  document.rosters[0].enabled = true;
  await seedRoutes(document, true);
  const gate = process.env.CONCLAVE_CROSSCHECK_ENABLED;
  assert.equal((await checkReviewedRosters(pool, document)).enableEligible, 1);
  const result = await installReviewedRosters(pool, document, {
    enableReviewed: true,
  });
  assert.equal(result.enabled, 1);
  assert.equal(process.env.CONCLAVE_CROSSCHECK_ENABLED, gate);
  const current = (await listReviewerRosters(pool)).find(
    (roster) => roster.id === document.rosters[0].id,
  );
  assert.equal(current.reviewers.length, 3);
  assert.deepEqual(
    new Set(current.reviewers.map((r) => r.distribution)),
    new Set(['proprietary', 'open-weight']),
  );
});

void test('catalog evidence with wrong source, future time or stale time cannot activate a roster', async () => {
  for (const change of [
    (e) => {
      e.sourceUrl = 'https://example.invalid/models';
    },
    (e) => {
      e.fetchedAt = new Date(Date.now() + 100000).toISOString();
    },
    (e) => {
      e.fetchedAt = new Date(Date.now() - 86401000).toISOString();
    },
    (e) => {
      e.priceCheck = 'not_checked';
    },
  ]) {
    const document = fixture();
    document.rosters[0].enabled = true;
    const routes = routeDocument(document, true);
    for (const route of routes.routes)
      route.card.catalogVerification = {
        sourceUrl: routeCatalogUrl(),
        fetchedAt: new Date(Date.now() - 1000).toISOString(),
        sha256: 'a'.repeat(64),
        priceCheck: 'matched',
      };
    change(routes.routes[0].card.catalogVerification);
    for (const route of routes.routes)
      await pool.query(
        `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,expires_at,card,pricing)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          route.id,
          route.routeId,
          route.version,
          route.modelId,
          route.family,
          route.modality,
          true,
          route.expiresAt,
          JSON.stringify(route.card),
          JSON.stringify(route.pricing),
        ],
      );
    await assert.rejects(
      installReviewedRosters(pool, document, { enableReviewed: true }),
      { code: 'CROSSCHECK_ROUTE_NOT_ENABLED' },
    );
  }
});

void test('concurrent exact installation is idempotent and never overwrites terms or enablement', async () => {
  const document = fixture();
  await seedRoutes(document, true);
  const results = await Promise.all([
    installReviewedRosters(pool, document),
    installReviewedRosters(pool, document),
  ]);
  assert.equal(
    results.reduce((count, result) => count + result.installed, 0),
    1,
  );
  assert.equal(
    results.reduce((count, result) => count + result.replayed, 0),
    1,
  );
  for (const change of [
    (r) => {
      r.enabled = true;
    },
    (r) => {
      r.reviewers[0].modelVersion = 'reviewed-fixture-v2';
    },
    (r) => {
      r.expiresAt = new Date(Date.parse(r.expiresAt) - 1000).toISOString();
    },
    (r) => {
      r.label += ' changed';
    },
    (r) => {
      r.id = randomUUID();
    },
  ]) {
    const changed = structuredClone(document);
    change(changed.rosters[0]);
    await assert.rejects(
      installReviewedRosters(pool, changed, { enableReviewed: true }),
      { code: 'CROSSCHECK_ROSTER_VERSION_CONFLICT' },
    );
  }
  assert.equal(await exists(document.rosters[0].id), 1);
});

void test('sequential immutable versions permit reviewed enablement without changing prior versions', async () => {
  const document = fixture();
  await seedRoutes(document, true);
  await installReviewedRosters(pool, document);
  const next = structuredClone(document);
  next.rosters[0].id = randomUUID();
  next.rosters[0].version = 3;
  await assert.rejects(installReviewedRosters(pool, next), {
    code: 'CROSSCHECK_ROSTER_VERSION_SEQUENCE',
  });
  next.rosters[0].version = 2;
  next.rosters[0].enabled = true;
  assert.equal(
    (await installReviewedRosters(pool, next, { enableReviewed: true }))
      .installed,
    1,
  );
  const rows = (
    await pool.query(
      'SELECT version,enabled FROM crosscheck_rosters WHERE label=$1 ORDER BY version',
      [document.rosters[0].label],
    )
  ).rows;
  assert.deepEqual(rows, [
    { version: 1, enabled: false },
    { version: 2, enabled: true },
  ]);
});

void test('multi-roster conflict rolls back earlier inserts and CLI preflight does not write', async () => {
  const existing = fixture();
  await seedRoutes(existing);
  await installReviewedRosters(pool, existing);
  const fresh = fixture();
  await seedRoutes(fresh);
  const combined = {
    version: 1,
    rosters: [fresh.rosters[0], { ...existing.rosters[0], id: randomUUID() }],
  };
  await assert.rejects(installReviewedRosters(pool, combined), {
    code: 'CROSSCHECK_ROSTER_VERSION_CONFLICT',
  });
  assert.equal(await exists(fresh.rosters[0].id), 0);
  const result = await cli(fresh, ['--check-routes'], {
    CONCLAVE_DATABASE_URL: connection,
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).databaseChanged, false);
  assert.equal(await exists(fresh.rosters[0].id), 0);
});

void test('CLI explicit install and enable flags insert once with counts-only output', async () => {
  const document = fixture();
  document.rosters[0].enabled = true;
  await seedRoutes(document, true);
  const denied = await cli(document, ['--install'], {
    CONCLAVE_DATABASE_URL: connection,
  });
  assert.equal(denied.code, 1);
  assert.deepEqual(JSON.parse(denied.stderr), {
    code: 'CROSSCHECK_ENABLE_CONFIRMATION_REQUIRED',
  });
  assert.equal(await exists(document.rosters[0].id), 0);
  const result = await cli(document, ['--install', '--enable-reviewed'], {
    CONCLAVE_DATABASE_URL: connection,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: 'installed',
    installed: 1,
    replayed: 0,
    enabled: 1,
    routeVersions: 3,
    enableEligible: 1,
    databaseChanged: true,
    providerRequests: 0,
    executionGateChanged: false,
  });
  const replay = await cli(document, ['--install', '--enable-reviewed'], {
    CONCLAVE_DATABASE_URL: connection,
  });
  assert.equal(JSON.parse(replay.stdout).databaseChanged, false);
  assert.ok(
    !`${result.stdout}${result.stderr}`.includes(document.rosters[0].id),
  );
});

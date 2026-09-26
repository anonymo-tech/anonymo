import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { creditVerifiedDeposit, getBalance } from '../server/ledger/ledger.ts';
import {
  createMediaQuote,
  createMediaJob,
  getOwnedMedia,
} from '../server/media/store.ts';
import { runNextMediaJob } from '../server/media/worker.ts';
import {
  runNextMediaIngest,
  recoverExpiredMediaIngests,
} from '../server/media/ingest.ts';
import { readOwnedMediaAsset } from '../server/media/assets.ts';
import sharp from 'sharp';
import { MediaSanitizeError } from '../server/media/sanitize.ts';
import { recoverExpiredMediaJobs } from '../server/media/worker.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error('An isolated CONCLAVE_TEST_DATABASE_URL is required.');
const url = new URL(connection);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('Only loopback test databases are supported.');
const pool = createDatabase(connection, 8);
before(() => migrate(pool));
after(() => pool.end());
const keyring = {
  active: 'test',
  keys: { test: randomBytes(32).toString('base64') },
};
const env = {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://app.example.invalid',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_INFERENCE_ENABLED: 'true',
  CONCLAVE_MEDIA_ENABLED: 'true',
  GATEWAY_API_KEY: randomBytes(16).toString('hex'),
  GATEWAY_API_ORIGIN: 'https://api.inference.invalid',
  GATEWAY_EVIDENCE_ORIGINS: '["https://inference.invalid","https://www.inference.invalid"]',
  CONCLAVE_ACTIVE_DATA_KEY: 'test',
  CONCLAVE_DATA_KEYS: JSON.stringify(keyring.keys),
};
const runtime = {
  env,
  storageReady: true,
  storagePolicy: {
    accountBytes: 1024 * 1024 * 1024,
    globalBytes: 16 * 1024 * 1024 * 1024,
  },
};
const imageOptions = {
  kind: 'image',
  count: 1,
  resolution: '1K',
  aspectRatio: '1:1',
};
function provider(overrides = {}) {
  const unexpected = async () => {
    throw new Error('Unexpected provider method.');
  };
  return {
    configured: true,
    generateImage: unexpected,
    recoverImage: unexpected,
    submitVideo: unexpected,
    videoStatus: unexpected,
    ...overrides,
  };
}
async function fixture(modality = 'image') {
  const accountId = randomUUID(),
    projectId = randomUUID(),
    routeVersionId = randomUUID(),
    now = new Date().toISOString();
  const options =
    modality === 'image'
      ? imageOptions
      : {
          kind: 'video',
          duration: 5,
          quality: 'standard',
          aspectRatio: '16:9',
        };
  const card = {
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
  };
  const pricing = {
    kind: 'media-fixed-v1',
    maxInputBytes: 16000,
    markupBps: 1000,
    variants: [
      {
        options,
        providerUsd6: '100000',
        catalogQuality: 'standard',
        catalogSize: modality === 'image' ? '1K' : '16:9_5',
      },
    ],
  };
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    'INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)',
    [projectId, accountId, 'Media test'],
  );
  await pool.query(
    "INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) VALUES($1,$2,1,$3,$4,$5,true,$6,$7,now()+interval '10 minutes')",
    [
      routeVersionId,
      `media-${routeVersionId}`,
      modality === 'image' ? 'nano-banana-2' : 'kling-2.5-turbo',
      modality === 'image' ? 'image' : 'kling',
      modality,
      card,
      pricing,
    ],
  );
  await creditVerifiedDeposit(pool, {
    accountId,
    reference: `media-fixture:${accountId}`,
    amountUsd6: '10000000',
  });
  const input = {
    prompt: 'A stone arch at dawn',
    privacy: 'standard',
    options,
  };
  return { accountId, projectId, routeVersionId, input, card, pricing };
}
async function queued(f) {
  const quote = await createMediaQuote(
    pool,
    f.accountId,
    f.projectId,
    f.routeVersionId,
    f.input,
    keyring,
    runtime,
  );
  const idempotencyKey = randomUUID();
  const created = await createMediaJob(
    pool,
    f.accountId,
    quote.id,
    idempotencyKey,
    quote.maximumUsd6,
    keyring,
    runtime,
  );
  return { ...created, quote, idempotencyKey };
}
const imageResult = (jobId, cost = 50000) => ({
  clientRequestId: jobId,
  modelId: 'nano-banana-2',
  status: 'completed',
  media: [
    {
      url: 'https://api.inference.invalid/v1/media/test_media/0?sig=example&exp=1',
      contentType: 'image/png',
    },
  ],
  costUsd6: cost,
});
async function read(f, id) {
  return getOwnedMedia(pool, f.accountId, id, keyring);
}
async function completed() {
  const f = await fixture();
  const { job } = await queued(f);
  let submissions = 0;
  await runNextMediaJob(
    pool,
    provider({
      generateImage: async () => {
        submissions++;
        return imageResult(job.id);
      },
    }),
    keyring,
    runtime,
  );
  assert.equal(submissions, 1);
  assert.equal((await read(f, job.id)).state, 'completed');
  return { ...f, job };
}
const png = await sharp({
  create: { width: 32, height: 32, channels: 3, background: '#d52d23' },
})
  .withExif({ IFD0: { Artist: 'SYNTHETIC_METADATA' } })
  .png()
  .toBuffer();
const fetched = () =>
  new Response(png, { headers: { 'Content-Type': 'image/png' } });
async function importState(id) {
  return (
    await pool.query(
      'SELECT state,attempts,error_code,lease_token FROM media_ingests WHERE job_id=$1',
      [id],
    )
  ).rows[0];
}
async function asset(id) {
  return (await pool.query('SELECT * FROM media_assets WHERE job_id=$1', [id]))
    .rows[0];
}
async function billing(id) {
  return (
    await pool.query(
      'SELECT h.* FROM holds h JOIN media_jobs j ON j.hold_id=h.id WHERE j.id=$1',
      [id],
    )
  ).rows[0];
}

void test('canonical import stores owned encrypted bytes without changing the captured charge', async () => {
  const f = await completed(),
    before = await billing(f.job.id);
  let gets = 0;
  assert.equal(
    await runNextMediaIngest(pool, keyring, {
      fetch: async (url, init) => {
        gets++;
        assert.equal(init.method, 'GET');
        assert.equal(init.credentials, 'omit');
        assert.equal(new URL(url).origin, 'https://api.inference.invalid');
        return fetched();
      },
    }),
    true,
  );
  assert.equal(gets, 1);
  assert.equal((await importState(f.job.id)).state, 'completed');
  const stored = await asset(f.job.id);
  assert.equal(stored.state, 'ready');
  const plain = await readOwnedMediaAsset(
    pool,
    f.accountId,
    stored.id,
    keyring,
  );
  assert.equal(plain.contentType, 'image/png');
  assert.equal(
    Buffer.from(plain.bytes).includes(Buffer.from('SYNTHETIC_METADATA')),
    false,
  );
  assert.equal((await sharp(plain.bytes).metadata()).exif, undefined);
  assert.deepEqual(await billing(f.job.id), before);
  const view = await read(f, f.job.id);
  assert.equal(view.mediaAssetState, 'stored');
  assert.equal(view.processingState, 'completed');
  assert.equal(view.deliveryReady, true);
  assert.equal(view.asset.contentType, 'image/png');
  assert.ok(view.asset.byteLength > 0);
  assert.equal(JSON.stringify(view).includes('sig='), false);
  assert.equal(
    await runNextMediaIngest(pool, keyring, {
      fetch: async () => {
        throw new Error();
      },
    }),
    false,
  );
});

void test('concurrent import workers acquire one lease and perform one retrieval', async () => {
  const f = await completed();
  let start, finish;
  const started = new Promise((r) => {
      start = r;
    }),
    gate = new Promise((r) => {
      finish = r;
    });
  const first = runNextMediaIngest(pool, keyring, {
    fetch: async () => {
      start();
      await gate;
      return fetched();
    },
  });
  await started;
  assert.equal(
    await runNextMediaIngest(pool, keyring, {
      fetch: async () => {
        throw new Error('Should not acquire');
      },
    }),
    false,
  );
  finish();
  await first;
  assert.equal((await importState(f.job.id)).attempts, 1);
  assert.equal((await asset(f.job.id)).state, 'ready');
});

void test('transient acquisition failure retains storage and billing then retries only retrieval', async () => {
  const f = await completed(),
    before = await billing(f.job.id);
  await runNextMediaIngest(pool, keyring, {
    fetch: async () => {
      throw new Error('synthetic private provider diagnostic');
    },
  });
  const pending = await importState(f.job.id);
  assert.equal(pending.state, 'retry');
  assert.equal(pending.error_code, 'MEDIA_INGEST_RETRY');
  assert.equal((await asset(f.job.id)).state, 'reserved');
  assert.deepEqual(await billing(f.job.id), before);
  assert.equal(
    await runNextMediaIngest(pool, keyring, { fetch: async () => fetched() }),
    false,
  );
  await pool.query(
    'UPDATE media_ingests SET next_attempt_at=now() WHERE job_id=$1',
    [f.job.id],
  );
  await runNextMediaIngest(pool, keyring, { fetch: async () => fetched() });
  assert.equal((await importState(f.job.id)).attempts, 2);
  assert.deepEqual(await billing(f.job.id), before);
});

void test('unsupported image processing fails privately and never refunds a generation charge', async () => {
  const f = await completed(),
    before = await billing(f.job.id);
  await runNextMediaIngest(pool, keyring, {
    fetch: async () =>
      new Response(png.subarray(0, 40), {
        headers: { 'Content-Type': 'image/png' },
      }),
  });
  const result = await importState(f.job.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.error_code, 'MEDIA_SANITIZATION_FAILED');
  assert.equal((await asset(f.job.id)).state, 'released');
  assert.equal((await asset(f.job.id)).allocated_bytes, 0);
  assert.deepEqual(await billing(f.job.id), before);
});

void test('expired importer cannot overwrite the asset committed by its replacement', async () => {
  const f = await completed(),
    before = await billing(f.job.id);
  let start, finish;
  const started = new Promise((r) => {
      start = r;
    }),
    gate = new Promise((r) => {
      finish = r;
    });
  const old = runNextMediaIngest(pool, keyring, {
    fetch: async () => {
      start();
      await gate;
      return fetched();
    },
  });
  await started;
  await pool.query(
    "UPDATE media_ingests SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
    [f.job.id],
  );
  assert.equal(await recoverExpiredMediaIngests(pool), 1);
  await runNextMediaIngest(pool, keyring, { fetch: async () => fetched() });
  const stored = await asset(f.job.id);
  finish();
  await old;
  assert.deepEqual(await asset(f.job.id), stored);
  assert.equal((await importState(f.job.id)).attempts, 2);
  assert.deepEqual(await billing(f.job.id), before);
});

void test('capacity rejection rolls back the new job and its payment hold atomically', async () => {
  const f = await fixture();
  const quote = await createMediaQuote(
    pool,
    f.accountId,
    f.projectId,
    f.routeVersionId,
    f.input,
    keyring,
    runtime,
  );
  const before = await getBalance(pool, f.accountId);
  await assert.rejects(
    createMediaJob(
      pool,
      f.accountId,
      quote.id,
      randomUUID(),
      quote.maximumUsd6,
      keyring,
      {
        ...runtime,
        storagePolicy: { accountBytes: 100, globalBytes: 1024 ** 4 },
      },
    ),
    { code: 'MEDIA_ACCOUNT_STORAGE_LIMIT' },
  );
  assert.deepEqual(await getBalance(pool, f.accountId), before);
  for (const table of ['media_jobs', 'holds', 'media_assets']) {
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE account_id=$1`,
          [f.accountId],
        )
      ).rows[0].n,
      0,
    );
  }
});

void test('import attempts are bounded and shutdown never starts acquisition', async () => {
  const f = await completed();
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(
    await runNextMediaIngest(pool, keyring, { signal: cancelled.signal }),
    false,
  );
  await pool.query(
    "UPDATE media_ingests SET state='retry',attempts=9 WHERE job_id=$1",
    [f.job.id],
  );
  await runNextMediaIngest(pool, keyring, {
    fetch: async () => {
      throw new Error();
    },
  });
  const result = await importState(f.job.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.attempts, 10);
  assert.equal(await runNextMediaIngest(pool, keyring), false);
});

void test('shutdown and unavailable processors retain safe retrieval recovery', async () => {
  for (const code of ['cancelled', 'timeout', 'unavailable']) {
    const f = await completed(),
      before = await billing(f.job.id);
    const stop = new AbortController();
    await runNextMediaIngest(pool, keyring, {
      fetch: async () => fetched(),
      signal: stop.signal,
      sanitize: async () => {
        if (code === 'cancelled') stop.abort();
        throw new MediaSanitizeError(code);
      },
    });
    assert.equal((await importState(f.job.id)).state, 'retry');
    assert.equal((await asset(f.job.id)).state, 'reserved');
    assert.deepEqual(await billing(f.job.id), before);
    await pool.query(
      'UPDATE media_ingests SET next_attempt_at=now() WHERE job_id=$1',
      [f.job.id],
    );
    await runNextMediaIngest(pool, keyring, { fetch: async () => fetched() });
    assert.equal((await importState(f.job.id)).state, 'completed');
  }
});

void test('crash before generation dispatch releases storage and payment together', async () => {
  const f = await fixture(),
    { job } = await queued(f);
  await pool.query(
    "UPDATE media_jobs SET lease_token=$2,lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [job.id, randomUUID()],
  );
  assert.equal(await recoverExpiredMediaJobs(pool), 1);
  const stored = await asset(job.id);
  assert.equal(stored.state, 'released');
  assert.equal(stored.allocated_bytes, 0);
  assert.equal((await read(f, job.id)).billing.actualUsd6, '0');
});

void test('exhausted importer lease releases capacity without altering its captured charge', async () => {
  const f = await completed(),
    before = await billing(f.job.id);
  await pool.query(
    "UPDATE media_ingests SET state='processing',attempts=10,lease_token=$2,lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
    [f.job.id, randomUUID()],
  );
  assert.equal(await recoverExpiredMediaIngests(pool), 1);
  assert.equal((await importState(f.job.id)).state, 'failed');
  assert.equal((await asset(f.job.id)).state, 'released');
  assert.deepEqual(await billing(f.job.id), before);
});

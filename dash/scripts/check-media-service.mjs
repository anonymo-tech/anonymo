import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { decryptText, encryptText } from '../server/core/encryption.ts';
import { creditVerifiedDeposit, getBalance } from '../server/ledger/ledger.ts';
import {
  createMediaQuote,
  createMediaJob,
  getOwnedMedia,
  listOwnedMedia,
  listMediaRoutes,
  cancelOwnedMedia,
  recoverOwnedMedia,
} from '../server/media/store.ts';
import {
  runNextMediaJob,
  recoverExpiredMediaJobs,
} from '../server/media/worker.ts';
import { mediaRoutes } from '../server/routes/media.ts';
import { handleApi } from '../server/core/http.ts';
import { GatewayError } from '../server/gateway/index.ts';
import { mediaRequestHash } from '../server/media/contract.ts';

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
const videoResult = (id, status = 'pending', cost = null) => ({
  id,
  modelId: 'kling-2.5-turbo',
  status,
  media:
    status === 'completed'
      ? {
          url: 'https://api.inference.invalid/v1/media/test_video/0?sig=example&exp=1',
          contentType: 'video/mp4',
        }
      : null,
  estimatedCostUsd6: 100000,
  costUsd6: cost,
});
async function due(id) {
  await pool.query('UPDATE media_jobs SET next_poll_at=now() WHERE id=$1', [
    id,
  ]);
}
async function read(f, id) {
  return getOwnedMedia(pool, f.accountId, id, keyring);
}
async function quiesce() {
  await pool.query(
    `UPDATE media_jobs SET next_poll_at=NULL WHERE lease_token IS NULL AND state IN ('polling','reconciliation_pending')`,
  );
}

void test('storage readiness cannot be asserted by environment and routes are readable with paid gate disabled', async () => {
  const f = await fixture();
  await assert.rejects(
    createMediaQuote(
      pool,
      f.accountId,
      f.projectId,
      f.routeVersionId,
      f.input,
      keyring,
      { env },
    ),
    (e) => e.code === 'MEDIA_STORAGE_REQUIRED',
  );
  assert.equal(
    (await listMediaRoutes(pool, f.accountId)).routes.some(
      (r) => r.versionId === f.routeVersionId,
    ),
    true,
  );
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '0');
  let touched = false;
  assert.equal(
    await runNextMediaJob(
      pool,
      {
        ...provider(),
        configured: false,
        generateImage: async () => {
          touched = true;
        },
      },
      keyring,
      runtime,
    ),
    false,
  );
  assert.equal(touched, false);
});
void test('quotes and concurrent approval reserve once and replay survives a disabled feature', async () => {
  const f = await fixture(),
    q = await createMediaQuote(
      pool,
      f.accountId,
      f.projectId,
      f.routeVersionId,
      f.input,
      keyring,
      runtime,
    ),
    key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      createMediaJob(
        pool,
        f.accountId,
        q.id,
        key,
        q.maximumUsd6,
        keyring,
        runtime,
      ),
    ),
  );
  assert.equal(new Set(results.map((r) => r.job.id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '110000');
  assert.equal(
    (
      await createMediaJob(
        pool,
        f.accountId,
        q.id,
        key,
        q.maximumUsd6,
        keyring,
        {},
      )
    ).replayed,
    true,
  );
  await assert.rejects(
    createMediaJob(pool, f.accountId, q.id, key, '110001', keyring, runtime),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  await cancelOwnedMedia(pool, f.accountId, results[0].job.id, keyring);
});
void test('cross-owner project quote detail cancel recovery and cursors do not disclose jobs', async () => {
  const f = await fixture(),
    other = await fixture(),
    q = await queued(f);
  await assert.rejects(
    createMediaQuote(
      pool,
      other.accountId,
      f.projectId,
      f.routeVersionId,
      f.input,
      keyring,
      runtime,
    ),
    (e) => e.code === 'PROJECT_NOT_FOUND',
  );
  await assert.rejects(
    createMediaJob(
      pool,
      other.accountId,
      q.quote.id,
      randomUUID(),
      q.quote.maximumUsd6,
      keyring,
      runtime,
    ),
    (e) => e.code === 'QUOTE_NOT_FOUND',
  );
  for (const action of [getOwnedMedia, cancelOwnedMedia, recoverOwnedMedia])
    await assert.rejects(
      action(pool, other.accountId, q.job.id, keyring),
      (e) => e.code === 'MEDIA_NOT_FOUND',
    );
  await assert.rejects(
    listOwnedMedia(pool, other.accountId, f.projectId, null, keyring),
    (e) => e.code === 'PROJECT_NOT_FOUND',
  );
  await cancelOwnedMedia(pool, f.accountId, q.job.id, keyring);
});
void test('approval requires the exact quote and source stays encrypted with no public provider URLs', async () => {
  const f = await fixture(),
    q = await createMediaQuote(
      pool,
      f.accountId,
      f.projectId,
      f.routeVersionId,
      f.input,
      keyring,
      runtime,
    );
  await assert.rejects(
    createMediaJob(
      pool,
      f.accountId,
      q.id,
      randomUUID(),
      '109999',
      keyring,
      runtime,
    ),
    (e) => e.code === 'MEDIA_APPROVAL_MISMATCH',
  );
  const c = await createMediaJob(
      pool,
      f.accountId,
      q.id,
      randomUUID(),
      q.maximumUsd6,
      keyring,
      runtime,
    ),
    row = (
      await pool.query('SELECT input_ciphertext FROM media_jobs WHERE id=$1', [
        c.job.id,
      ])
    ).rows[0];
  assert.ok(!row.input_ciphertext.includes(f.input.prompt));
  await assert.rejects(
    decryptText(
      row.input_ciphertext,
      `${f.accountId}:media-input:${randomUUID()}`,
      keyring,
    ),
  );
  await runNextMediaJob(
    pool,
    provider({
      generateImage: async (input) => imageResult(input.clientRequestId),
    }),
    keyring,
    runtime,
  );
  const job = await read(f, c.job.id);
  assert.equal(job.state, 'completed');
  assert.equal(job.mediaAssetState, 'pending_storage');
  assert.equal(job.deliveryReady, false);
  assert.equal(job.billing.actualUsd6, '55000');
  assert.ok(!JSON.stringify(job).includes('api.inference.invalid'));
  assert.ok(!JSON.stringify(job).includes('sig='));
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '0');
});
void test('safe pre-dispatch cancellation and disabled dispatch release the full hold without provider calls', async () => {
  const f = await fixture(),
    q = await queued(f);
  await cancelOwnedMedia(pool, f.accountId, q.job.id, keyring);
  assert.equal((await read(f, q.job.id)).state, 'cancelled');
  const second = await queued(f);
  let submitted = 0;
  await runNextMediaJob(
    pool,
    provider({
      generateImage: async () => {
        submitted++;
      },
    }),
    keyring,
    { env, storageReady: false },
  );
  assert.equal(submitted, 0);
  assert.equal((await read(f, second.job.id)).state, 'failed');
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '0');
});
void test('image submission ambiguity recovers only by the persisted key and does not submit twice', async () => {
  const f = await fixture(),
    q = await queued(f);
  let posts = 0,
    reads = 0;
  const p = provider({
    generateImage: async () => {
      posts++;
      throw new GatewayError('timeout', true);
    },
    recoverImage: async (key) => {
      reads++;
      assert.equal(key, q.job.id);
      return imageResult(key);
    },
  });
  await runNextMediaJob(pool, p, keyring, runtime);
  assert.equal((await read(f, q.job.id)).state, 'reconciliation_pending');
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '110000');
  await due(q.job.id);
  await runNextMediaJob(pool, p, keyring, { env, storageReady: false });
  assert.equal((await read(f, q.job.id)).state, 'completed');
  assert.equal(posts, 1);
  assert.equal(reads, 1);
});
void test('ambiguous video submission with no durable provider identity requires operator reconciliation', async () => {
  const f = await fixture('video'),
    q = await queued(f);
  let posts = 0;
  await runNextMediaJob(
    pool,
    provider({
      submitVideo: async () => {
        posts++;
        throw new GatewayError('timeout', true);
      },
    }),
    keyring,
    runtime,
  );
  const job = await read(f, q.job.id);
  assert.equal(job.state, 'reconciliation_pending');
  assert.equal(job.canRecover, false);
  await assert.rejects(
    recoverOwnedMedia(pool, f.accountId, q.job.id, keyring),
    (e) => e.code === 'MEDIA_RECOVERY_UNAVAILABLE',
  );
  assert.equal(
    await runNextMediaJob(pool, provider(), keyring, runtime),
    false,
  );
  assert.equal(posts, 1);
  await quiesce();
});
void test('known video polling remains durable after cancellation and settles exact cost with generation disabled', async () => {
  const f = await fixture('video'),
    q = await queued(f),
    ref = `video_${randomUUID()}`;
  let posts = 0,
    reads = 0;
  const p = provider({
    submitVideo: async () => {
      posts++;
      return videoResult(ref);
    },
    videoStatus: async (id) => {
      reads++;
      assert.equal(id, ref);
      return videoResult(ref, 'completed', 75000);
    },
  });
  await runNextMediaJob(pool, p, keyring, runtime);
  assert.equal((await read(f, q.job.id)).state, 'polling');
  const cancelled = await cancelOwnedMedia(
    pool,
    f.accountId,
    q.job.id,
    keyring,
  );
  assert.equal(cancelled.providerCancellation, false);
  assert.equal(cancelled.job.cancelRequested, true);
  assert.equal(cancelled.job.billing.actualUsd6, null);
  await due(q.job.id);
  await runNextMediaJob(pool, p, keyring, {
    env: { ...env, CONCLAVE_MEDIA_ENABLED: 'false' },
    storageReady: false,
  });
  const job = await read(f, q.job.id);
  assert.equal(job.state, 'completed');
  assert.equal(job.billing.actualUsd6, '82500');
  assert.equal(posts, 1);
  assert.equal(reads, 1);
});
void test('missing and excessive actual costs never invent zero charge or debit beyond approval', async () => {
  for (const cost of [null, 100001]) {
    const f = await fixture(),
      q = await queued(f);
    await runNextMediaJob(
      pool,
      provider({
        generateImage: async (input) =>
          imageResult(input.clientRequestId, cost),
      }),
      keyring,
      runtime,
    );
    const job = await read(f, q.job.id);
    assert.equal(job.state, 'reconciliation_pending');
    assert.equal(job.billing.actualUsd6, null);
    assert.equal(job.billing.state, 'reconciliation_pending');
    assert.equal(job.mediaAssetState, 'pending_storage');
    assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '110000');
    await quiesce();
  }
});
void test('terminal failed generations settle only an explicit verified cost', async () => {
  const f = await fixture(),
    q = await queued(f);
  await runNextMediaJob(
    pool,
    provider({
      generateImage: async (input) => ({
        ...imageResult(input.clientRequestId, 10000),
        status: 'failed',
        media: [],
      }),
    }),
    keyring,
    runtime,
  );
  const job = await read(f, q.job.id);
  assert.equal(job.state, 'failed');
  assert.equal(job.billing.actualUsd6, '11000');
  assert.equal(job.mediaAssetState, 'none');
});
void test('lease recovery distinguishes an undispatched reservation from an ambiguous paid dispatch', async () => {
  const f = await fixture(),
    q = await queued(f);
  await pool.query(
    `UPDATE media_jobs SET lease_token=$2,lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [q.job.id, randomUUID()],
  );
  await recoverExpiredMediaJobs(pool);
  assert.equal((await read(f, q.job.id)).billing.actualUsd6, '0');
  const image = await queued(f);
  await pool.query(
    `UPDATE media_jobs SET state='dispatching',dispatched_at=now(),lease_token=$2,lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [image.job.id, randomUUID()],
  );
  await recoverExpiredMediaJobs(pool);
  assert.equal((await read(f, image.job.id)).state, 'reconciliation_pending');
  let posts = 0;
  await runNextMediaJob(
    pool,
    provider({
      generateImage: async () => {
        posts++;
      },
      recoverImage: async (key) => imageResult(key),
    }),
    keyring,
    { env, storageReady: false },
  );
  assert.equal(posts, 0);
  assert.equal((await read(f, image.job.id)).state, 'completed');
});
void test('concurrent workers lease a queued submission once and lost leases cannot settle late results', async () => {
  const f = await fixture(),
    q = await queued(f);
  let posts = 0;
  let continueRequest;
  const pending = new Promise((resolve) => {
    continueRequest = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const p = provider({
    generateImage: async (input) => {
      posts++;
      entered();
      await pending;
      return imageResult(input.clientRequestId);
    },
  });
  const running = runNextMediaJob(pool, p, keyring, runtime);
  await started;
  assert.equal(await runNextMediaJob(pool, p, keyring, runtime), false);
  await pool.query(
    `UPDATE media_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [q.job.id],
  );
  await recoverExpiredMediaJobs(pool);
  continueRequest();
  await running;
  assert.equal(posts, 1);
  assert.equal((await read(f, q.job.id)).billing.actualUsd6, null);
  await quiesce();
});
void test('provider operation reuse and changed models cannot create a second capture', async () => {
  const ref = `video_${randomUUID()}`;
  const first = await fixture('video'),
    a = await queued(first);
  await runNextMediaJob(
    pool,
    provider({ submitVideo: async () => videoResult(ref, 'completed', 10000) }),
    keyring,
    runtime,
  );
  assert.equal((await read(first, a.job.id)).state, 'completed');
  const second = await fixture('video'),
    b = await queued(second);
  await runNextMediaJob(
    pool,
    provider({ submitVideo: async () => videoResult(ref, 'completed', 10000) }),
    keyring,
    runtime,
  );
  assert.equal((await read(second, b.job.id)).state, 'reconciliation_pending');
  assert.equal((await read(second, b.job.id)).billing.actualUsd6, null);
  const third = await fixture(),
    c = await queued(third);
  await runNextMediaJob(
    pool,
    provider({
      generateImage: async (input) => ({
        ...imageResult(input.clientRequestId),
        modelId: 'another-model',
      }),
    }),
    keyring,
    runtime,
  );
  assert.equal((await read(third, c.job.id)).billing.actualUsd6, null);
  await quiesce();
});
void test('database freezes accepted inputs quotes provider references and first result bytes', async () => {
  const f = await fixture(),
    q = await queued(f);
  await runNextMediaJob(
    pool,
    provider({
      generateImage: async (input) => imageResult(input.clientRequestId),
    }),
    keyring,
    runtime,
  );
  for (const sql of [
    `UPDATE media_jobs SET input_ciphertext='replacement-value-longer-than-minimum' WHERE id=$1`,
    `UPDATE media_jobs SET result_ciphertext='replacement' WHERE id=$1`,
    `UPDATE media_jobs SET provider_reference_ciphertext='replacement' WHERE id=$1`,
    `UPDATE media_jobs SET state='queued' WHERE id=$1`,
    `DELETE FROM media_jobs WHERE id=$1`,
  ])
    await assert.rejects(pool.query(sql, [q.job.id]));
  await assert.rejects(
    pool.query('UPDATE quotes SET max_usd6=max_usd6+1 WHERE id=$1', [
      q.quote.id,
    ]),
  );
  await assert.rejects(
    pool.query(
      "UPDATE media_quote_inputs SET input_ciphertext='replacement-value-longer-than-minimum' WHERE quote_id=$1",
      [q.quote.id],
    ),
  );
});
void test('routes do not expose an older enabled review after the latest version is disabled', async () => {
  const f = await fixture();
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) SELECT $2,route_id,2,model_id,family,modality,false,card,pricing,expires_at FROM route_versions WHERE id=$1`,
    [f.routeVersionId, randomUUID()],
  );
  assert.equal(
    (await listMediaRoutes(pool, f.accountId)).routes.some(
      (r) => r.versionId === f.routeVersionId,
    ),
    false,
  );
});
void test('HTTP contract rejects caller-supplied evidence and references while capability stays storage blocked', async () => {
  const f = await fixture();
  const request = (path, body) =>
    new Request(
      `https://app.example.invalid/api/${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
  const response = await mediaRoutes(
    pool,
    request('media/capabilities'),
    'media/capabilities',
    f.accountId,
    keyring,
    { env },
  );
  assert.equal((await response.json()).reason, 'MEDIA_STORAGE_REQUIRED');
  for (const body of [
    {
      projectId: f.projectId,
      routeVersionId: f.routeVersionId,
      input: { ...f.input, imageUrl: 'https://example.invalid/reference' },
    },
    {
      projectId: f.projectId,
      routeVersionId: f.routeVersionId,
      input: f.input,
      providerCostUsd6: '0',
    },
  ]) {
    const response = await handleApi(() =>
      mediaRoutes(
        pool,
        request('media/quotes', body),
        'media/quotes',
        f.accountId,
        keyring,
        runtime,
      ),
    );
    assert.equal(response.status, 400);
  }
});

void test('alternate UUID casing resolves the same quote job replay and owned history', async () => {
  const f = await fixture();
  const q = await createMediaQuote(
    pool,
    f.accountId,
    f.projectId.toUpperCase(),
    f.routeVersionId.toUpperCase(),
    f.input,
    keyring,
    runtime,
  );
  const requestKey = randomUUID();
  const created = await createMediaJob(
    pool,
    f.accountId,
    q.id.toUpperCase(),
    requestKey,
    q.maximumUsd6,
    keyring,
    runtime,
  );
  const replay = await createMediaJob(
    pool,
    f.accountId,
    q.id.toUpperCase(),
    requestKey,
    q.maximumUsd6,
    keyring,
    {},
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, created.job.id);
  assert.equal(
    (
      await getOwnedMedia(
        pool,
        f.accountId,
        created.job.id.toUpperCase(),
        keyring,
      )
    ).id,
    created.job.id,
  );
  assert.equal(
    (
      await listOwnedMedia(
        pool,
        f.accountId,
        f.projectId.toUpperCase(),
        null,
        keyring,
      )
    ).jobs[0].id,
    created.job.id,
  );
  await cancelOwnedMedia(
    pool,
    f.accountId,
    created.job.id.toUpperCase(),
    keyring,
  );
});

void test('pending provider cost can settle later without replacing the first encrypted result', async () => {
  const f = await fixture(),
    q = await queued(f);
  await runNextMediaJob(
    pool,
    provider({
      generateImage: async (input) => imageResult(input.clientRequestId, null),
    }),
    keyring,
    runtime,
  );
  const before = (
    await pool.query(
      'SELECT result_ciphertext,provider_reference_ciphertext FROM media_jobs WHERE id=$1',
      [q.job.id],
    )
  ).rows[0];
  await due(q.job.id);
  await runNextMediaJob(
    pool,
    provider({ recoverImage: async (key) => imageResult(key, 50000) }),
    keyring,
    { env, storageReady: false },
  );
  const after = (
    await pool.query(
      'SELECT result_ciphertext,provider_reference_ciphertext FROM media_jobs WHERE id=$1',
      [q.job.id],
    )
  ).rows[0];
  assert.deepEqual(after, before);
  assert.equal((await read(f, q.job.id)).state, 'completed');
  assert.equal((await read(f, q.job.id)).billing.actualUsd6, '55000');
});

void test('disabled accounts cannot start jobs but existing provider obligations still settle', async () => {
  const f = await fixture('video'),
    q = await queued(f),
    ref = `video_${randomUUID()}`;
  await runNextMediaJob(
    pool,
    provider({ submitVideo: async () => videoResult(ref) }),
    keyring,
    runtime,
  );
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    f.accountId,
  ]);
  await assert.rejects(
    getOwnedMedia(pool, f.accountId, q.job.id, keyring),
    (e) => e.code === 'SESSION_REQUIRED',
  );
  await assert.rejects(
    createMediaQuote(
      pool,
      f.accountId,
      f.projectId,
      f.routeVersionId,
      f.input,
      keyring,
      runtime,
    ),
    (e) => e.code === 'SESSION_REQUIRED',
  );
  await due(q.job.id);
  await runNextMediaJob(
    pool,
    provider({ videoStatus: async () => videoResult(ref, 'completed', 10000) }),
    keyring,
    { env, storageReady: false },
  );
  const row = (
    await pool.query(
      'SELECT m.state,h.captured_usd6::text FROM media_jobs m JOIN holds h ON h.id=m.hold_id WHERE m.id=$1',
      [q.job.id],
    )
  ).rows[0];
  assert.equal(row.state, 'completed');
  assert.equal(row.captured_usd6, '11000');
});

void test('an expired accepted quote replays its existing job but cannot reserve a fresh job', async () => {
  const f = await fixture(),
    quoteId = randomUUID(),
    key = randomUUID();
  const hash = await mediaRequestHash(f.projectId, f.routeVersionId, f.input);
  const encrypted = await encryptText(
    JSON.stringify(f.input),
    `${f.accountId}:media-quote:${quoteId}`,
    keyring,
  );
  const expiration = (
    await pool.query(
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at) VALUES($1,$2,$3,$4,$5,110000,1,now()+interval '1 second') RETURNING expires_at`,
      [quoteId, f.accountId, f.projectId, f.routeVersionId, hash],
    )
  ).rows[0].expires_at;
  await pool.query(
    'INSERT INTO media_quote_inputs(quote_id,input_ciphertext) VALUES($1,$2)',
    [quoteId, encrypted],
  );
  const created = await createMediaJob(
    pool,
    f.accountId,
    quoteId,
    key,
    '110000',
    keyring,
    runtime,
  );
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, expiration.getTime() - Date.now() + 60)),
  );
  const replay = await createMediaJob(
    pool,
    f.accountId,
    quoteId,
    key,
    '110000',
    keyring,
    {},
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, created.job.id);
  await assert.rejects(
    createMediaJob(
      pool,
      f.accountId,
      quoteId,
      randomUUID(),
      '110000',
      keyring,
      runtime,
    ),
    (e) => e.code === 'QUOTE_EXPIRED',
  );
  await cancelOwnedMedia(pool, f.accountId, created.job.id, keyring);
});

void test('HTTP quote envelope permits bounded JSON expansion without relaxing the UTF-8 description limit', async () => {
  const f = await fixture();
  const valid = {
    projectId: f.projectId,
    routeVersionId: f.routeVersionId,
    input: { ...f.input, prompt: 'A\n'.repeat(7900) },
  };
  assert.ok(JSON.stringify(valid).length > 20000);
  const request = (body) =>
    new Request('https://app.example.invalid/api/media/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const accepted = await handleApi(() =>
    mediaRoutes(
      pool,
      request(valid),
      'media/quotes',
      f.accountId,
      keyring,
      runtime,
    ),
  );
  assert.equal(accepted.status, 201);
  const tooLarge = {
    ...valid,
    input: { ...valid.input, prompt: 'A\n'.repeat(8001) },
  };
  const rejected = await handleApi(() =>
    mediaRoutes(
      pool,
      request(tooLarge),
      'media/quotes',
      f.accountId,
      keyring,
      runtime,
    ),
  );
  assert.equal(rejected.status, 413);
  const controls = {
    ...valid,
    input: { ...valid.input, prompt: String.fromCharCode(0).repeat(16000) },
  };
  assert.ok(JSON.stringify(controls).length < 100000);
  const invalidText = await handleApi(() =>
    mediaRoutes(
      pool,
      request(controls),
      'media/quotes',
      f.accountId,
      keyring,
      runtime,
    ),
  );
  assert.equal(invalidText.status, 400);
  assert.equal((await invalidText.json()).error.code, 'INVALID_MEDIA_TEXT');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::text FROM quotes WHERE account_id=$1',
        [f.accountId],
      )
    ).rows[0].count,
    '1',
  );
});

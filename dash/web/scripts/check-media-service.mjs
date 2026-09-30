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

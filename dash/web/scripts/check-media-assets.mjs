import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  encryptMedia,
  MEDIA_CHUNK_BYTES,
} from '../server/media/asset-crypto.ts';
import {
  DEFAULT_MEDIA_STORAGE_POLICY,
  mediaStoragePolicy,
  mediaStorageReservationBytes,
  reserveMediaStorageInTransaction,
  releaseUnusedMediaStorageInTransaction,
  releaseFailedMediaIngestStorageInTransaction,
  getMediaAssetForJob,
  finalizeMediaAsset,
  finalizeMediaAssetInTransaction,
  readOwnedMediaAsset,
  deleteOwnedMediaAsset,
} from '../server/media/assets.ts';

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
const policy = {
  accountBytes: 1024 * MEDIA_CHUNK_BYTES,
  globalBytes: 16 * 1024 * MEDIA_CHUNK_BYTES,
};
const code = (expected) => (error) => error.code === expected;
async function fixture(modality = 'image', accountId = randomUUID()) {
  const projectId = randomUUID(),
    routeId = randomUUID();
  await pool.query(
    'INSERT INTO accounts(id) VALUES($1) ON CONFLICT DO NOTHING',
    [accountId],
  );
  await pool.query(
    'INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)',
    [projectId, accountId, 'Storage test'],
  );
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) VALUES($1,$2,1,$3,$4,$5,true,'{}','{}',now()+interval '1 hour')`,
    [routeId, `storage-${routeId}`, 'sample-media-model', 'sample', modality],
  );
  return { accountId, projectId, routeId, modality };
}
async function insertJob(db, f) {
  const quoteId = randomUUID(),
    holdId = randomUUID(),
    jobId = randomUUID(),
    hash = 'b'.repeat(64),
    cipher = 'x'.repeat(40);
  await db.query(
    `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at) VALUES($1,$2,$3,$4,$5,100,1,now()+interval '1 hour')`,
    [quoteId, f.accountId, f.projectId, f.routeId, hash],
  );
  await db.query(
    'INSERT INTO media_quote_inputs(quote_id,input_ciphertext) VALUES($1,$2)',
    [quoteId, cipher],
  );
  await db.query(
    `INSERT INTO holds(id,account_id,quote_id,idempotency_key,request_hash,maximum_usd6,state) VALUES($1,$2,$3,$4,$5,100,'held')`,
    [holdId, f.accountId, quoteId, randomUUID(), hash],
  );
  await db.query(
    `INSERT INTO media_jobs(id,account_id,project_id,route_version_id,hold_id,input_ciphertext,request_hash,modality) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      jobId,
      f.accountId,
      f.projectId,
      f.routeId,
      holdId,
      cipher,
      hash,
      f.modality,
    ],
  );
  return { jobId, holdId, quoteId };
}
async function job(f) {
  return transaction(pool, (db) => insertJob(db, f));
}
async function reserve(f, j, limits = policy) {
  return transaction(pool, (db) =>
    reserveMediaStorageInTransaction(
      db,
      { accountId: f.accountId, jobId: j.jobId },
      limits,
    ),
  );
}
async function release(f, j) {
  return transaction(pool, (db) =>
    releaseUnusedMediaStorageInTransaction(db, {
      accountId: f.accountId,
      jobId: j.jobId,
    }),
  );
}
async function complete(j) {
  await pool.query(
    "UPDATE media_jobs SET state='dispatching',dispatched_at=now() WHERE id=$1",
    [j.jobId],
  );
  await pool.query(
    "UPDATE media_jobs SET state='completed',result_ciphertext=$2 WHERE id=$1",
    [j.jobId, 'r'.repeat(40)],
  );
  await pool.query(
    "UPDATE holds SET state='captured',captured_usd6=50 WHERE id=$1",
    [j.holdId],
  );
}
async function failed(j) {
  await pool.query("UPDATE media_jobs SET state='failed' WHERE id=$1", [
    j.jobId,
  ]);
}
async function saved(f, bytes = Buffer.from('sample sanitized bytes')) {
  const j = await job(f),
    asset = await reserve(f, j);
  await complete(j);
  const identity = {
    accountId: f.accountId,
    projectId: f.projectId,
    assetId: asset.id,
  };
  const encrypted = await encryptMedia(
    bytes,
    f.modality === 'video' ? 'video/mp4' : 'image/png',
    identity,
    keyring,
  );
  return { j, asset, identity, encrypted, bytes };
}

void test('storage limits validate trusted integer configuration and conservative envelope overhead', () => {
  assert.equal(
    mediaStorageReservationBytes('image'),
    20 * MEDIA_CHUNK_BYTES + 20 * 28 + 2048,
  );
  assert.equal(
    mediaStorageReservationBytes('video'),
    100 * MEDIA_CHUNK_BYTES + 100 * 28 + 2048,
  );
  assert.deepEqual(mediaStoragePolicy(), DEFAULT_MEDIA_STORAGE_POLICY);
  assert.ok(
    DEFAULT_MEDIA_STORAGE_POLICY.accountBytes >=
      3 * mediaStorageReservationBytes('video'),
  );
  assert.equal(DEFAULT_MEDIA_STORAGE_POLICY.globalBytes, 512 * 1024 * 1024);
  for (const invalid of [
    null,
    {},
    [],
    { accountBytes: '100', globalBytes: 100 },
    { accountBytes: 0, globalBytes: 100 },
    { accountBytes: 200, globalBytes: 100 },
    { accountBytes: 1, globalBytes: 2 ** 50 },
    { accountBytes: 1, globalBytes: 100, enabled: true },
  ])
    assert.throws(
      () => mediaStoragePolicy(invalid),
      code('MEDIA_STORAGE_CONFIGURATION_REQUIRED'),
    );
});

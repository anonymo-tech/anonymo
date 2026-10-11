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
void test('one immutable owned asset identity is reserved before generation and replays without capacity allocation', async () => {
  const f = await fixture(),
    j = await job(f),
    a = await reserve(f, j);
  const again = await reserve(
    { ...f, accountId: f.accountId.toUpperCase() },
    { ...j, jobId: j.jobId.toUpperCase() },
    { accountBytes: 1, globalBytes: 1 },
  );
  assert.equal(a.id, again.id);
  assert.equal(a.state, 'reserved');
  assert.equal(a.projectId, f.projectId);
  assert.equal(a.allocatedBytes, mediaStorageReservationBytes('image'));
  await transaction(pool, async (db) => {
    assert.equal(
      (await getMediaAssetForJob(db, f.accountId, j.jobId)).id,
      a.id,
    );
    assert.equal(await getMediaAssetForJob(db, randomUUID(), j.jobId), null);
  });
  await failed(j);
  await release(f, j);
});
void test('quota failure rolls back an entire enqueue transaction and does not leave a hold or job', async () => {
  const f = await fixture();
  let ids;
  await assert.rejects(
    transaction(pool, async (db) => {
      ids = await insertJob(db, f);
      await reserveMediaStorageInTransaction(
        db,
        { accountId: f.accountId, jobId: ids.jobId },
        { accountBytes: 1, globalBytes: 1 },
      );
    }),
    code('MEDIA_ACCOUNT_STORAGE_LIMIT'),
  );
  for (const [table, id] of [
    ['media_jobs', ids.jobId],
    ['holds', ids.holdId],
    ['quotes', ids.quoteId],
  ])
    assert.equal(
      (await pool.query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rowCount,
      0,
    );
});
void test('simultaneous reservations cannot exceed account quota', async () => {
  const f = await fixture(),
    jobs = await Promise.all([job(f), job(f)]),
    limit = mediaStorageReservationBytes('image');
  const results = await Promise.allSettled(
    jobs.map((j) =>
      reserve(f, j, { accountBytes: limit, globalBytes: policy.globalBytes }),
    ),
  );
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((x) => x.status === 'rejected').reason.code,
    'MEDIA_ACCOUNT_STORAGE_LIMIT',
  );
  for (const j of jobs) {
    await failed(j);
    await release(f, j);
  }
});
void test('global quota serializes different accounts and releases unused reservations', async () => {
  const owned = await pool.query(
    'SELECT COALESCE(sum(allocated_bytes),0)::text AS total FROM media_assets',
  );
  const baseline = Number(owned.rows[0].total),
    limit = mediaStorageReservationBytes('image');
  const first = await fixture(),
    second = await fixture(),
    jobs = [await job(first), await job(second)];
  const results = await Promise.allSettled([
    reserve(first, jobs[0], {
      accountBytes: limit,
      globalBytes: baseline + limit,
    }),
    reserve(second, jobs[1], {
      accountBytes: limit,
      globalBytes: baseline + limit,
    }),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((x) => x.status === 'rejected').reason.code,
    'MEDIA_STORAGE_CAPACITY',
  );
  for (const [index, f] of [first, second].entries()) {
    await failed(jobs[index]);
    await release(f, jobs[index]);
  }
  assert.equal(
    (
      await pool.query(
        'SELECT COALESCE(sum(allocated_bytes),0)::text AS total FROM media_assets',
      )
    ).rows[0].total,
    String(baseline),
  );
});
void test('ordered encrypted chunks finalize atomically and decrypt only for the owner', async () => {
  const f = await fixture(),
    input = randomBytes(MEDIA_CHUNK_BYTES + 37),
    s = await saved(f, input);
  const ready = await finalizeMediaAsset(
    pool,
    f.accountId,
    s.j.jobId,
    s.encrypted,
    keyring,
  );
  assert.equal(ready.state, 'ready');
  assert.equal(ready.byteLength, input.byteLength);
  assert.ok(ready.allocatedBytes < s.asset.allocatedBytes);
  const result = await readOwnedMediaAsset(
    pool,
    f.accountId.toUpperCase(),
    ready.id.toUpperCase(),
    keyring,
  );
  assert.deepEqual(Buffer.from(result.bytes), input);
  const cipher = (
    await pool.query(
      'SELECT ciphertext FROM media_asset_chunks WHERE asset_id=$1 ORDER BY ordinal',
      [ready.id],
    )
  ).rows;
  assert.equal(cipher.length, 2);
  assert.notDeepEqual(
    cipher[0].ciphertext,
    input.subarray(0, MEDIA_CHUNK_BYTES),
  );
  const other = await fixture();
  await assert.rejects(
    readOwnedMediaAsset(pool, other.accountId, ready.id, keyring),
    code('MEDIA_ASSET_NOT_FOUND'),
  );
  await assert.rejects(
    deleteOwnedMediaAsset(pool, other.accountId, ready.id),
    code('MEDIA_ASSET_NOT_FOUND'),
  );
  await deleteOwnedMediaAsset(pool, f.accountId, ready.id);
});
void test('concurrent repeated finalization preserves the first ciphertext and rejects replacement content', async () => {
  const f = await fixture(),
    s = await saved(f);
  const second = await encryptMedia(s.bytes, 'image/png', s.identity, keyring);
  const results = await Promise.all([
    finalizeMediaAsset(pool, f.accountId, s.j.jobId, s.encrypted, keyring),
    finalizeMediaAsset(pool, f.accountId, s.j.jobId, second, keyring),
  ]);
  assert.equal(results[0].id, results[1].id);
  const manifest = (
    await pool.query(
      'SELECT manifest_ciphertext FROM media_assets WHERE id=$1',
      [s.asset.id],
    )
  ).rows[0].manifest_ciphertext;
  assert.ok([s.encrypted.manifest, second.manifest].includes(manifest));
  const altered = await encryptMedia(
    Buffer.from('different sample'),
    'image/png',
    s.identity,
    keyring,
  );
  await assert.rejects(
    finalizeMediaAsset(pool, f.accountId, s.j.jobId, altered, keyring),
    code('MEDIA_ASSET_CONFLICT'),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT manifest_ciphertext FROM media_assets WHERE id=$1',
        [s.asset.id],
      )
    ).rows[0].manifest_ciphertext,
    manifest,
  );
  await deleteOwnedMediaAsset(pool, f.accountId, s.asset.id);
});
void test('corrupt, reordered and identity-substituted imports remain reserved and cannot affect billing', async () => {
  const f = await fixture(),
    s = await saved(f, randomBytes(MEDIA_CHUNK_BYTES + 5));
  const before = (
    await pool.query('SELECT * FROM holds WHERE id=$1', [s.j.holdId])
  ).rows[0];
  const wrong = await encryptMedia(
    s.bytes,
    'image/png',
    { ...s.identity, projectId: randomUUID() },
    keyring,
  );
  const corrupt = {
    manifest: s.encrypted.manifest,
    chunks: s.encrypted.chunks.map((c) => new Uint8Array(c)),
  };
  corrupt.chunks[0][15] ^= 1;
  for (const bad of [
    wrong,
    corrupt,
    { ...s.encrypted, chunks: [...s.encrypted.chunks].reverse() },
    { ...s.encrypted, chunks: [] },
  ])
    await assert.rejects(
      finalizeMediaAsset(pool, f.accountId, s.j.jobId, bad, keyring),
      code('MEDIA_CONTENT_UNAVAILABLE'),
    );
  assert.equal(
    (
      await pool.query('SELECT state FROM media_assets WHERE id=$1', [
        s.asset.id,
      ])
    ).rows[0].state,
    'reserved',
  );
  assert.equal(
    (
      await pool.query('SELECT * FROM media_asset_chunks WHERE asset_id=$1', [
        s.asset.id,
      ])
    ).rowCount,
    0,
  );
  assert.deepEqual(
    (await pool.query('SELECT * FROM holds WHERE id=$1', [s.j.holdId])).rows[0],
    before,
  );
  await assert.rejects(release(f, s.j), code('MEDIA_STORAGE_STILL_REQUIRED'));
  await finalizeMediaAsset(pool, f.accountId, s.j.jobId, s.encrypted, keyring);
  await deleteOwnedMediaAsset(pool, f.accountId, s.asset.id);
});
void test('an importer lease failure rolls back finalization and every inserted chunk', async () => {
  const f = await fixture(),
    s = await saved(f);
  await assert.rejects(
    transaction(pool, async (db) => {
      await finalizeMediaAssetInTransaction(
        db,
        f.accountId,
        s.j.jobId,
        s.encrypted,
        keyring,
      );
      throw new Error('Synthetic expired import lease');
    }),
    /Synthetic expired import lease/,
  );
  assert.equal(
    (
      await pool.query('SELECT state FROM media_assets WHERE id=$1', [
        s.asset.id,
      ])
    ).rows[0].state,
    'reserved',
  );
  assert.equal(
    (
      await pool.query('SELECT * FROM media_asset_chunks WHERE asset_id=$1', [
        s.asset.id,
      ])
    ).rowCount,
    0,
  );
  await finalizeMediaAsset(pool, f.accountId, s.j.jobId, s.encrypted, keyring);
  await deleteOwnedMediaAsset(pool, f.accountId, s.asset.id);
});
void test('storage requires completed matching modality and cannot be reserved after dispatch', async () => {
  const f = await fixture(),
    j = await job(f),
    a = await reserve(f, j);
  const encrypted = await encryptMedia(
    Buffer.from('sample'),
    'image/png',
    { accountId: f.accountId, projectId: f.projectId, assetId: a.id },
    keyring,
  );
  await assert.rejects(
    finalizeMediaAsset(pool, f.accountId, j.jobId, encrypted, keyring),
    code('MEDIA_GENERATION_INCOMPLETE'),
  );
  await assert.rejects(release(f, j), code('MEDIA_STORAGE_STILL_REQUIRED'));
  await assert.rejects(
    deleteOwnedMediaAsset(pool, f.accountId, a.id),
    code('MEDIA_ASSET_NOT_READY'),
  );
  const second = await job(f);
  await pool.query(
    "UPDATE media_jobs SET state='dispatching',dispatched_at=now() WHERE id=$1",
    [second.jobId],
  );
  await assert.rejects(
    reserve(f, second),
    code('MEDIA_STORAGE_RESERVATION_REQUIRED'),
  );
  await complete(j);
  const video = await encryptMedia(
    Buffer.from('sample video'),
    'video/mp4',
    { accountId: f.accountId, projectId: f.projectId, assetId: a.id },
    keyring,
  );
  await assert.rejects(
    finalizeMediaAsset(pool, f.accountId, j.jobId, video, keyring),
    code('MEDIA_ASSET_MISMATCH'),
  );
  await finalizeMediaAsset(pool, f.accountId, j.jobId, encrypted, keyring);
  await deleteOwnedMediaAsset(pool, f.accountId, a.id);
});
void test('generation failure releases capacity idempotently without refunding or recreating an identity', async () => {
  const f = await fixture('video'),
    j = await job(f),
    a = await reserve(f, j);
  await failed(j);
  const before = (
    await pool.query('SELECT * FROM holds WHERE id=$1', [j.holdId])
  ).rows[0];
  const released = await release(f, j);
  assert.equal(released.state, 'released');
  assert.equal(released.allocatedBytes, 0);
  assert.deepEqual(await release(f, j), released);
  assert.equal((await reserve(f, j)).state, 'released');
  assert.deepEqual(
    (await pool.query('SELECT * FROM holds WHERE id=$1', [j.holdId])).rows[0],
    before,
  );
  await assert.rejects(
    pool.query('DELETE FROM media_assets WHERE id=$1', [a.id]),
    code('23514'),
  );
});
void test('deletion purges ciphertext and returns capacity while retaining a nonreusable tombstone', async () => {
  const f = await fixture(),
    s = await saved(f);
  await finalizeMediaAsset(pool, f.accountId, s.j.jobId, s.encrypted, keyring);
  const before = (
    await pool.query('SELECT * FROM holds WHERE id=$1', [s.j.holdId])
  ).rows[0];
  const deleted = await deleteOwnedMediaAsset(pool, f.accountId, s.asset.id);
  assert.equal(deleted.state, 'deleted');
  assert.equal(deleted.allocatedBytes, 0);
  assert.deepEqual(
    await deleteOwnedMediaAsset(pool, f.accountId, s.asset.id),
    deleted,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT manifest_ciphertext FROM media_assets WHERE id=$1',
        [s.asset.id],
      )
    ).rows[0].manifest_ciphertext,
    null,
  );
  assert.equal(
    (
      await pool.query('SELECT * FROM media_asset_chunks WHERE asset_id=$1', [
        s.asset.id,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    readOwnedMediaAsset(pool, f.accountId, s.asset.id, keyring),
    code('MEDIA_ASSET_NOT_FOUND'),
  );
  await assert.rejects(
    finalizeMediaAsset(pool, f.accountId, s.j.jobId, s.encrypted, keyring),
    code('MEDIA_ASSET_REMOVED'),
  );
  assert.deepEqual(
    (await pool.query('SELECT * FROM holds WHERE id=$1', [s.j.holdId])).rows[0],
    before,
  );
});
void test('disabled accounts cannot read but their already incurred storage obligation can finish', async () => {
  const f = await fixture(),
    s = await saved(f);
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    f.accountId,
  ]);
  assert.equal(
    (
      await finalizeMediaAsset(
        pool,
        f.accountId,
        s.j.jobId,
        s.encrypted,
        keyring,
      )
    ).state,
    'ready',
  );
  await assert.rejects(
    readOwnedMediaAsset(pool, f.accountId, s.asset.id, keyring),
    code('SESSION_REQUIRED'),
  );
  await assert.rejects(
    deleteOwnedMediaAsset(pool, f.accountId, s.asset.id),
    code('SESSION_REQUIRED'),
  );
});
void test('database constraints reject partial chunks, mutable identity and finalized cipher replacement', async () => {
  const f = await fixture(),
    s = await saved(f);
  await assert.rejects(
    pool.query(
      'INSERT INTO media_asset_chunks(asset_id,ordinal,ciphertext) VALUES($1,0,$2)',
      [s.asset.id, Buffer.from(s.encrypted.chunks[0])],
    ),
    code('23514'),
  );
  await assert.rejects(
    pool.query('UPDATE media_assets SET project_id=$2 WHERE id=$1', [
      s.asset.id,
      randomUUID(),
    ]),
    code('23514'),
  );
  await finalizeMediaAsset(pool, f.accountId, s.j.jobId, s.encrypted, keyring);
  await assert.rejects(
    pool.query('UPDATE media_assets SET manifest_ciphertext=$2 WHERE id=$1', [
      s.asset.id,
      s.encrypted.manifest,
    ]),
    code('23514'),
  );
  await assert.rejects(
    pool.query(
      'UPDATE media_asset_chunks SET ciphertext=$2 WHERE asset_id=$1',
      [s.asset.id, Buffer.from(s.encrypted.chunks[0])],
    ),
    code('23514'),
  );
  await assert.rejects(
    pool.query('DELETE FROM media_asset_chunks WHERE asset_id=$1', [
      s.asset.id,
    ]),
    code('23514'),
  );
  await deleteOwnedMediaAsset(pool, f.accountId, s.asset.id);
});

void test('retryable or live imports retain capacity; terminal import failure releases no money', async () => {
  const f = await fixture(),
    s = await saved(f);
  await pool.query('INSERT INTO media_ingests(job_id) VALUES($1)', [s.j.jobId]);
  const releaseImport = () =>
    transaction(pool, (db) =>
      releaseFailedMediaIngestStorageInTransaction(db, {
        accountId: f.accountId,
        jobId: s.j.jobId,
      }),
    );
  for (const state of ['queued', 'retry']) {
    if (state === 'retry')
      await pool.query(
        "UPDATE media_ingests SET state='retry' WHERE job_id=$1",
        [s.j.jobId],
      );
    await assert.rejects(releaseImport(), code('MEDIA_STORAGE_STILL_REQUIRED'));
    await assert.rejects(
      pool.query(
        "UPDATE media_assets SET state='released',allocated_bytes=0,removed_at=now() WHERE id=$1",
        [s.asset.id],
      ),
      code('23514'),
    );
  }
  await pool.query(
    "UPDATE media_ingests SET state='processing',attempts=1,lease_token=$2,lease_expires_at=now()+interval '1 minute' WHERE job_id=$1",
    [s.j.jobId, randomUUID()],
  );
  await assert.rejects(releaseImport(), code('MEDIA_STORAGE_STILL_REQUIRED'));
  const before = (
    await pool.query('SELECT * FROM holds WHERE id=$1', [s.j.holdId])
  ).rows[0];
  assert.equal(before.state, 'captured');
  assert.equal(before.captured_usd6, '50');
  const released = await transaction(pool, async (db) => {
    await db.query(
      "UPDATE media_ingests SET state='failed',lease_token=NULL,lease_expires_at=NULL,error_code='MEDIA_SANITIZATION_FAILED' WHERE job_id=$1",
      [s.j.jobId],
    );
    return releaseFailedMediaIngestStorageInTransaction(db, {
      accountId: f.accountId,
      jobId: s.j.jobId,
    });
  });
  assert.equal(released.state, 'released');
  assert.equal(released.allocatedBytes, 0);
  assert.deepEqual(await releaseImport(), released);
  assert.deepEqual(
    (await pool.query('SELECT * FROM holds WHERE id=$1', [s.j.holdId])).rows[0],
    before,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT state,result_ciphertext FROM media_jobs WHERE id=$1',
        [s.j.jobId],
      )
    ).rows[0].state,
    'completed',
  );
  await assert.rejects(
    finalizeMediaAsset(pool, f.accountId, s.j.jobId, s.encrypted, keyring),
    code('MEDIA_ASSET_REMOVED'),
  );
});
void test('failed-import cleanup shares its parent transaction and cannot release completed or foreign assets', async () => {
  const f = await fixture(),
    s = await saved(f);
  await pool.query('INSERT INTO media_ingests(job_id) VALUES($1)', [s.j.jobId]);
  await assert.rejects(
    transaction(pool, async (db) => {
      await db.query(
        "UPDATE media_ingests SET state='failed',error_code='MEDIA_SANITIZATION_FAILED' WHERE job_id=$1",
        [s.j.jobId],
      );
      await releaseFailedMediaIngestStorageInTransaction(db, {
        accountId: f.accountId,
        jobId: s.j.jobId,
      });
      throw new Error('Synthetic rollback');
    }),
    /Synthetic rollback/,
  );
  assert.equal(
    (
      await pool.query('SELECT state FROM media_assets WHERE id=$1', [
        s.asset.id,
      ])
    ).rows[0].state,
    'reserved',
  );
  assert.equal(
    (
      await pool.query('SELECT state FROM media_ingests WHERE job_id=$1', [
        s.j.jobId,
      ])
    ).rows[0].state,
    'queued',
  );
  const other = await fixture();
  assert.equal(
    await transaction(pool, (db) =>
      releaseFailedMediaIngestStorageInTransaction(db, {
        accountId: other.accountId,
        jobId: s.j.jobId,
      }),
    ),
    null,
  );
  await pool.query(
    "UPDATE media_ingests SET state='completed' WHERE job_id=$1",
    [s.j.jobId],
  );
  await assert.rejects(
    transaction(pool, (db) =>
      releaseFailedMediaIngestStorageInTransaction(db, {
        accountId: f.accountId,
        jobId: s.j.jobId,
      }),
    ),
    code('MEDIA_STORAGE_STILL_REQUIRED'),
  );
  await finalizeMediaAsset(pool, f.accountId, s.j.jobId, s.encrypted, keyring);
  await deleteOwnedMediaAsset(pool, f.accountId, s.asset.id);
});

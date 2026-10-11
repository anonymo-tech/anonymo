import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  encryptMedia,
  MEDIA_CHUNK_BYTES,
} from '../server/media/asset-crypto.ts';
import {
  reserveMediaStorageInTransaction,
  finalizeMediaAsset,
  deleteOwnedMediaAsset,
} from '../server/media/assets.ts';
import { openOwnedMediaReader } from '../server/media/reader.ts';

const endpoint = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL);
const pool = createDatabase(endpoint.href, 8);
before(() => migrate(pool));
after(() => pool.end());
const keys = {
  active: 'test',
  keys: { test: randomBytes(32).toString('base64') },
};
const policy = {
  accountBytes: 512 * MEDIA_CHUNK_BYTES,
  globalBytes: 16 * 1024 * MEDIA_CHUNK_BYTES,
};
const failure = (error) =>
  error.code === 'MEDIA_CONTENT_UNAVAILABLE' &&
  error.message === 'This saved media could not be verified.';
const code = (expected) => (error) => error.code === expected;

async function fixture(bytes = randomBytes(2 * MEDIA_CHUNK_BYTES + 17)) {
  const accountId = randomUUID(),
    projectId = randomUUID(),
    routeId = randomUUID(),
    quoteId = randomUUID(),
    holdId = randomUUID(),
    jobId = randomUUID();
  const hash = 'c'.repeat(64),
    cipher = 'x'.repeat(40);
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    'INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)',
    [projectId, accountId, 'Reader test'],
  );
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) VALUES($1,$2,1,$3,$4,'video',true,'{}','{}',now()+interval '1 hour')`,
    [routeId, `reader-${routeId}`, 'sample-media-model', 'sample'],
  );
  const asset = await transaction(pool, async (db) => {
    await db.query(
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at) VALUES($1,$2,$3,$4,$5,100,1,now()+interval '1 hour')`,
      [quoteId, accountId, projectId, routeId, hash],
    );
    await db.query(
      'INSERT INTO media_quote_inputs(quote_id,input_ciphertext) VALUES($1,$2)',
      [quoteId, cipher],
    );
    await db.query(
      `INSERT INTO holds(id,account_id,quote_id,idempotency_key,request_hash,maximum_usd6,state) VALUES($1,$2,$3,$4,$5,100,'held')`,
      [holdId, accountId, quoteId, randomUUID(), hash],
    );
    await db.query(
      `INSERT INTO media_jobs(id,account_id,project_id,route_version_id,hold_id,input_ciphertext,request_hash,modality) VALUES($1,$2,$3,$4,$5,$6,$7,'video')`,
      [jobId, accountId, projectId, routeId, holdId, cipher, hash],
    );
    return reserveMediaStorageInTransaction(db, { accountId, jobId }, policy);
  });
  await pool.query(
    "UPDATE media_jobs SET state='dispatching',dispatched_at=now() WHERE id=$1",
    [jobId],
  );
  await pool.query(
    "UPDATE media_jobs SET state='completed',result_ciphertext=$2 WHERE id=$1",
    [jobId, 'r'.repeat(40)],
  );
  await pool.query(
    "UPDATE holds SET state='captured',captured_usd6=50 WHERE id=$1",
    [holdId],
  );
  const identity = { accountId, projectId, assetId: asset.id };
  const encrypted = await encryptMedia(bytes, 'video/mp4', identity, keys);
  await finalizeMediaAsset(pool, accountId, jobId, encrypted, keys);
  return { ...identity, jobId, bytes, encrypted };
}

/** Real SQL and transactions, with optional corruption of only this caller's
 * returned buffers. Immutable database records and triggers are never altered. */
function observed(transform = (_sql, result) => result) {
  const calls = [];
  let active = 0;
  return {
    calls,
    get active() {
      return active;
    },
    pool: {
      async connect() {
        const client = await pool.connect();
        active++;
        return {
          async query(sql, values) {
            calls.push({ sql, values });
            const result = await client.query(sql, values);
            return await transform(sql, result, values);
          },
          release() {
            active--;
            client.release();
          },
        };
      },
    },
  };
}
const isRow = (sql) => sql.includes('FROM media_assets WHERE');
const isChunk = (sql) => sql.includes('FROM media_asset_chunks');
const mapRows = (result, fn) => ({ ...result, rows: result.rows.map(fn) });

void test('metadata opens without ciphertext reads and each indexed read releases its connection', async () => {
  const f = await fixture(),
    audit = observed();
  const reader = await openOwnedMediaReader(
    audit.pool,
    f.accountId.toUpperCase(),
    f.assetId.toUpperCase(),
    keys,
  );
  assert.ok(Object.isFrozen(reader));
  assert.deepEqual(Object.keys(reader).sort(), [
    'accountId',
    'byteLength',
    'chunkCount',
    'contentType',
    'id',
    'jobId',
    'projectId',
    'readChunk',
    'sha256',
  ]);
  assert.equal(reader.id, f.assetId);
  assert.equal(reader.projectId, f.projectId);
  assert.equal(reader.jobId, f.jobId);
  assert.equal(reader.byteLength, f.bytes.length);
  assert.equal(reader.chunkCount, 3);
  assert.equal(reader.contentType, 'video/mp4');
  assert.match(reader.sha256, /^[0-9a-f]{64}$/);
  assert.equal(audit.calls.filter((c) => isChunk(c.sql)).length, 0);
  assert.equal(audit.active, 0);
  for (const index of [0, 1, 2, 0]) {
    const bytes = await reader.readChunk(index);
    assert.deepEqual(
      bytes,
      new Uint8Array(
        f.bytes.subarray(
          index * MEDIA_CHUNK_BYTES,
          (index + 1) * MEDIA_CHUNK_BYTES,
        ),
      ),
    );
    assert.ok(bytes.length <= MEDIA_CHUNK_BYTES);
    assert.equal(audit.active, 0);
  }
  const chunks = audit.calls.filter((c) => isChunk(c.sql));
  assert.equal(chunks.length, 4);
  assert.deepEqual(
    chunks.map((c) => c.values[1]),
    [0, 1, 2, 0],
  );
  assert.ok(
    chunks.every((c) =>
      c.sql.endsWith('WHERE asset_id=$1 AND ordinal=$2'),
    ),
  );
  assert.equal(audit.calls.filter((c) => c.sql === 'BEGIN').length, 5);
  assert.equal(
    audit.calls.filter(
      (c) => c.sql.includes('FROM accounts') && c.sql.includes('FOR UPDATE'),
    ).length,
    5,
  );
});

void test('one-byte and exact chunk boundaries return no padding or extra reads', async () => {
  for (const length of [1, MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES + 1]) {
    const f = await fixture(randomBytes(length));
    const reader = await openOwnedMediaReader(
      pool,
      f.accountId,
      f.assetId,
      keys,
    );
    const last = reader.chunkCount - 1;
    assert.deepEqual(
      await reader.readChunk(last),
      new Uint8Array(f.bytes.subarray(last * MEDIA_CHUNK_BYTES)),
    );
  }
});

void test('invalid chunk indices fail before checking out a connection', async () => {
  const f = await fixture(),
    audit = observed();
  const reader = await openOwnedMediaReader(
    audit.pool,
    f.accountId,
    f.assetId,
    keys,
  );
  const count = audit.calls.length;
  for (const index of [-1, 0.5, 3, NaN, Infinity, '0', null])
    await assert.rejects(reader.readChunk(index), failure);
  assert.equal(audit.calls.length, count);
  assert.equal(audit.active, 0);
});

void test('cross-account unknown assets and incorrect retained keys reveal no media', async () => {
  const f = await fixture(),
    other = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [other]);
  await assert.rejects(
    openOwnedMediaReader(pool, other, f.assetId, keys),
    code('MEDIA_ASSET_NOT_FOUND'),
  );
  await assert.rejects(
    openOwnedMediaReader(pool, f.accountId, randomUUID(), keys),
    code('MEDIA_ASSET_NOT_FOUND'),
  );
  await assert.rejects(
    openOwnedMediaReader(pool, f.accountId, f.assetId, {
      active: 'test',
      keys: { test: randomBytes(32).toString('base64') },
    }),
    failure,
  );
});

void test('account disable after opening blocks all later reads', async () => {
  const f = await fixture(),
    audit = observed();
  const reader = await openOwnedMediaReader(
    audit.pool,
    f.accountId,
    f.assetId,
    keys,
  );
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    f.accountId,
  ]);
  await assert.rejects(reader.readChunk(0), code('SESSION_REQUIRED'));
  assert.equal(audit.calls.filter((c) => isChunk(c.sql)).length, 0);
  assert.equal(audit.active, 0);
});

void test('deletion after opening blocks further chunks and new readers', async () => {
  const f = await fixture(),
    reader = await openOwnedMediaReader(pool, f.accountId, f.assetId, keys);
  assert.equal((await reader.readChunk(0)).length, MEDIA_CHUNK_BYTES);
  await deleteOwnedMediaAsset(pool, f.accountId, f.assetId);
  await assert.rejects(reader.readChunk(1), code('MEDIA_ASSET_NOT_FOUND'));
  await assert.rejects(
    openOwnedMediaReader(pool, f.accountId, f.assetId, keys),
    code('MEDIA_ASSET_NOT_FOUND'),
  );
});

void test('concurrent deletion waits for an authenticated chunk then prevents the next read', async () => {
  const f = await fixture();
  let releaseRead, enteredRead;
  const entered = new Promise((resolve) => {
    enteredRead = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const audit = observed(async (sql, result) => {
    if (isChunk(sql)) {
      enteredRead();
      await gate;
    }
    return result;
  });
  const reader = await openOwnedMediaReader(
    audit.pool,
    f.accountId,
    f.assetId,
    keys,
  );
  const pendingRead = reader.readChunk(0);
  await entered;
  let deletionFinished = false;
  const deleting = deleteOwnedMediaAsset(pool, f.accountId, f.assetId).then(
    (value) => {
      deletionFinished = true;
      return value;
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(deletionFinished, false);
  } finally {
    releaseRead();
  }
  assert.deepEqual(
    await pendingRead,
    new Uint8Array(f.bytes.subarray(0, MEDIA_CHUNK_BYTES)),
  );
  await deleting;
  assert.equal(audit.active, 0);
  await assert.rejects(reader.readChunk(1), code('MEDIA_ASSET_NOT_FOUND'));
});

void test('row metadata corruption refuses both initial and later reads', async () => {
  const f = await fixture();
  for (const mutation of [
    { sha256: '0'.repeat(64) },
    { byte_length: f.bytes.length - 1 },
    { chunk_count: 2 },
    { content_type: 'image/png' },
    { project_id: randomUUID() },
    { account_id: randomUUID() },
    { id: randomUUID() },
  ]) {
    let corrupt = false;
    const audit = observed((sql, result) =>
      isRow(sql) && corrupt
        ? mapRows(result, (row) => ({ ...row, ...mutation }))
        : result,
    );
    const reader = await openOwnedMediaReader(
      audit.pool,
      f.accountId,
      f.assetId,
      keys,
    );
    corrupt = true;
    await assert.rejects(reader.readChunk(0), failure);
    await assert.rejects(
      openOwnedMediaReader(audit.pool, f.accountId, f.assetId, keys),
      failure,
    );
    assert.equal(audit.active, 0);
  }
});

void test('replacement or corrupted manifest cannot change an already opened reader', async () => {
  const f = await fixture();
  const replacement = await encryptMedia(
    f.bytes,
    'video/mp4',
    { accountId: f.accountId, projectId: f.projectId, assetId: f.assetId },
    keys,
  );
  for (const value of [
    replacement.manifest,
    f.encrypted.manifest.slice(0, -4),
  ]) {
    let corrupt = false;
    const audit = observed((sql, result) =>
      isRow(sql) && corrupt
        ? mapRows(result, (row) => ({ ...row, manifest_ciphertext: value }))
        : result,
    );
    const reader = await openOwnedMediaReader(
      audit.pool,
      f.accountId,
      f.assetId,
      keys,
    );
    corrupt = true;
    await assert.rejects(reader.readChunk(0), failure);
    assert.equal(audit.calls.filter((c) => isChunk(c.sql)).length, 0);
    assert.equal(audit.active, 0);
  }
});

void test('missing truncated reordered or corrupted ciphertext never returns chunk bytes', async () => {
  const f = await fixture();
  for (const mutation of [
    (result) => ({ ...result, rows: [] }),
    (result) =>
      mapRows(result, (row) => ({
        ...row,
        ciphertext: row.ciphertext.subarray(0, -1),
      })),
    (result) =>
      mapRows(result, (row) => ({
        ...row,
        ciphertext: Buffer.from(f.encrypted.chunks[1]),
      })),
    (result) => mapRows(result, (row) => ({ ...row, ordinal: 1 })),
    (result) =>
      mapRows(result, (row) => {
        const ciphertext = Buffer.from(row.ciphertext);
        ciphertext[12] ^= 1;
        return { ...row, ciphertext };
      }),
  ]) {
    const audit = observed((sql, result) =>
      isChunk(sql) ? mutation(result) : result,
    );
    const reader = await openOwnedMediaReader(
      audit.pool,
      f.accountId,
      f.assetId,
      keys,
    );
    await assert.rejects(reader.readChunk(0), failure);
    assert.equal(audit.active, 0);
    assert.equal(audit.calls.at(-1).sql, 'ROLLBACK');
  }
});

void test('database independently forbids replacing finalized ciphertext or metadata', async () => {
  const f = await fixture();
  await assert.rejects(
    pool.query(
      'UPDATE media_asset_chunks SET ciphertext=$2 WHERE asset_id=$1 AND ordinal=0',
      [f.assetId, Buffer.from(f.encrypted.chunks[0])],
    ),
    code('23514'),
  );
  await assert.rejects(
    pool.query('UPDATE media_assets SET sha256=$2 WHERE id=$1', [
      f.assetId,
      '0'.repeat(64),
    ]),
    code('23514'),
  );
  const reader = await openOwnedMediaReader(pool, f.accountId, f.assetId, keys);
  assert.deepEqual(
    await reader.readChunk(2),
    new Uint8Array(f.bytes.subarray(2 * MEDIA_CHUNK_BYTES)),
  );
});

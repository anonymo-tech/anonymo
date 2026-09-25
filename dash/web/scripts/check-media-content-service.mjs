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
import {
  generateSessionToken,
  hashToken,
  serializeSessionCookie,
} from '../server/auth/index.ts';
import { dispatch } from '../server/routes/dispatch.ts';

const endpoint = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL);
const pool = createDatabase(endpoint.href, 8);
const keys = {
  active: 'test',
  keys: { test: randomBytes(32).toString('base64') },
};
const policy = {
  accountBytes: 512 * MEDIA_CHUNK_BYTES,
  globalBytes: 16 * 1024 * MEDIA_CHUNK_BYTES,
};
const origin = 'https://conclave.test';
const settings = {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: origin,
  CONCLAVE_DATABASE_URL: endpoint.href,
  CONCLAVE_DATA_KEYS: JSON.stringify(keys.keys),
  CONCLAVE_ACTIVE_DATA_KEY: keys.active,
  CONCLAVE_INFERENCE_ENABLED: 'false',
  CONCLAVE_MEDIA_ENABLED: 'false',
  GATEWAY_API_KEY: undefined,
};
const previous = Object.fromEntries(
  Object.keys(settings).map((key) => [key, process.env[key]]),
);
const originalFetch = globalThis.fetch;
let networkCalls = 0;
before(async () => {
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error('External requests are forbidden in this synthetic test.');
  };
  await migrate(pool);
});
after(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await pool.end();
  assert.equal(networkCalls, 0);
});

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

async function signedFixture() {
  const f = await fixture(),
    token = generateSessionToken(),
    tokenHash = await hashToken(token);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [tokenHash, f.accountId],
  );
  return {
    ...f,
    tokenHash,
    cookie: serializeSessionCookie(token).split(';')[0],
  };
}
function request(
  f,
  {
    method = 'GET',
    headers = {},
    query,
    accountId = f.accountId,
    assetId = f.assetId,
    cookie = f.cookie,
    signal,
    urlOrigin = origin,
  } = {},
) {
  const path = `${urlOrigin}/api/media/assets/${assetId}/content${query ?? `?accountId=${accountId}`}`;
  return new Request(path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    ...(signal ? { signal } : {}),
  });
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
  assert.equal(response.headers.get('content-range'), null);
}
const streamFailure = { message: 'MEDIA_CONTENT_UNAVAILABLE' };

void test('owned content streams through real session authorization without provider configuration or requests', async () => {
  const f = await signedFixture();
  const response = await dispatch(request(f));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  assert.equal(
    response.headers.get('cache-control'),
    'private, no-store, no-transform',
  );
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    response.headers.get('cross-origin-resource-policy'),
    'same-origin',
  );
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(response.headers.has('x-request-id'));
  const reader = response.body.getReader(),
    chunks = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    assert.ok(next.value.length <= MEDIA_CHUNK_BYTES);
    chunks.push(next.value);
  }
  assert.equal(chunks.length, 3);
  assert.deepEqual(Buffer.concat(chunks), f.bytes);
  assert.equal(networkCalls, 0);
  assert.equal(process.env.GATEWAY_API_KEY, undefined);
});

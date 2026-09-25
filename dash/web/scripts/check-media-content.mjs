import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  mediaByteRange,
  mediaContentResponse,
} from '../server/media/content.ts';
import { MEDIA_CHUNK_BYTES } from '../server/media/asset-crypto.ts';

const id = '11111111-1111-4111-8111-111111111111';
const origin = 'https://conclave.invalid';
function fixture({
  length = MEDIA_CHUNK_BYTES * 2 + 7,
  authorize,
  readChunk,
  dispose,
  timeoutMs,
} = {}) {
  const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
  const reads = [];
  let disposed = 0,
    authorizations = 0;
  const dependencies = {
    reader: {
      id,
      accountId: id,
      jobId: id,
      projectId: id,
      contentType: 'video/mp4',
      byteLength: length,
      sha256: 'a'.repeat(64),
      chunkCount: Math.ceil(length / MEDIA_CHUNK_BYTES),
      async readChunk(index) {
        reads.push(index);
        return readChunk
          ? readChunk(index)
          : bytes.slice(
              index * MEDIA_CHUNK_BYTES,
              (index + 1) * MEDIA_CHUNK_BYTES,
            );
      },
    },
    async authorize() {
      authorizations++;
      await authorize?.(authorizations);
    },
    async dispose() {
      disposed++;
      await dispose?.();
    },
    ...(timeoutMs ? { timeoutMs } : {}),
  };
  return {
    bytes,
    reads,
    dependencies,
    get disposed() {
      return disposed;
    },
    get authorizations() {
      return authorizations;
    },
    response(headers = {}, options = {}) {
      return mediaContentResponse(
        new Request(
          `${origin}/api/media/assets/${id}/content${options.query ?? ''}`,
          {
            headers,
            method: options.method ?? 'GET',
            ...(options.signal ? { signal: options.signal } : {}),
          },
        ),
        dependencies,
      );
    },
  };
}

void test('single byte ranges clamp correctly and reject malformed or unsafe ranges', () => {
  for (const [value, start, end, partial] of [
    [null, 0, 99, false],
    ['bytes=0-0', 0, 0, true],
    ['bytes=90-', 90, 99, true],
    ['bytes=90-999', 90, 99, true],
    ['bytes=-10', 90, 99, true],
    ['bytes=-1000', 0, 99, true],
  ])
    assert.deepEqual(mediaByteRange(value, 100), { start, end, partial });
  for (const value of [
    'bytes=',
    'bytes=-',
    'bytes=-0',
    'bytes=100-',
    'bytes=4-3',
    'bytes=1-2,3-4',
    'items=1-2',
    'bytes=1.5-2',
    'bytes=9007199254740992-',
    'bytes=0-9007199254740992',
    'bytes=1-2\r\n',
  ]) {
    assert.throws(() => mediaByteRange(value, 100), { status: 416 });
  }
  assert.throws(() => mediaByteRange(null, 0), { status: 503 });
});

void test('full content is streamed under backpressure with fixed private headers', async () => {
  const f = fixture(),
    response = await f.response();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(
    response.headers.get('cache-control'),
    'private, no-store, no-transform',
  );
  assert.equal(
    response.headers.get('cross-origin-resource-policy'),
    'same-origin',
  );
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(
    response.headers.get('content-disposition'),
    /^inline; filename="conclave-[\da-f-]+\.mp4"$/,
  );
  await delay(5);
  assert.deepEqual(f.reads, []);
  const reader = response.body.getReader(),
    chunks = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    const count = f.reads.length;
    await delay(2);
    assert.equal(f.reads.length, count);
  }
  assert.deepEqual(new Uint8Array(Buffer.concat(chunks)), f.bytes);
  assert.deepEqual(f.reads, [0, 1, 2]);
  assert.equal(f.authorizations, 7);
  assert.equal(f.disposed, 1);
});

void test('boundary range decrypts only intersecting chunks and exposes exact bytes', async () => {
  const f = fixture(),
    start = MEDIA_CHUNK_BYTES - 3,
    end = MEDIA_CHUNK_BYTES + 4;
  const response = await f.response({ range: `bytes=${start}-${end}` });
  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get('content-range'),
    `bytes ${start}-${end}/${f.bytes.length}`,
  );
  assert.equal(response.headers.get('content-length'), '8');
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    f.bytes.slice(start, end + 1),
  );
  assert.deepEqual(f.reads, [0, 1]);
  assert.equal(f.disposed, 1);
});

void test('suffix requests and download disposition preserve exact payload', async () => {
  const f = fixture(),
    response = await f.response(
      { range: 'bytes=-4' },
      { query: '?download=1' },
    );
  assert.equal(response.status, 206);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    f.bytes.slice(-4),
  );
  assert.deepEqual(f.reads, [2]);
});

void test('HEAD authenticates but does not read chunks and ignores ranges', async () => {
  const f = fixture(),
    response = await f.response({ range: 'bytes=-0' }, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  assert.equal(response.headers.get('content-range'), null);
  assert.deepEqual(f.reads, []);
  assert.equal(f.authorizations, 1);
  assert.equal(f.disposed, 1);
});

void test('unsatisfiable range responds after authorization without reading chunks', async () => {
  const f = fixture(),
    response = await f.response({ range: 'bytes=-0' });
  assert.equal(response.status, 416);
  assert.equal(
    response.headers.get('content-range'),
    `bytes */${f.bytes.length}`,
  );
  assert.equal(response.headers.get('content-length'), '0');
  assert.deepEqual(f.reads, []);
  assert.equal(f.disposed, 1);
  const unauthenticated = fixture({
    authorize() {
      throw new Error('SESSION_REQUIRED');
    },
  });
  await assert.rejects(unauthenticated.response({ range: 'bytes=-0' }), {
    message: 'SESSION_REQUIRED',
  });
  assert.equal(unauthenticated.disposed, 1);
});

void test('If-Range needs an exact strong entity tag or falls back to full content', async () => {
  for (const value of [
    `"${id}.${'a'.repeat(64)}"`,
    `W/"${id}.${'a'.repeat(64)}"`,
    'Thu, 01 Jan 1970 00:00:00 GMT',
  ]) {
    const f = fixture({ length: 10 });
    const response = await f.response({
      range: 'bytes=2-4',
      'if-range': value,
    });
    const match = value === `"${id}.${'a'.repeat(64)}"`;
    assert.equal(response.status, match ? 206 : 200);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      match ? f.bytes.slice(2, 5) : f.bytes,
    );
    assert.equal(f.disposed, 1);
  }
});

void test('revoked session after a storage read emits no bytes or raw error', async () => {
  const f = fixture({
    authorize(count) {
      if (count === 3) throw new Error('sensitive session diagnostic');
    },
  });
  const response = await f.response();
  await assert.rejects(response.arrayBuffer(), {
    message: 'MEDIA_CONTENT_UNAVAILABLE',
  });
  assert.deepEqual(f.reads, [0]);
  assert.equal(f.disposed, 1);
});

void test('corrupt and incorrectly sized chunks fail before emission', async () => {
  for (const readChunk of [
    () => {
      throw new Error('sensitive database diagnostic');
    },
    () => new Uint8Array(1),
  ]) {
    const f = fixture({ readChunk }),
      response = await f.response();
    await assert.rejects(response.arrayBuffer(), {
      message: 'MEDIA_CONTENT_UNAVAILABLE',
    });
    assert.equal(f.disposed, 1);
  }
});

void test('consumer cancellation closes resources exactly once without prefetching', async () => {
  const f = fixture(),
    response = await f.response(),
    reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.deepEqual(f.reads, [0]);
  assert.equal(f.disposed, 1);
  assert.equal((await reader.read()).done, true);
});

void test('request abort interrupts an in-flight chunk without emitting its result', async () => {
  const abort = new AbortController();
  let finish, began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const f = fixture({
    readChunk() {
      began();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const response = await f.response({}, { signal: abort.signal });
  const pending = response.body.getReader().read();
  await started;
  abort.abort();
  await assert.rejects(pending, { message: 'MEDIA_CONTENT_UNAVAILABLE' });
  finish(new Uint8Array(MEDIA_CHUNK_BYTES));
  await delay(1);
  assert.equal(f.disposed, 1);
});

void test('deadline terminates an idle response and frees resources', async () => {
  const f = fixture({ timeoutMs: 10 }),
    response = await f.response();
  await delay(25);
  await assert.rejects(response.arrayBuffer(), {
    message: 'MEDIA_CONTENT_UNAVAILABLE',
  });
  assert.equal(f.disposed, 1);
  assert.deepEqual(f.reads, []);
});

void test('pre-aborted request and unsupported method dispose before any read', async () => {
  const abort = new AbortController();
  abort.abort();
  const f = fixture();
  await assert.rejects(f.response({}, { signal: abort.signal }), {
    status: 499,
  });
  assert.equal(f.disposed, 1);
  const g = fixture();
  await assert.rejects(g.response({}, { method: 'POST' }), { status: 405 });
  assert.equal(g.disposed, 1);
});

void test('cleanup failure cannot hang a completed or cancelled stream', async () => {
  const f = fixture({
    length: 5,
    dispose() {
      throw new Error('private cleanup failure');
    },
  });
  const response = await f.response();
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes);
  assert.equal(f.disposed, 1);
  const g = fixture({
    dispose() {
      throw new Error('private cleanup failure');
    },
  });
  await (await g.response()).body.cancel();
  assert.equal(g.disposed, 1);
});

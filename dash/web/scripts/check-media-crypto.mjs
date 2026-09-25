import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  encryptMedia,
  decryptMedia,
  authenticateMediaManifest,
  decryptMediaChunk,
  MEDIA_CHUNK_BYTES,
  MEDIA_MAX_BYTES,
} from '../server/media/asset-crypto.ts';
import { decryptText, encryptText } from '../server/core/encryption.ts';

const identity = {
  accountId: randomUUID(),
  projectId: randomUUID(),
  assetId: randomUUID(),
};
const keys = { active: 'a', keys: { a: randomBytes(32).toString('base64') } };
const plaintext = randomBytes(MEDIA_CHUNK_BYTES + 23);
const stored = await encryptMedia(plaintext, 'video/mp4', identity, keys);
const failure = (error) =>
  error.code === 'MEDIA_CONTENT_UNAVAILABLE' &&
  error.message === 'This saved media could not be verified.';
const clone = () => ({
  manifest: stored.manifest,
  chunks: stored.chunks.map((chunk) => new Uint8Array(chunk)),
});

void test('authenticated multi-chunk media round trips exactly', async () => {
  assert.equal(stored.chunks.length, 2);
  const result = await decryptMedia(stored, identity, keys);
  assert.deepEqual(result.bytes, new Uint8Array(plaintext));
  assert.equal(result.contentType, 'video/mp4');
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(stored.chunks[0].length, MEDIA_CHUNK_BYTES + 28);
  assert.equal(stored.chunks[1].length, 23 + 28);
});

void test('every owner project and asset identity binds decryption', async () => {
  for (const field of Object.keys(identity)) {
    await assert.rejects(
      decryptMedia(stored, { ...identity, [field]: randomUUID() }, keys),
      failure,
    );
  }
});

void test('ciphertext nonce and tag corruption all fail closed', async () => {
  for (const position of [0, 12, stored.chunks[0].length - 1]) {
    const bad = clone();
    bad.chunks[0][position] ^= 1;
    await assert.rejects(decryptMedia(bad, identity, keys), failure);
  }
});

void test('truncation extra chunks and reordered chunks cannot return partial data', async () => {
  for (const chunks of [
    stored.chunks.slice(0, 1),
    [...stored.chunks, stored.chunks[0]],
    [...stored.chunks].reverse(),
    [stored.chunks[0].slice(0, -1), stored.chunks[1]],
  ]) {
    await assert.rejects(
      decryptMedia({ ...stored, chunks }, identity, keys),
      failure,
    );
  }
});

void test('equal-sized chunks cannot be swapped or borrowed from another asset version', async () => {
  const original = randomBytes(2 * MEDIA_CHUNK_BYTES);
  const first = await encryptMedia(original, 'video/mp4', identity, keys);
  const second = await encryptMedia(
    randomBytes(original.length),
    'video/mp4',
    identity,
    keys,
  );
  await assert.rejects(
    decryptMedia(
      { ...first, chunks: [...first.chunks].reverse() },
      identity,
      keys,
    ),
    failure,
  );
  await assert.rejects(
    decryptMedia(
      { ...first, chunks: [second.chunks[0], first.chunks[1]] },
      identity,
      keys,
    ),
    failure,
  );
});

void test('key rotation preserves old assets only while their key is retained', async () => {
  const rotated = {
    active: 'b',
    keys: { ...keys.keys, b: randomBytes(32).toString('base64') },
  };
  assert.deepEqual(
    (await decryptMedia(stored, identity, rotated)).bytes,
    new Uint8Array(plaintext),
  );
  await assert.rejects(
    decryptMedia(stored, identity, {
      active: 'b',
      keys: { b: rotated.keys.b },
    }),
    failure,
  );
  const next = await encryptMedia(
    new Uint8Array([1]),
    'image/png',
    identity,
    rotated,
  );
  assert.match(next.manifest, /^v1\.b\./);
});

void test('independent writes use different nonces and ciphertext', async () => {
  const next = await encryptMedia(plaintext, 'video/mp4', identity, keys);
  assert.notEqual(next.manifest, stored.manifest);
  assert.notDeepEqual(next.chunks[0], stored.chunks[0]);
  assert.notDeepEqual(next.chunks[0].slice(0, 12), next.chunks[1].slice(0, 12));
});

void test('empty oversized unsupported or invalid identities are rejected', async () => {
  const badInputs = [
    [new Uint8Array(), 'image/png', identity],
    [new Uint8Array(MEDIA_MAX_BYTES + 1), 'video/mp4', identity],
    [new Uint8Array(20 * MEDIA_CHUNK_BYTES + 1), 'image/png', identity],
    [new Uint8Array([1]), 'image/svg+xml', identity],
    [new Uint8Array([1]), 'image/png', { ...identity, assetId: '../outside' }],
  ];
  for (const [bytes, type, owner] of badInputs)
    await assert.rejects(encryptMedia(bytes, type, owner, keys), failure);
});

void test('malformed envelopes keyrings and corrupted manifest fail with static errors', async () => {
  for (const bad of [
    null,
    {},
    { manifest: 'x'.repeat(2049), chunks: [] },
    { ...stored, manifest: stored.manifest.slice(0, -5) },
    { ...stored, chunks: null },
  ])
    await assert.rejects(decryptMedia(bad, identity, keys), failure);
  await assert.rejects(
    decryptMedia(stored, identity, {
      active: 'bad',
      keys: { bad: 'secret-value' },
    }),
    failure,
  );
});

void test('authenticated but invalid manifests cannot redirect chunk interpretation', async () => {
  const scope = `${identity.accountId}:${identity.projectId}:${identity.assetId}:media-manifest`;
  const valid = JSON.parse(await decryptText(stored.manifest, scope, keys));
  for (const modification of [
    { byteLength: MEDIA_MAX_BYTES + 1 },
    { chunkCount: 0 },
    { contentType: 'text/html' },
    { version: 2 },
    { extra: true },
    { sha256: '0'.repeat(64) },
    { contentType: 'image/png' },
  ]) {
    const manifest = await encryptText(
      JSON.stringify({ ...valid, ...modification }),
      scope,
      keys,
    );
    await assert.rejects(
      decryptMedia({ ...stored, manifest }, identity, keys),
      failure,
    );
  }
});

void test('caller mutation after encryption begins cannot change the saved snapshot', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const pending = encryptMedia(bytes, 'image/png', identity, keys);
  bytes.fill(9);
  const result = await decryptMedia(await pending, identity, keys);
  assert.deepEqual([...result.bytes], [1, 2, 3]);
});

void test('authenticated manifest permits bounded first and last chunk reads without a full array', async () => {
  const manifest = await authenticateMediaManifest(
    stored.manifest,
    identity,
    keys,
  );
  assert.ok(Object.isFrozen(manifest));
  assert.equal(manifest.byteLength, plaintext.length);
  assert.equal(manifest.chunkCount, 2);
  assert.deepEqual(
    await decryptMediaChunk(stored.chunks[0], 0, manifest),
    new Uint8Array(plaintext.subarray(0, MEDIA_CHUNK_BYTES)),
  );
  assert.deepEqual(
    await decryptMediaChunk(stored.chunks[1], 1, manifest),
    new Uint8Array(plaintext.subarray(MEDIA_CHUNK_BYTES)),
  );
  for (const index of [-1, 0.5, 2, NaN, Infinity, '0'])
    await assert.rejects(
      decryptMediaChunk(stored.chunks[0], index, manifest),
      failure,
    );
});

void test('plain copied or mutated manifests cannot authorize chunk decryption', async () => {
  const manifest = await authenticateMediaManifest(
    stored.manifest,
    identity,
    keys,
  );
  for (const fake of [
    { ...manifest },
    JSON.parse(JSON.stringify(manifest)),
    null,
    undefined,
  ])
    await assert.rejects(decryptMediaChunk(stored.chunks[0], 0, fake), failure);
  assert.throws(() => {
    manifest.byteLength = 1;
  }, TypeError);
  await assert.rejects(
    authenticateMediaManifest(
      stored.manifest,
      { ...identity, assetId: randomUUID() },
      keys,
    ),
    failure,
  );
});

void test('chunk API authenticates nonce tag exact length owner version and index', async () => {
  const data = await encryptMedia(
    randomBytes(2 * MEDIA_CHUNK_BYTES),
    'video/mp4',
    identity,
    keys,
  );
  const manifest = await authenticateMediaManifest(
    data.manifest,
    identity,
    keys,
  );
  await assert.rejects(decryptMediaChunk(data.chunks[1], 0, manifest), failure);
  const other = await encryptMedia(
    randomBytes(2 * MEDIA_CHUNK_BYTES),
    'video/mp4',
    identity,
    keys,
  );
  await assert.rejects(
    decryptMediaChunk(other.chunks[0], 0, manifest),
    failure,
  );
  for (const position of [0, 12, data.chunks[0].length - 1]) {
    const changed = new Uint8Array(data.chunks[0]);
    changed[position] ^= 1;
    await assert.rejects(decryptMediaChunk(changed, 0, manifest), failure);
  }
  await assert.rejects(
    decryptMediaChunk(data.chunks[0].slice(0, -1), 0, manifest),
    failure,
  );
});

void test('chunk decryption snapshots caller ciphertext before yielding', async () => {
  const manifest = await authenticateMediaManifest(
    stored.manifest,
    identity,
    keys,
  );
  const chunk = new Uint8Array(stored.chunks[1]);
  const pending = decryptMediaChunk(chunk, 1, manifest);
  chunk.fill(0);
  assert.deepEqual(
    await pending,
    new Uint8Array(plaintext.subarray(MEDIA_CHUNK_BYTES)),
  );
});

void test('partial authentication is distinct from complete plaintext hash verification', async () => {
  const scope = `${identity.accountId}:${identity.projectId}:${identity.assetId}`;
  const data = new Uint8Array([1, 2, 3]);
  const metadata = {
    version: 1,
    keyId: keys.active,
    contentType: 'image/png',
    byteLength: data.length,
    chunkCount: 1,
    sha256: '0'.repeat(64),
  };
  const manifestCiphertext = await encryptText(
    JSON.stringify(metadata),
    `${scope}:media-manifest`,
    keys,
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(keys.keys[keys.active], 'base64'),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const additionalData = new TextEncoder().encode(
    JSON.stringify([
      'conclave:media-chunk:v1',
      scope,
      metadata.keyId,
      metadata.contentType,
      metadata.byteLength,
      metadata.chunkCount,
      metadata.sha256,
      0,
    ]),
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 },
      key,
      data,
    ),
  );
  const envelope = new Uint8Array(12 + ciphertext.length);
  envelope.set(nonce);
  envelope.set(ciphertext, 12);
  const manifest = await authenticateMediaManifest(
    manifestCiphertext,
    identity,
    keys,
  );
  assert.deepEqual(await decryptMediaChunk(envelope, 0, manifest), data);
  await assert.rejects(
    decryptMedia(
      { manifest: manifestCiphertext, chunks: [envelope] },
      identity,
      keys,
    ),
    failure,
  );
});

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

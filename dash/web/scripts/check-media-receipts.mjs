import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  canonicalReceiptBytes,
  normalizePayload,
  receiptAccountCommitment,
  receiptPublicKey,
  signReceipt,
  signerMapKey,
  verifyReceiptSignature,
  buildReceiptTree,
  verifyReceiptInclusion,
  verifyPublicReceipt,
} from '../server/receipts/index.ts';
const seed = new Uint8Array(randomBytes(32));
const time = '2026-10-10T12:00:00.000Z';
const signer = {
  keyId: 'test-week',
  epoch: 1,
  publicKey: receiptPublicKey(seed),
  validFrom: '2026-10-08T00:00:00.000Z',
  validUntil: '2026-10-15T00:00:00.000Z',
  revoked: false,
};
const trust = new Map([[signerMapKey(signer.keyId, signer.epoch), signer]]);
const media = (update = {}) => ({
  version: 2,
  kind: 'media',
  receiptId: 'media-receipt',
  mediaJobId: 'media-job',
  holdId: 'media-hold',
  accountCommitment: 'a'.repeat(64),
  routeVersion: 'route-media',
  modelId: 'fixture/video-v1',
  modality: 'video',
  signerKeyId: signer.keyId,
  signerEpoch: 1,
  issuedAt: time,
  actualUsd6: '125000',
  settlement: 'captured',
  generationState: 'completed',
  requestDigest: 'b'.repeat(64),
  providerReferenceDigest: 'c'.repeat(64),
  assetDelivery: 'not_attested',
  ...update,
});
const call = () => ({
  version: 1,
  receiptId: 'call-receipt',
  callId: 'call',
  holdId: 'call-hold',
  routeVersion: 'chat-route',
  signerKeyId: signer.keyId,
  signerEpoch: 1,
  issuedAt: time,
  actualUsd6: '250',
  requestDigest: 'd'.repeat(64),
});

void test('media canonical bytes use their own domain and exact order without changing v1 bytes', () => {
  const payload = media(),
    reverse = Object.fromEntries(Object.entries(payload).reverse());
  assert.equal(
    new TextDecoder().decode(canonicalReceiptBytes(reverse)),
    'conclave:receipt:v2\0' + JSON.stringify(payload),
  );
  assert.equal(
    new TextDecoder().decode(canonicalReceiptBytes(call())),
    'conclave:receipt:v1\0' + JSON.stringify(call()),
  );
  assert.notDeepEqual(
    canonicalReceiptBytes(payload),
    canonicalReceiptBytes(call()),
  );
});

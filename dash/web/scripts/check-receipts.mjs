import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  buildReceiptTree,
  canonicalReceiptBytes,
  receiptLeafHash,
  receiptPublicKey,
  rootEvidenceKey,
  signReceipt,
  signerMapKey,
  verifyPublicReceipt,
  verifyReceiptInclusion,
  verifyReceiptSignature,
} from '../server/receipts/index.ts';

// Fresh ephemeral test seeds; no production or fixed signing keys ship in fixtures.
const seed = new Uint8Array(randomBytes(32));
const secondSeed = new Uint8Array(randomBytes(32));
const now = '2026-10-11T12:00:00.000Z';
const payload = (id = 'receipt-a') => ({
  version: 1,
  receiptId: id,
  callId: 'call-a',
  holdId: 'hold-a',
  routeVersion: 'route-v1',
  signerKeyId: 'conclave-key',
  signerEpoch: 1,
  issuedAt: '2026-10-09T12:00:00.000Z',
  actualUsd6: '92000',
  requestDigest: 'a'.repeat(64),
});
const signer = (changes = {}) => ({
  keyId: 'conclave-key',
  epoch: 1,
  publicKey: receiptPublicKey(seed),
  validFrom: '2026-10-01T00:00:00.000Z',
  validUntil: null,
  revoked: false,
  ...changes,
});
const signers = (entry = signer()) =>
  new Map([[signerMapKey(entry.keyId, entry.epoch), entry]]);
const signed = (id = 'receipt-a') => signReceipt(payload(id), seed);
const clone = (value) => JSON.parse(JSON.stringify(value));
const claim = (root) => ({
  version: 1,
  root,
  network: 'solana-devnet',
  transaction: '2'.repeat(88),
});
const evidence = (anchor, finality = 'finalized') => ({
  claim: anchor,
  finality,
  slot: '1000',
  verifiedAt: now,
});

void test('canonical bytes have exact field order and do not depend on input key order', () => {
  const value = payload();
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  assert.deepEqual(
    canonicalReceiptBytes(value),
    canonicalReceiptBytes(reversed),
  );
  assert.equal(
    new TextDecoder().decode(canonicalReceiptBytes(value)),
    'conclave:receipt:v1\0' + JSON.stringify(value),
  );
  assert.ok(
    !new TextDecoder().decode(canonicalReceiptBytes(value)).includes('wallet'),
  );
});

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
void test('account commitment is unambiguous, per-hold, canonical and does not expose stable owner IDs', async () => {
  const owner = randomUUID(),
    hold = randomUUID();
  const expected = createHash('sha256')
    .update(`conclave:receipt-account:v2\0${owner}\0${hold}`)
    .digest('hex');
  assert.equal(await receiptAccountCommitment(owner, hold), expected);
  assert.notEqual(
    await receiptAccountCommitment(owner, randomUUID()),
    expected,
  );
  assert.notEqual(await receiptAccountCommitment(randomUUID(), hold), expected);
  assert.ok(!expected.includes(owner));
  await assert.rejects(receiptAccountCommitment(owner.toUpperCase(), hold));
});
void test('v2 rejects alternate fields, unknown billing, misleading delivery and inconsistent zero or cancellation claims', () => {
  for (const update of [
    { version: 3 },
    { kind: 'call' },
    { actualUsd6: null },
    { actualUsd6: '01' },
    { actualUsd6: 1 },
    { actualUsd6: '0', settlement: 'captured' },
    { settlement: 'released' },
    { generationState: 'polling' },
    { generationState: ['completed'] },
    { generationState: 'cancelled' },
    { providerReferenceDigest: null },
    { providerReferenceDigest: 'x'.repeat(64) },
    { accountCommitment: 'a' },
    { assetDelivery: 'ready' },
    { modelId: 'name\nvalue' },
    { modality: 'chat' },
    { callId: 'fake' },
    { accountId: randomUUID() },
    { wallet: 'extra' },
    { issuedAt: time.replace('Z', '+00:00') },
  ])
    assert.throws(() => normalizePayload(media(update)), {
      code: 'invalid_receipt',
    });
  const payload = media();
  Object.defineProperty(payload, 'version', {
    get() {
      throw Error('must not execute');
    },
  });
  assert.throws(() => normalizePayload(payload), { code: 'invalid_receipt' });
});
void test('known zero generation and pre-dispatch cancellation remain distinct from missing cost', () => {
  const zero = media({ actualUsd6: '0', settlement: 'released' });
  assert.equal(normalizePayload(zero).providerReferenceDigest, 'c'.repeat(64));
  const cancelled = media({
    actualUsd6: '0',
    settlement: 'released',
    generationState: 'cancelled',
    providerReferenceDigest: null,
  });
  assert.equal(normalizePayload(cancelled).generationState, 'cancelled');
  assert.throws(() =>
    normalizePayload({ ...cancelled, providerReferenceDigest: 'c'.repeat(64) }),
  );
  assert.throws(() =>
    normalizePayload({ ...zero, providerReferenceDigest: null }),
  );
  assert.equal(
    normalizePayload({ ...cancelled, generationState: 'failed' }).actualUsd6,
    '0',
  );
});
void test('all new binding fields are covered by the existing Ed25519 verifier', () => {
  const receipt = signReceipt(media(), seed);
  assert.equal(verifyReceiptSignature(receipt, trust, time).valid, true);
  for (const update of [
    { mediaJobId: 'other' },
    { holdId: 'other' },
    { accountCommitment: 'd'.repeat(64) },
    { routeVersion: 'other' },
    { modelId: 'other' },
    { modality: 'image' },
    { actualUsd6: '125001' },
    { generationState: 'failed' },
    { requestDigest: 'd'.repeat(64) },
    { providerReferenceDigest: 'd'.repeat(64) },
  ])
    assert.equal(
      verifyReceiptSignature(
        { ...receipt, payload: { ...receipt.payload, ...update } },
        trust,
        time,
      ).valid,
      false,
    );
  assert.equal(verifyReceiptSignature(receipt, new Map(), time).valid, false);
  assert.equal(
    verifyReceiptSignature(
      receipt,
      new Map([[signerMapKey(signer.keyId, 1), { ...signer, revoked: true }]]),
      time,
    ).valid,
    false,
  );
});
void test('mixed v1 and v2 receipts share deterministic inclusion proofs without implying chain finality', async () => {
  const receipts = [
    signReceipt(media(), seed),
    signReceipt(call(), seed),
    signReceipt(
      media({ receiptId: 'media-other', generationState: 'failed' }),
      seed,
    ),
  ];
  const first = await buildReceiptTree(receipts),
    second = await buildReceiptTree([...receipts].reverse());
  assert.deepEqual(first, second);
  for (const receipt of receipts) {
    const index = first.receiptIds.indexOf(receipt.payload.receiptId);
    assert.equal(
      await verifyReceiptInclusion(receipt, first.proofs[index], first.root),
      true,
    );
    const verified = await verifyPublicReceipt(receipt, {
      signers: trust,
      now: time,
    });
    assert.equal(verified.status, 'signed_pending_anchor');
    assert.equal(verified.anchorVerified, false);
  }
});

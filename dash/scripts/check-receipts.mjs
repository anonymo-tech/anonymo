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

void test('canonical schema rejects alternative time/money forms, unknown fields, and accessors', () => {
  for (const update of [
    { version: 2 },
    { signerEpoch: 0 },
    { actualUsd6: 92000 },
    { actualUsd6: '01' },
    { actualUsd6: '-1' },
    { actualUsd6: '0.5' },
    { actualUsd6: '9000000000000001' },
    { issuedAt: '2026-10-09T08:00:00.000-04:00' },
    { issuedAt: '2026-02-30T12:00:00.000Z' },
    { issuedAt: '2026-10-09T12:00:00Z' },
    { requestDigest: 'A'.repeat(64) },
    { receiptId: 'a\nb' },
    { receiptId: 'é' },
    { wallet: 'not-allowed' },
    { prompt: 'not-allowed' },
  ])
    assert.throws(() => canonicalReceiptBytes({ ...payload(), ...update }));
  const accessor = payload();
  Object.defineProperty(accessor, 'callId', {
    get() {
      throw new Error('must not execute');
    },
  });
  assert.throws(
    () => canonicalReceiptBytes(accessor),
    (error) => error.code === 'invalid_receipt',
  );
});

void test('same key/payload produces deterministic Ed25519 signatures', () => {
  assert.deepEqual(signed(), signed());
  assert.equal(signed().signature.length, 128);
  assert.equal(verifyReceiptSignature(signed(), signers(), now).valid, true);
});

void test('invalid seed sizes are rejected without leaking key material', () => {
  for (const key of [new Uint8Array(31), new Uint8Array(64), 'not-bytes']) {
    assert.throws(
      () => signReceipt(payload(), key),
      (error) => error.code === 'invalid_key',
    );
    assert.throws(
      () => receiptPublicKey(key),
      (error) => error.code === 'invalid_key',
    );
  }
});

void test('amount, call, hold, route, timestamp, and request digest tampering invalidate signatures', () => {
  const original = signed();
  for (const update of [
    { actualUsd6: '92001' },
    { callId: 'call-other' },
    { holdId: 'hold-other' },
    { routeVersion: 'route-v2' },
    { issuedAt: '2026-10-09T13:00:00.000Z' },
    { requestDigest: 'b'.repeat(64) },
  ])
    assert.equal(
      verifyReceiptSignature(
        { ...original, payload: { ...original.payload, ...update } },
        signers(),
        now,
      ).reason,
      'invalid_signature',
    );
});

void test('forged signature or unrelated key cannot validate against trusted signer', () => {
  assert.equal(
    verifyReceiptSignature(signReceipt(payload(), secondSeed), signers(), now)
      .reason,
    'invalid_signature',
  );
  assert.equal(
    verifyReceiptSignature(
      { ...signed(), signature: '00'.repeat(64) },
      signers(),
      now,
    ).reason,
    'invalid_signature',
  );
});

void test('receipt never establishes trust in its own embedded key', () => {
  const forged = signReceipt(payload(), secondSeed);
  assert.equal(
    verifyReceiptSignature(forged, new Map(), now).reason,
    'unknown_signer',
  );
  assert.equal(
    verifyReceiptSignature(
      { ...forged, publicKey: receiptPublicKey(secondSeed) },
      signers(),
      now,
    ).reason,
    'malformed',
  );
});

void test('revocation fails closed and small-order/noncanonical public keys are rejected', () => {
  assert.equal(
    verifyReceiptSignature(signed(), signers(signer({ revoked: true })), now)
      .reason,
    'revoked',
  );
  for (const publicKey of [
    '00'.repeat(32),
    '01' + '00'.repeat(31),
    'ff'.repeat(32),
    'bad',
  ])
    assert.equal(
      verifyReceiptSignature(signed(), signers(signer({ publicKey })), now)
        .reason,
      'invalid_signer',
    );
});

void test('rotation retains valid historical epoch and verifies the new epoch independently', () => {
  const old = signer({ validUntil: '2026-10-10T00:00:00.000Z' });
  const next = signer({
    epoch: 2,
    publicKey: receiptPublicKey(secondSeed),
    validFrom: '2026-10-10T00:00:00.000Z',
  });
  const trusted = new Map([
    [signerMapKey(old.keyId, 1), old],
    [signerMapKey(next.keyId, 2), next],
  ]);
  assert.equal(verifyReceiptSignature(signed(), trusted, now).valid, true);
  const rotated = signReceipt(
    { ...payload(), signerEpoch: 2, issuedAt: '2026-10-10T12:00:00.000Z' },
    secondSeed,
  );
  assert.equal(verifyReceiptSignature(rotated, trusted, now).valid, true);
  assert.equal(
    verifyReceiptSignature(rotated, signers(), now).reason,
    'unknown_signer',
  );
  assert.equal(
    verifyReceiptSignature(
      signReceipt({ ...payload(), issuedAt: old.validUntil }, seed),
      trusted,
      now,
    ).reason,
    'outside_signer_window',
  );
});

void test('future receipts and receipts before signer activation are rejected', () => {
  assert.equal(
    verifyReceiptSignature(signed(), signers(), '2026-10-09T11:59:59.999Z')
      .reason,
    'future_receipt',
  );
  assert.equal(
    verifyReceiptSignature(
      signed(),
      signers(signer({ validFrom: '2026-10-10T00:00:00.000Z' })),
      now,
    ).reason,
    'outside_signer_window',
  );
});

void test('empty trees and duplicate receipt IDs are rejected', async () => {
  await assert.rejects(
    buildReceiptTree([]),
    (error) => error.code === 'empty_tree',
  );
  await assert.rejects(
    buildReceiptTree([signed(), signed()]),
    (error) => error.code === 'duplicate_receipt',
  );
  await assert.rejects(
    buildReceiptTree([
      signed(),
      signReceipt({ ...payload(), actualUsd6: '1' }, seed),
    ]),
    (error) => error.code === 'duplicate_receipt',
  );
});

void test('single-leaf root is count/domain bound with an empty inclusion path', async () => {
  const receipt = signed();
  const tree = await buildReceiptTree([receipt]);
  assert.equal(tree.root.leafCount, 1);
  assert.deepEqual(tree.proofs[0].siblings, []);
  assert.notEqual(tree.root.hash, await receiptLeafHash(receipt));
  assert.equal(
    await verifyReceiptInclusion(receipt, tree.proofs[0], tree.root),
    true,
  );
});

void test('tree roots/proofs sort by receipt ID independently of input order', async () => {
  const receipts = ['receipt-z', 'receipt-a', 'receipt-m'].map(signed);
  const first = await buildReceiptTree(receipts);
  const second = await buildReceiptTree([...receipts].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(first.receiptIds, ['receipt-a', 'receipt-m', 'receipt-z']);
  for (const receipt of receipts) {
    const index = first.receiptIds.indexOf(receipt.payload.receiptId);
    assert.equal(
      await verifyReceiptInclusion(receipt, first.proofs[index], first.root),
      true,
    );
  }
});

void test('odd tree uses promotion, and every proof verifies through several odd levels', async () => {
  const receipts = Array.from({ length: 7 }, (_, index) =>
    signed(`receipt-${index}`),
  );
  const tree = await buildReceiptTree(receipts);
  assert.deepEqual(
    tree.proofs[6].siblings.map((step) => step.level),
    [1, 2],
  );
  for (let index = 0; index < receipts.length; index++)
    assert.equal(
      await verifyReceiptInclusion(
        receipts[index],
        tree.proofs[index],
        tree.root,
      ),
      true,
    );
});

void test('wrong roots, malformed root fields, and count ambiguity fail inclusion', async () => {
  const receipt = signed();
  const tree = await buildReceiptTree([receipt]);
  for (const root of [
    { ...tree.root, hash: 'f'.repeat(64) },
    { ...tree.root, hash: 'a'.repeat(63) },
    { ...tree.root, hash: tree.root.hash.toUpperCase() },
    { ...tree.root, leafCount: 2 },
    { ...tree.root, leafCount: 0 },
    { ...tree.root, leafCount: '1' },
    { ...tree.root, version: 2 },
    { ...tree.root, verified: true },
  ])
    assert.equal(
      await verifyReceiptInclusion(receipt, tree.proofs[0], root),
      false,
    );
});

void test('bad positions, duplicate/missing/extra sibling steps, and changed signatures fail inclusion', async () => {
  const receipts = Array.from({ length: 4 }, (_, index) =>
    signed(`receipt-${index}`),
  );
  const tree = await buildReceiptTree(receipts);
  const original = tree.proofs[0];
  const variants = [
    { ...original, leafIndex: -1 },
    { ...original, leafIndex: 4 },
    { ...original, leafIndex: 1 },
    { ...original, leafCount: 3 },
    { ...original, siblings: original.siblings.slice(1) },
    { ...original, siblings: [...original.siblings, original.siblings[0]] },
  ];
  const wrongSide = clone(original);
  wrongSide.siblings[0].position = 'left';
  variants.push(wrongSide);
  const wrongLevel = clone(original);
  wrongLevel.siblings[0].level = 1;
  variants.push(wrongLevel);
  const duplicate = clone(original);
  duplicate.siblings[1].hash = duplicate.siblings[0].hash;
  variants.push(duplicate);
  for (const proof of variants)
    assert.equal(
      await verifyReceiptInclusion(receipts[0], proof, tree.root),
      false,
    );
  assert.equal(
    await verifyReceiptInclusion(
      { ...receipts[0], signature: '00'.repeat(64) },
      original,
      tree.root,
    ),
    false,
  );
});

void test('signed receipt remains pending until independently trusted finalized root exists', async () => {
  const receipt = signed();
  const trust = { signers: signers(), now };
  assert.equal(
    (await verifyPublicReceipt(receipt, trust)).status,
    'signed_pending_anchor',
  );
  const tree = await buildReceiptTree([receipt]);
  const anchor = claim(tree.root);
  const publication = { claim: anchor, proof: tree.proofs[0] };
  assert.equal(
    (await verifyPublicReceipt(receipt, trust, publication)).reason,
    'root_unverified',
  );
  const roots = new Map([[rootEvidenceKey(anchor), evidence(anchor)]]);
  const checked = await verifyPublicReceipt(
    receipt,
    { ...trust, roots },
    publication,
  );
  assert.equal(checked.status, 'anchored_finalized');
  assert.equal(checked.anchorVerified, true);
  assert.equal(checked.slot, '1000');
});

void test('confirmed anchor evidence is not finalized; invalid external evidence fails closed', async () => {
  const receipt = signed();
  const tree = await buildReceiptTree([receipt]);
  const anchor = claim(tree.root);
  const publication = { claim: anchor, proof: tree.proofs[0] };
  const trust = {
    signers: signers(),
    now,
    roots: new Map([[rootEvidenceKey(anchor), evidence(anchor, 'confirmed')]]),
  };
  assert.equal(
    (await verifyPublicReceipt(receipt, trust, publication)).reason,
    'not_finalized',
  );
  for (const change of [
    { finality: 'claimed' },
    { slot: '-1' },
    { verifiedAt: '2027-01-01T00:00:00.000Z' },
    { claim: { ...anchor, network: 'solana-mainnet-beta' } },
  ]) {
    trust.roots.set(rootEvidenceKey(anchor), {
      ...evidence(anchor),
      ...change,
    });
    assert.equal(
      (await verifyPublicReceipt(receipt, trust, publication)).reason,
      'invalid_root_evidence',
    );
  }
});

void test('published verified flags and invalid proofs cannot manufacture anchor trust', async () => {
  const receipt = signed();
  const tree = await buildReceiptTree([receipt]);
  const anchor = claim(tree.root);
  const trust = { signers: signers(), now };
  assert.equal(
    (
      await verifyPublicReceipt(receipt, trust, {
        claim: { ...anchor, verified: true },
        proof: tree.proofs[0],
      })
    ).reason,
    'invalid_anchor',
  );
  assert.equal(
    (
      await verifyPublicReceipt(receipt, trust, {
        claim: anchor,
        proof: { ...tree.proofs[0], leafIndex: 1 },
      })
    ).reason,
    'invalid_proof',
  );
});

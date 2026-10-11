import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  creditVerifiedDeposit,
  reserveQuote,
  settleHold,
} from '../server/ledger/ledger.ts';
import {
  buildReceiptTree,
  receiptPublicKey,
  signReceipt,
  signerMapKey,
  verifyReceiptInclusion,
  verifyReceiptSignature,
} from '../server/receipts/index.ts';
import {
  buildReceiptHour,
  configuredReceiptSigner,
  configuredReceiptTrust,
  getOwnedReceipt,
  issueCallReceipt,
  receiptTrustFromValues,
} from '../server/receipts/service.ts';
import { verifyReceiptDocument } from './verify-receipt.mjs';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set CONCLAVE_TEST_DATABASE_URL to an isolated PostgreSQL test database.',
  );
const parsed = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
  !parsed.pathname.endsWith('_test')
) {
  throw new Error(
    'Receipt tests require a loopback database whose name ends in _test.',
  );
}
const pool = createDatabase(connection, 12);
before(async () => {
  await migrate(pool);
  await migrate(pool);
});
after(async () => {
  seed.fill(0);
  await pool.end();
});
const seed = new Uint8Array(randomBytes(32));
const now = Date.now();
const registered = {
  keyId: `test-${randomUUID()}`,
  epoch: 1,
  publicKey: receiptPublicKey(seed),
  validFrom: new Date(now - 3 * 86400000).toISOString(),
  validUntil: new Date(now + 86400000).toISOString(),
  revoked: false,
};
const trust = receiptTrustFromValues([registered]);
const signer = { keyId: registered.keyId, epoch: 1, seed, trust };
const completedHour = new Date(
  Math.floor(now / 3600000) * 3600000 - 2 * 3600000,
).toISOString();

async function fixture(actual = '125000') {
  const accountId = randomUUID(),
    projectId = randomUUID(),
    routeId = randomUUID(),
    quoteId = randomUUID(),
    callId = randomUUID();
  const requestHash = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    'INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)',
    [projectId, accountId, 'Receipt test'],
  );
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,'fixture','fixture','chat',true,'{}','{}',now()+interval '1 hour')`,
    [routeId, `fixture-${routeId}`],
  );
  await creditVerifiedDeposit(pool, {
    accountId,
    reference: `receipt_fixture_${randomUUID()}`,
    amountUsd6: '1000000',
  });
  await pool.query(
    `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
    VALUES($1,$2,$3,$4,$5,500000,1000,now()+interval '5 minutes')`,
    [quoteId, accountId, projectId, routeId, requestHash],
  );
  const { hold } = await reserveQuote(pool, {
    accountId,
    quoteId,
    requestHash,
    idempotencyKey: randomUUID(),
  });
  await pool.query(
    `INSERT INTO calls(id,account_id,project_id,hold_id,route_version_id,input_ciphertext,state)
    VALUES($1,$2,$3,$4,$5,'private fixture text','running')`,
    [callId, accountId, projectId, hold.id, routeId],
  );
  if (actual !== null) {
    await settleHold(pool, {
      accountId,
      holdId: hold.id,
      actualUsd6: actual,
      providerReference: 'fixture-result',
    });
    await pool.query("UPDATE calls SET state='succeeded' WHERE id=$1", [
      callId,
    ]);
  }
  return {
    accountId,
    projectId,
    routeId,
    quoteId,
    callId,
    holdId: hold.id,
    requestHash,
    actual,
  };
}

// Test-only historical fixtures exercise hour closure without overriding the service clock.
async function historicalReceipt(f, at) {
  const receipt = signReceipt(
    {
      version: 1,
      receiptId: randomUUID(),
      callId: f.callId,
      holdId: f.holdId,
      routeVersion: f.routeId,
      signerKeyId: signer.keyId,
      signerEpoch: signer.epoch,
      issuedAt: at,
      actualUsd6: f.actual,
      requestDigest: f.requestHash,
    },
    seed,
  );
  await pool.query(
    `INSERT INTO receipts(id,account_id,call_id,hold_id,issued_at,batch_hour,payload,signature)
    VALUES($1,$2,$3,$4,$5,date_trunc('hour',$5::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$6,$7)`,
    [
      receipt.payload.receiptId,
      f.accountId,
      f.callId,
      f.holdId,
      at,
      receipt.payload,
      receipt.signature,
    ],
  );
  return receipt;
}

void test('signer requires separately registered matching public key and a UTC window of at most seven days', () => {
  const env = {
    CONCLAVE_RECEIPT_SIGNER_KEY_ID: registered.keyId,
    CONCLAVE_RECEIPT_SIGNER_EPOCH: '1',
    CONCLAVE_RECEIPT_SIGNER_SEED_HEX: Buffer.from(seed).toString('hex'),
    CONCLAVE_RECEIPT_SIGNER_VALID_FROM: registered.validFrom,
    CONCLAVE_RECEIPT_SIGNER_VALID_UNTIL: registered.validUntil,
    CONCLAVE_RECEIPT_TRUSTED_SIGNERS: JSON.stringify([registered]),
  };
  assert.equal(configuredReceiptSigner(env).keyId, registered.keyId);
  assert.equal(configuredReceiptTrust(env).size, 1);
  for (const changed of [
    { CONCLAVE_RECEIPT_TRUSTED_SIGNERS: undefined },
    { CONCLAVE_RECEIPT_SIGNER_EPOCH: '01' },
    { CONCLAVE_RECEIPT_SIGNER_SEED_HEX: '00'.repeat(32) },
    {
      CONCLAVE_RECEIPT_SIGNER_VALID_FROM: registered.validFrom.replace(
        'Z',
        '+00:00',
      ),
    },
    {
      CONCLAVE_RECEIPT_TRUSTED_SIGNERS: JSON.stringify([
        { ...registered, revoked: true },
      ]),
    },
    {
      CONCLAVE_RECEIPT_TRUSTED_SIGNERS: JSON.stringify([
        {
          ...registered,
          validUntil: new Date(now + 8 * 86400000).toISOString(),
        },
      ]),
    },
  ])
    assert.throws(() => configuredReceiptSigner({ ...env, ...changed }), {
      code: 'RECEIPT_SIGNER_UNAVAILABLE',
    });
  assert.throws(() => receiptTrustFromValues([registered, registered]), {
    code: 'RECEIPT_SIGNER_UNAVAILABLE',
  });
});

void test('concurrent issuance signs and stores a captured call once, without input or owner in the payload', async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => issueCallReceipt(pool, f, signer)),
  );
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(new Set(results.map((r) => r.receipt.signature)).size, 1);
  const receipt = results[0].receipt;
  assert.equal(receipt.payload.actualUsd6, f.actual);
  assert.equal(receipt.payload.requestDigest, f.requestHash);
  assert.equal(receipt.payload.routeVersion, f.routeId);
  assert.equal(
    verifyReceiptSignature(receipt, trust, new Date().toISOString()).valid,
    true,
  );
  assert.ok(!JSON.stringify(receipt).includes(f.accountId));
  assert.ok(!JSON.stringify(receipt).includes('private fixture text'));
  const envelope = await getOwnedReceipt(
    pool,
    f.accountId,
    receipt.payload.receiptId,
  );
  assert.equal(envelope.batch, null);
  assert.deepEqual(envelope.receipt, receipt);
  // An expired signer does not rewrite an already issued immutable receipt.
  const invalid = { ...signer, seed: new Uint8Array(32) };
  assert.equal((await issueCallReceipt(pool, f, invalid)).replayed, true);
});

void test('wrong owners cannot issue or read a receipt; ambiguous and zero-cost holds cannot be receipted', async () => {
  const f = await fixture(),
    foreign = await fixture();
  await assert.rejects(
    issueCallReceipt(pool, { ...f, accountId: foreign.accountId }, signer),
    { code: 'RECEIPT_CALL_NOT_FOUND' },
  );
  const { receipt } = await issueCallReceipt(pool, f, signer);
  await assert.rejects(
    getOwnedReceipt(pool, foreign.accountId, receipt.payload.receiptId),
    { code: 'RECEIPT_NOT_FOUND' },
  );
  for (const actual of [null, '0']) {
    const pending = await fixture(actual);
    await assert.rejects(issueCallReceipt(pool, pending, signer), {
      code: 'RECEIPT_NOT_SETTLED',
    });
  }
});

void test('hold amount and request snapshot tampering cannot create or replay a receipt', async () => {
  const f = await fixture();
  await issueCallReceipt(pool, f, signer);
  await pool.query('UPDATE holds SET captured_usd6=125001 WHERE id=$1', [
    f.holdId,
  ]);
  await assert.rejects(issueCallReceipt(pool, f, signer), {
    code: 'RECEIPT_INTEGRITY_FAILED',
  });
  const altered = await fixture();
  await pool.query('UPDATE holds SET request_hash=$2 WHERE id=$1', [
    altered.holdId,
    'e'.repeat(64),
  ]);
  await assert.rejects(issueCallReceipt(pool, altered, signer), {
    code: 'RECEIPT_INTEGRITY_FAILED',
  });
  const fake = await fixture(null);
  await pool.query(
    "UPDATE holds SET state='captured',captured_usd6=125000 WHERE id=$1",
    [fake.holdId],
  );
  await pool.query("UPDATE calls SET state='succeeded' WHERE id=$1", [
    fake.callId,
  ]);
  await assert.rejects(issueCallReceipt(pool, fake, signer), {
    code: 'RECEIPT_INTEGRITY_FAILED',
  });
});

void test('receipt records are immutable at the database boundary', async () => {
  const f = await fixture();
  const { receipt } = await issueCallReceipt(pool, f, signer);
  await assert.rejects(
    pool.query("UPDATE receipts SET signature=repeat('0',128) WHERE id=$1", [
      receipt.payload.receiptId,
    ]),
    { code: '23514' },
  );
  await assert.rejects(
    pool.query('DELETE FROM receipts WHERE id=$1', [receipt.payload.receiptId]),
    { code: '23514' },
  );
});

void test('completed odd-sized hourly batch is deterministic, complete, immutable and pending only', async () => {
  // Use a different hour on repeated test runs; retained historical rows cannot be rewritten.
  const unused = await pool.query(
    `SELECT candidate AS hour FROM generate_series($1::timestamptz-interval '48 hours',$1::timestamptz,interval '1 hour') candidate
    WHERE NOT EXISTS(SELECT 1 FROM receipt_batches b WHERE b.hour=candidate) AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.batch_hour=candidate)
    ORDER BY candidate DESC LIMIT 1`,
    [completedHour],
  );
  const at = unused.rows[0].hour.toISOString();
  const fixtures = await Promise.all(
    Array.from({ length: 3 }, () => fixture()),
  );
  const receipts = [];
  for (const f of fixtures) receipts.push(await historicalReceipt(f, at));
  const expected = await buildReceiptTree([...receipts].reverse());
  const results = await Promise.all([
    buildReceiptHour(pool, at, trust),
    buildReceiptHour(pool, at, trust),
  ]);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  const batch = results[0].batch;
  assert.equal(batch.state, 'pending_anchor');
  assert.deepEqual(batch.root, expected.root);
  assert.equal(results[1].batch.id, batch.id);
  for (let i = 0; i < receipts.length; i++) {
    const envelope = await getOwnedReceipt(
      pool,
      fixtures[i].accountId,
      receipts[i].payload.receiptId,
    );
    assert.equal(envelope.batch.state, 'pending_anchor');
    assert.equal(
      await verifyReceiptInclusion(
        envelope.receipt,
        envelope.batch.proof,
        batch.root,
      ),
      true,
    );
    assert.equal(
      (await verifyReceiptDocument(envelope, { signers: [registered] })).status,
      'signed_pending_anchor',
    );
  }
  await assert.rejects(
    pool.query('UPDATE receipt_batches SET root=$2 WHERE id=$1', [
      batch.id,
      expected.root,
    ]),
    { code: '23514' },
  );
  await assert.rejects(
    pool.query('DELETE FROM receipt_batch_items WHERE batch_id=$1', [batch.id]),
    { code: '23514' },
  );
  const late = await fixture();
  await assert.rejects(historicalReceipt(late, at), { code: '23514' });
  // Old calls are issued NOW, not backdated into a completed batch.
  await pool.query('UPDATE calls SET created_at=$2 WHERE id=$1', [
    late.callId,
    at,
  ]);
  const lateIssued = await issueCallReceipt(pool, late, signer);
  assert.ok(lateIssued.receipt.payload.issuedAt > at);
  assert.equal(
    (
      await getOwnedReceipt(
        pool,
        late.accountId,
        lateIssued.receipt.payload.receiptId,
      )
    ).batch,
    null,
  );
  assert.deepEqual(
    (await buildReceiptHour(pool, at, trust)).batch.root,
    batch.root,
  );
});

void test('open hours, invalid windows and empty completed hours cannot fabricate roots', async () => {
  const open = new Date(
    Math.floor(Date.now() / 3600000) * 3600000,
  ).toISOString();
  await assert.rejects(buildReceiptHour(pool, open, trust), {
    code: 'RECEIPT_HOUR_OPEN',
  });
  await assert.rejects(
    buildReceiptHour(pool, open.replace('Z', '+00:00'), trust),
    { code: 'INVALID_RECEIPT_HOUR' },
  );
  assert.equal(
    (await buildReceiptHour(pool, '2000-01-01T00:00:00.000Z', trust)).batch,
    null,
  );
});

void test('offline verification rejects tampering and embedded authority; finality needs separate trusted root evidence', async () => {
  const f = await fixture();
  const { receipt } = await issueCallReceipt(pool, f, signer);
  const tree = await buildReceiptTree([receipt]);
  const claim = {
    version: 1,
    root: tree.root,
    network: 'solana-devnet',
    transaction: '2'.repeat(88),
  };
  const document = {
    receipt,
    publication: { claim, proof: tree.proofs[0] },
    publicKey: registered.publicKey,
  };
  const trusted = { signers: [registered] };
  assert.equal(
    (await verifyReceiptDocument(document, trusted)).status,
    'signed_pending_anchor',
  );
  const untrusted = { signers: [{ ...registered, keyId: 'unrelated' }] };
  assert.equal((await verifyReceiptDocument(document, untrusted)).valid, false);
  const altered = {
    ...document,
    receipt: {
      ...receipt,
      payload: { ...receipt.payload, actualUsd6: '125001' },
    },
  };
  assert.equal((await verifyReceiptDocument(altered, trusted)).valid, false);
  const evidence = {
    claim,
    finality: 'finalized',
    slot: '12',
    verifiedAt: new Date().toISOString(),
  };
  assert.equal(
    (await verifyReceiptDocument(document, { ...trusted, roots: [evidence] }))
      .status,
    'anchored_finalized',
  );
  assert.equal(
    (
      await verifyReceiptDocument(document, {
        ...trusted,
        roots: [{ ...evidence, finality: 'confirmed' }],
      })
    ).status,
    'signed_pending_anchor',
  );
  const revocations = { signers: [{ ...registered, revoked: true }] };
  assert.equal(
    (await verifyReceiptDocument(document, revocations)).reason,
    'revoked',
  );
  assert.equal(
    trust.has(signerMapKey(registered.keyId, registered.epoch)),
    true,
  );
});

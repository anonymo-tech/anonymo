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

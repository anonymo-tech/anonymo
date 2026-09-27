import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  creditVerifiedDeposit,
  reserveQuote,
  settleHold,
} from '../server/ledger/ledger.ts';
import {
  receiptPublicKey,
  receiptAccountCommitment,
  signReceipt,
  verifyReceiptSignature,
  buildReceiptTree,
  verifyReceiptInclusion,
} from '../server/receipts/index.ts';
import {
  issueMediaReceipt,
  issuePendingReceipts,
  getOwnedReceipt,
  receiptTrustFromValues,
  buildReceiptHour,
} from '../server/receipts/service.ts';
import { verifyReceiptDocument } from './verify-receipt.mjs';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error('An isolated CONCLAVE_TEST_DATABASE_URL is required.');
const url = new URL(connection);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('Only loopback test databases are supported.');
const pool = createDatabase(connection, 8);
before(() => migrate(pool));
after(async () => {
  seed.fill(0);
  await pool.end();
});
const seed = new Uint8Array(randomBytes(32)),
  now = Date.now();
const registered = {
  keyId: `test-${randomUUID()}`,
  epoch: 1,
  publicKey: receiptPublicKey(seed),
  validFrom: new Date(now - 3 * 86400000).toISOString(),
  validUntil: new Date(now + 86400000).toISOString(),
  revoked: false,
};
const trust = receiptTrustFromValues([registered]),
  signer = { keyId: registered.keyId, epoch: 1, seed, trust };
const error = (code) => (e) => e.code === code;
async function fixture({
  actual = '125000',
  state = 'completed',
  modality = 'image',
  chat = false,
} = {}) {
  const accountId = randomUUID(),
    projectId = randomUUID(),
    routeId = randomUUID(),
    quoteId = randomUUID(),
    mediaJobId = randomUUID(),
    requestHash = randomBytes(32).toString('hex');
  const providerHash =
    state === 'cancelled' ? null : randomBytes(32).toString('hex');
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    'INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)',
    [projectId, accountId, 'Receipt test'],
  );
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) VALUES($1,$2,1,'fixture-media','fixture',$3,true,'{}','{}',now()+interval '1 hour')`,
    [routeId, `fixture-${routeId}`, chat ? 'chat' : modality],
  );
  await creditVerifiedDeposit(pool, {
    accountId,
    reference: `media-receipt-fixture:${randomUUID()}`,
    amountUsd6: '1000000',
  });
  await pool.query(
    `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at) VALUES($1,$2,$3,$4,$5,500000,1,now()+interval '5 minutes')`,
    [quoteId, accountId, projectId, routeId, requestHash],
  );
  if (!chat)
    await pool.query(
      'INSERT INTO media_quote_inputs(quote_id,input_ciphertext) VALUES($1,$2)',
      [quoteId, 'q'.repeat(40)],
    );
  const { hold } = await reserveQuote(pool, {
    accountId,
    quoteId,
    requestHash,
    idempotencyKey: randomUUID(),
  });
  if (chat) {
    await pool.query(
      `INSERT INTO calls(id,account_id,project_id,hold_id,route_version_id,input_ciphertext,state) VALUES($1,$2,$3,$4,$5,'synthetic private input','running')`,
      [mediaJobId, accountId, projectId, hold.id, routeId],
    );
    if (actual !== null) {
      await settleHold(pool, {
        accountId,
        holdId: hold.id,
        actualUsd6: actual,
        providerReference: providerHash,
      });
      await pool.query("UPDATE calls SET state='succeeded' WHERE id=$1", [
        mediaJobId,
      ]);
    }
  } else {
    await pool.query(
      `INSERT INTO media_jobs(id,account_id,project_id,hold_id,route_version_id,input_ciphertext,request_hash,modality) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        mediaJobId,
        accountId,
        projectId,
        hold.id,
        routeId,
        'i'.repeat(40),
        requestHash,
        modality,
      ],
    );
    if (state !== 'cancelled')
      await pool.query(
        "UPDATE media_jobs SET state='dispatching',dispatched_at=now(),provider_reference_hash=$2,provider_reference_ciphertext=$3 WHERE id=$1",
        [mediaJobId, providerHash, 'r'.repeat(40)],
      );
    if (actual !== null) {
      await settleHold(pool, {
        accountId,
        holdId: hold.id,
        actualUsd6: actual,
        providerReference: providerHash,
      });
      await pool.query(
        'UPDATE media_jobs SET state=$2,result_ciphertext=$3 WHERE id=$1',
        [mediaJobId, state, state === 'completed' ? 'o'.repeat(40) : null],
      );
    }
  }
  return {
    accountId,
    projectId,
    routeId,
    quoteId,
    mediaJobId,
    callId: mediaJobId,
    holdId: hold.id,
    requestHash,
    providerHash,
    actual,
    state,
    modality,
  };
}
async function issue(f, custom = signer) {
  return issueMediaReceipt(pool, f, custom);
}
async function historical(f, at, chat = false) {
  const payload = chat
    ? {
        version: 1,
        receiptId: randomUUID(),
        callId: f.callId,
        holdId: f.holdId,
        routeVersion: f.routeId,
        signerKeyId: signer.keyId,
        signerEpoch: 1,
        issuedAt: at,
        actualUsd6: f.actual,
        requestDigest: f.requestHash,
      }
    : {
        version: 2,
        kind: 'media',
        receiptId: randomUUID(),
        mediaJobId: f.mediaJobId,
        holdId: f.holdId,
        accountCommitment: await receiptAccountCommitment(
          f.accountId,
          f.holdId,
        ),
        routeVersion: f.routeId,
        modelId: 'fixture-media',
        modality: f.modality,
        signerKeyId: signer.keyId,
        signerEpoch: 1,
        issuedAt: at,
        actualUsd6: f.actual,
        settlement: f.actual === '0' ? 'released' : 'captured',
        generationState: f.state,
        requestDigest: f.requestHash,
        providerReferenceDigest: f.providerHash,
        assetDelivery: 'not_attested',
      };
  const receipt = signReceipt(payload, seed);
  await pool.query(
    `INSERT INTO receipts(id,account_id,call_id,media_job_id,hold_id,issued_at,batch_hour,payload,signature) VALUES($1,$2,$3,$4,$5,$6,date_trunc('hour',$6::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$7,$8)`,
    [
      payload.receiptId,
      f.accountId,
      chat ? f.callId : null,
      chat ? null : f.mediaJobId,
      f.holdId,
      at,
      payload,
      receipt.signature,
    ],
  );
  return receipt;
}

void test('concurrent media issuance binds exact settlement/model/request/provider without identifying plaintext', async () => {
  const f = await fixture(),
    results = await Promise.all(Array.from({ length: 5 }, () => issue(f)));
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(new Set(results.map((r) => r.receipt.signature)).size, 1);
  const receipt = results[0].receipt,
    p = receipt.payload;
  assert.equal(p.version, 2);
  assert.equal(p.kind, 'media');
  assert.equal(p.mediaJobId, f.mediaJobId);
  assert.equal(p.holdId, f.holdId);
  assert.equal(p.routeVersion, f.routeId);
  assert.equal(p.modelId, 'fixture-media');
  assert.equal(p.actualUsd6, '125000');
  assert.equal(p.settlement, 'captured');
  assert.equal(p.generationState, 'completed');
  assert.equal(p.requestDigest, f.requestHash);
  assert.equal(p.providerReferenceDigest, f.providerHash);
  assert.equal(
    p.accountCommitment,
    await receiptAccountCommitment(f.accountId, f.holdId),
  );
  assert.equal(p.assetDelivery, 'not_attested');
  assert.ok(!JSON.stringify(receipt).includes(f.accountId));
  assert.ok(!JSON.stringify(receipt).includes('q'.repeat(40)));
  assert.equal(
    verifyReceiptSignature(receipt, trust, new Date().toISOString()).valid,
    true,
  );
  assert.equal(
    (await getOwnedReceipt(pool, f.accountId, p.receiptId)).batch,
    null,
  );
  assert.equal(
    (await issue(f, { ...signer, seed: new Uint8Array(32) })).replayed,
    true,
  );
});
void test('known zero completion, free cancellation and charged failure have explicit distinct semantics', async () => {
  for (const options of [
    { actual: '0' },
    { actual: '0', state: 'cancelled' },
    { actual: '75000', state: 'failed', modality: 'video' },
    { actual: '500000' },
  ]) {
    const f = await fixture(options),
      { receipt } = await issue(f);
    assert.equal(receipt.payload.actualUsd6, f.actual);
    assert.equal(receipt.payload.generationState, f.state);
    assert.equal(
      receipt.payload.settlement,
      f.actual === '0' ? 'released' : 'captured',
    );
    assert.equal(receipt.payload.providerReferenceDigest, f.providerHash);
    assert.equal(receipt.payload.assetDelivery, 'not_attested');
  }
});
void test('existing worker sweep issues both chat and media with the same weekly signer', async () => {
  const chat = await fixture({ chat: true }),
    media = await fixture();
  const result = await issuePendingReceipts(pool, signer, 1000);
  assert.equal(result.issued, 2);
  const rows = await pool.query(
    'SELECT payload FROM receipts WHERE hold_id=ANY($1::uuid[])',
    [[chat.holdId, media.holdId]],
  );
  assert.deepEqual(
    rows.rows.map((r) => r.payload.version).sort((a, b) => a - b),
    [1, 2],
  );
  assert.deepEqual(await issuePendingReceipts(pool, signer, 1000), {
    issued: 0,
    replayed: 0,
  });
});
void test('media owners remain fenced and disabled owners can finish already-incurred signing obligations', async () => {
  const f = await fixture(),
    other = await fixture();
  await assert.rejects(
    issue({ ...f, accountId: other.accountId }),
    error('RECEIPT_MEDIA_NOT_FOUND'),
  );
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    f.accountId,
  ]);
  const { receipt } = await issue(f);
  await assert.rejects(
    getOwnedReceipt(pool, other.accountId, receipt.payload.receiptId),
    error('RECEIPT_NOT_FOUND'),
  );
  await issue(other);
});
void test('mixed historical chat/media hourly batches use existing immutable proofs and remain unanchored', async () => {
  const hour = new Date(
    Math.floor(Date.now() / 3600000) * 3600000 - 2 * 3600000,
  ).toISOString();
  const fixtures = [
    await fixture({ chat: true }),
    await fixture(),
    await fixture({ actual: '0', state: 'cancelled' }),
  ];
  const receipts = [];
  for (let i = 0; i < fixtures.length; i++)
    receipts.push(await historical(fixtures[i], hour, i === 0));
  const expected = await buildReceiptTree(receipts);
  const first = await buildReceiptHour(pool, hour, trust);
  assert.deepEqual(first.batch.root, expected.root);
  assert.equal(first.batch.state, 'pending_anchor');
  for (let i = 0; i < receipts.length; i++) {
    const envelope = await getOwnedReceipt(
      pool,
      fixtures[i].accountId,
      receipts[i].payload.receiptId,
    );
    assert.equal(
      await verifyReceiptInclusion(
        envelope.receipt,
        envelope.batch.proof,
        envelope.batch.root,
      ),
      true,
    );
    assert.equal(
      (await verifyReceiptDocument(envelope, { signers: [registered] })).status,
      'signed_pending_anchor',
    );
  }
  assert.equal((await buildReceiptHour(pool, hour, trust)).replayed, true);
  const late = await fixture();
  await assert.rejects(historical(late, hour), error('23514'));
  assert.ok((await issue(late)).receipt.payload.issuedAt > hour);
});
void test('pending, ambiguous and nonterminal generation cannot manufacture a receipt', async () => {
  const f = await fixture({ actual: null });
  await assert.rejects(issue(f), error('RECEIPT_NOT_SETTLED'));
  await pool.query(
    "UPDATE holds SET state='reconciliation_pending' WHERE id=$1",
    [f.holdId],
  );
  await assert.rejects(issue(f), error('RECEIPT_NOT_SETTLED'));
  await settleHold(pool, {
    accountId: f.accountId,
    holdId: f.holdId,
    actualUsd6: '1000',
    providerReference: f.providerHash,
  });
  await assert.rejects(issue(f), error('RECEIPT_NOT_SETTLED'));
});
void test('forged zero and positive hold states cannot replace exact immutable ledger settlement', async () => {
  for (const actual of ['0', '25000']) {
    const f = await fixture({ actual: null });
    await pool.query(
      'UPDATE holds SET state=$2,captured_usd6=$3,provider_reference=$4 WHERE id=$1',
      [
        f.holdId,
        actual === '0' ? 'released' : 'captured',
        actual,
        f.providerHash,
      ],
    );
    await pool.query(
      "UPDATE media_jobs SET state='completed',result_ciphertext=$2 WHERE id=$1",
      [f.mediaJobId, 'o'.repeat(40)],
    );
    await assert.rejects(issue(f), error('RECEIPT_INTEGRITY_FAILED'));
  }
});
void test('provider, amount, request and remainder mismatches prevent new or replayed receipts', async () => {
  for (const alteration of ['provider', 'amount', 'request', 'maximum']) {
    const f = await fixture();
    await issue(f);
    if (alteration === 'provider')
      await pool.query('UPDATE holds SET provider_reference=$2 WHERE id=$1', [
        f.holdId,
        'f'.repeat(64),
      ]);
    if (alteration === 'amount')
      await pool.query('UPDATE holds SET captured_usd6=125001 WHERE id=$1', [
        f.holdId,
      ]);
    if (alteration === 'request')
      await pool.query('UPDATE holds SET request_hash=$2 WHERE id=$1', [
        f.holdId,
        'f'.repeat(64),
      ]);
    if (alteration === 'maximum')
      await pool.query('UPDATE holds SET maximum_usd6=500001 WHERE id=$1', [
        f.holdId,
      ]);
    await assert.rejects(issue(f), error('RECEIPT_INTEGRITY_FAILED'));
  }
});
void test('dispatched or charged cancellation is rejected even if raw generation state is made terminal', async () => {
  const f = await fixture({ actual: null });
  await settleHold(pool, {
    accountId: f.accountId,
    holdId: f.holdId,
    actualUsd6: '0',
    providerReference: f.providerHash,
  });
  await pool.query("UPDATE media_jobs SET state='cancelled' WHERE id=$1", [
    f.mediaJobId,
  ]);
  await assert.rejects(issue(f), error('RECEIPT_INTEGRITY_FAILED'));
});
void test('database media binding rejects forged source fields, cross-owner rows and dual source identity', async () => {
  const f = await fixture(),
    validAt = new Date().toISOString();
  const receipt = signReceipt(
    {
      version: 2,
      kind: 'media',
      receiptId: randomUUID(),
      mediaJobId: f.mediaJobId,
      holdId: f.holdId,
      accountCommitment: await receiptAccountCommitment(f.accountId, f.holdId),
      routeVersion: f.routeId,
      modelId: 'fixture-media',
      modality: f.modality,
      signerKeyId: signer.keyId,
      signerEpoch: 1,
      issuedAt: validAt,
      actualUsd6: f.actual,
      settlement: 'captured',
      generationState: 'completed',
      requestDigest: f.requestHash,
      providerReferenceDigest: f.providerHash,
      assetDelivery: 'not_attested',
    },
    seed,
  );
  const insert = (payload) =>
    pool.query(
      `INSERT INTO receipts(id,account_id,media_job_id,hold_id,issued_at,batch_hour,payload,signature) VALUES($1,$2,$3,$4,$5,date_trunc('hour',$5::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$6,$7)`,
      [
        payload.receiptId,
        f.accountId,
        f.mediaJobId,
        f.holdId,
        validAt,
        payload,
        receipt.signature,
      ],
    );
  for (const changed of [
    { modelId: 'wrong' },
    { accountCommitment: 'd'.repeat(64) },
    { providerReferenceDigest: null },
    { actualUsd6: '1' },
    { assetDelivery: 'delivered' },
    { modality: 'video' },
  ])
    await assert.rejects(
      insert({ ...receipt.payload, ...changed }),
      error('23514'),
    );
  const foreign = await fixture(),
    chat = await fixture({ chat: true });
  await assert.rejects(
    pool.query(
      `INSERT INTO receipts(id,account_id,media_job_id,hold_id,issued_at,batch_hour,payload,signature) VALUES($1,$2,$3,$4,$5,date_trunc('hour',$5::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$6,$7)`,
      [
        receipt.payload.receiptId,
        foreign.accountId,
        f.mediaJobId,
        f.holdId,
        validAt,
        receipt.payload,
        receipt.signature,
      ],
    ),
    error('23514'),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO receipts(id,account_id,call_id,media_job_id,hold_id,issued_at,batch_hour,payload,signature) VALUES($1,$2,$3,$4,$5,$6,date_trunc('hour',$6::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$7,$8)`,
      [
        receipt.payload.receiptId,
        f.accountId,
        chat.callId,
        f.mediaJobId,
        f.holdId,
        validAt,
        receipt.payload,
        receipt.signature,
      ],
    ),
    error('23514'),
  );
  for (const changed of [
    { mediaJobId: null },
    { kind: null },
    { version: null },
  ])
    await assert.rejects(
      insert({
        ...receipt.payload,
        ...changed,
        receiptId: receipt.payload.receiptId,
      }),
      error('23514'),
    );
  await insert(receipt.payload);
  await assert.rejects(
    pool.query('UPDATE receipts SET payload=$2 WHERE id=$1', [
      receipt.payload.receiptId,
      { ...receipt.payload, actualUsd6: '1' },
    ]),
    error('23514'),
  );
  await assert.rejects(
    pool.query('DELETE FROM receipts WHERE id=$1', [receipt.payload.receiptId]),
    error('23514'),
  );
  assert.equal((await issue(f)).replayed, true);
});
void test('media signing refuses unknown or revoked authority and never embeds a trusted key', async () => {
  const f = await fixture();
  await assert.rejects(
    issue(f, { ...signer, trust: new Map() }),
    error('RECEIPT_SIGNER_UNAVAILABLE'),
  );
  const revoked = receiptTrustFromValues([{ ...registered, revoked: true }]);
  await assert.rejects(
    issue(f, { ...signer, trust: revoked }),
    error('RECEIPT_SIGNER_UNAVAILABLE'),
  );
  const { receipt } = await issue(f);
  assert.ok(!JSON.stringify(receipt).includes(registered.publicKey));
  assert.equal(
    (
      await verifyReceiptDocument(receipt, {
        signers: [{ ...registered, revoked: true }],
      })
    ).valid,
    false,
  );
});

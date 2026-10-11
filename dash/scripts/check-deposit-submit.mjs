import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import bs58 from 'bs58';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  prepareOwnedPayment,
  getOwnedPayment,
} from '../server/solana/deposit-payment.ts';
import { submitOwnedPayment } from '../server/solana/deposit-submit.ts';
import { creditDepositEvidence } from '../server/solana/deposit-store.ts';
import { getBalance } from '../server/ledger/ledger.ts';
import { depositPaymentRoutes } from '../server/routes/deposit-payments.ts';
import { handleApi } from '../server/core/http.ts';
import { SOLANA_NETWORKS, TOKEN_PROGRAM } from '../server/solana/validation.ts';
import {
  decodeTransactionBase64,
  encodeTransactionBase64,
} from '../lib/solana/deposit-transaction.ts';
import { depositPaymentFixture } from './fixtures/deposit-payment.mjs';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error('An isolated CONCLAVE_TEST_DATABASE_URL is required.');
const endpoint = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
  !endpoint.pathname.endsWith('_test')
)
  throw new Error('Only local test databases are supported.');
const pool = createDatabase(connection, 8);
before(() => migrate(pool));
after(() => pool.end());

async function ready() {
  const f = await depositPaymentFixture(pool);
  const { payment } = await prepareOwnedPayment(pool, f.accountId, f.intentId, {
    rpc: f.rpc,
  });
  const signedTransaction = f.signPayment(payment);
  const signature = bs58.encode(
    decodeTransactionBase64(signedTransaction).subarray(1, 65),
  );
  return {
    f,
    payment,
    signedTransaction,
    signature,
    input: {
      accountId: f.accountId,
      intentId: f.intentId,
      paymentId: payment.id,
      signedTransaction,
    },
  };
}
const sends = (f) =>
  f.calls.filter((call) => call.method === 'sendTransaction');

void test('signed bytes are durably retained before broadcast and RPC acceptance does not create credit', async () => {
  const { f, payment, input, signature } = await ready();
  f.handlers.sendTransaction = async (params) => {
    const row = (
      await pool.query(
        'SELECT state,signature,signed_transaction FROM deposit_payments WHERE id=$1',
        [payment.id],
      )
    ).rows[0];
    assert.equal(row.state, 'submitted');
    assert.ok(
      row.signature === signature && row.signed_transaction === params[0],
    );
    assert.deepEqual(params[1], {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 0,
      minContextSlot: f.slot,
    });
    return signature;
  };
  const result = await submitOwnedPayment(pool, input, { rpc: f.rpc });
  assert.equal(result.submitted, true);
  assert.equal(result.replayed, false);
  assert.equal(result.deposit.state, 'awaiting_payment');
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '0');
  assert.ok(result.payment.acknowledgedAt);
  assert.equal(sends(f).length, 1);
});

void test('a lost broadcast response retains the signature and explicit retry sends identical bytes once', async () => {
  const { f, input, signedTransaction, signature } = await ready();
  f.handlers.sendTransaction = () => {
    throw new Error('Synthetic lost RPC response');
  };
  await assert.rejects(submitOwnedPayment(pool, input, { rpc: f.rpc }), {
    code: 'DEPOSIT_SUBMISSION_UNCERTAIN',
  });
  const saved = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(saved.state, 'submitted');
  assert.equal(saved.signature, signature);
  assert.equal(saved.acknowledgedAt, null);
  assert.equal(saved.canSign, false);
  assert.equal(saved.canSubmit, true);
  delete f.handlers.sendTransaction;
  const result = await submitOwnedPayment(
    pool,
    { ...input, signedTransaction: undefined },
    { rpc: f.rpc },
  );
  assert.equal(result.replayed, true);
  assert.equal(result.submitted, true);
  assert.equal(sends(f).length, 2);
  assert.ok(sends(f).every((call) => call.params[0] === signedTransaction));
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '0');
});

void test('concurrent submissions share one immutable signature and cannot create another payment', async () => {
  const { f, input, signedTransaction } = await ready();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      submitOwnedPayment(pool, input, { rpc: f.rpc }),
    ),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.ok(sends(f).every((call) => call.params[0] === signedTransaction));
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM deposit_payments WHERE intent_id=$1',
        [f.intentId],
      )
    ).rows[0].count,
    '1',
  );
});

void test('signature or message tampering fails before persistence and any RPC write', async () => {
  const { f, input, signedTransaction } = await ready();
  for (const index of [1, 66, 180, 311]) {
    const wire = decodeTransactionBase64(signedTransaction);
    wire[index] ^= 1;
    await assert.rejects(
      submitOwnedPayment(
        pool,
        { ...input, signedTransaction: encodeTransactionBase64(wire) },
        { rpc: f.rpc },
      ),
      { code: 'DEPOSIT_SIGNATURE_INVALID' },
    );
  }
  const row = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(row.id, input.paymentId);
  assert.equal(row.signature, null);
  assert.equal(row.state, 'prepared');
  assert.equal(sends(f).length, 0);
});

void test('wrong owner and wrong payment identifier cannot reveal or broadcast saved bytes', async () => {
  const { f, input } = await ready();
  const other = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [other]);
  await assert.rejects(
    submitOwnedPayment(pool, { ...input, accountId: other }, { rpc: f.rpc }),
    { code: 'DEPOSIT_NOT_FOUND' },
  );
  await assert.rejects(
    submitOwnedPayment(
      pool,
      { ...input, paymentId: randomUUID() },
      { rpc: f.rpc },
    ),
    { code: 'DEPOSIT_PAYMENT_NOT_FOUND' },
  );
  assert.equal(sends(f).length, 0);
});

void test('wrong network and expired blockhash retain recovery evidence without broadcasting', async () => {
  const { f, input, signature } = await ready();
  f.genesisHash = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
  await assert.rejects(submitOwnedPayment(pool, input, { rpc: f.rpc }), {
    code: 'DEPOSIT_SUBMISSION_UNCERTAIN',
  });
  assert.equal(
    (await getOwnedPayment(pool, f.accountId, f.intentId)).signature,
    signature,
  );
  f.genesisHash = SOLANA_NETWORKS.devnet.genesisHash;
  f.height = f.lastValidBlockHeight + 1;
  await assert.rejects(
    submitOwnedPayment(
      pool,
      { ...input, signedTransaction: undefined },
      { rpc: f.rpc },
    ),
    { code: 'DEPOSIT_PAYMENT_EXPIRED' },
  );
  assert.equal(sends(f).length, 0);
});

void test('expired review and disabled payment gate never pin a new signature', async () => {
  const { f, input } = await ready();
  process.env.CONCLAVE_DEPOSIT_PAYMENTS_ENABLED = 'false';
  await assert.rejects(submitOwnedPayment(pool, input, { rpc: f.rpc }), {
    code: 'DEPOSIT_PAYMENTS_DISABLED',
  });
  f.installConfig();
  const originalNow = Date.now;
  try {
    const future = originalNow() + 100000;
    Date.now = () => future;
    await assert.rejects(submitOwnedPayment(pool, input, { rpc: f.rpc }), {
      code: 'DEPOSIT_PAYMENT_EXPIRED',
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(
    (await getOwnedPayment(pool, f.accountId, f.intentId)).signature,
    null,
  );
  assert.equal(sends(f).length, 0);
});

void test('gate revocation during validity checking prevents the pending broadcast', async () => {
  const { f, input, signature } = await ready();
  f.handlers.getBlockHeight = () => {
    process.env.CONCLAVE_DEPOSIT_PAYMENTS_ENABLED = 'false';
    return f.height;
  };
  await assert.rejects(submitOwnedPayment(pool, input, { rpc: f.rpc }), {
    code: 'DEPOSIT_PAYMENTS_DISABLED',
  });
  assert.equal(
    (await getOwnedPayment(pool, f.accountId, f.intentId)).signature,
    signature,
  );
  assert.equal(sends(f).length, 0);
});

void test('a mismatched RPC acknowledgment remains uncertain and cannot rewrite the original signature', async () => {
  const { f, input, signature } = await ready();
  f.handlers.sendTransaction = () => bs58.encode(randomBytes(64));
  await assert.rejects(submitOwnedPayment(pool, input, { rpc: f.rpc }), {
    code: 'DEPOSIT_SUBMISSION_UNCERTAIN',
  });
  const saved = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(saved.signature, signature);
  assert.equal(saved.acknowledgedAt, null);
});

void test('request cancellation after persistence retains the original signature without sending', async () => {
  const { f, input, signature } = await ready();
  const controller = new AbortController();
  f.handlers.getBlockHeight = () => {
    controller.abort();
    return f.height;
  };
  await assert.rejects(
    submitOwnedPayment(pool, input, { rpc: f.rpc, signal: controller.signal }),
    { code: 'DEPOSIT_SUBMISSION_UNCERTAIN' },
  );
  assert.equal(
    (await getOwnedPayment(pool, f.accountId, f.intentId)).signature,
    signature,
  );
  assert.equal(sends(f).length, 0);
});

function evidence(f, signedTransaction) {
  const wire = decodeTransactionBase64(signedTransaction),
    message = wire.subarray(65);
  const signature = bs58.encode(wire.subarray(1, 65));
  const keys = Array.from({ length: 6 }, (_, i) =>
    bs58.encode(message.subarray(4 + i * 32, 36 + i * 32)),
  );
  const balance = (accountIndex, owner, value) => ({
    accountIndex,
    mint: f.mint,
    owner,
    programId: TOKEN_PROGRAM,
    uiTokenAmount: {
      amount: value,
      decimals: 6,
      uiAmount: null,
      uiAmountString: 'ignored',
    },
  });
  return {
    cluster: 'devnet',
    genesisHash: SOLANA_NETWORKS.devnet.genesisHash,
    signature,
    status: {
      slot: 2010,
      confirmations: null,
      err: null,
      confirmationStatus: 'finalized',
    },
    transaction: {
      version: 'legacy',
      slot: 2010,
      blockTime: Math.floor(Date.now() / 1000),
      meta: {
        err: null,
        innerInstructions: [],
        loadedAddresses: { writable: [], readonly: [] },
        preTokenBalances: [
          balance(1, f.sourceWallet, '5000000'),
          balance(2, f.recipientWallet, '0'),
        ],
        postTokenBalances: [
          balance(1, f.sourceWallet, '4000000'),
          balance(2, f.recipientWallet, '1000000'),
        ],
      },
      transaction: {
        signatures: [signature],
        message: {
          header: {
            numRequiredSignatures: message[0],
            numReadonlySignedAccounts: message[1],
            numReadonlyUnsignedAccounts: message[2],
          },
          accountKeys: keys,
          instructions: [
            {
              programIdIndex: message[229],
              accounts: [...message.subarray(231, 236)],
              data: bs58.encode(message.subarray(237)),
            },
          ],
        },
      },
    },
  };
}

void test('the constructed and signed transfer passes finalized deposit verification and credits exactly once', async () => {
  const { f, input, signedTransaction } = await ready();
  await submitOwnedPayment(pool, input, { rpc: f.rpc });
  const proof = evidence(f, signedTransaction);
  const first = await creditDepositEvidence(
    pool,
    f.accountId,
    f.intentId,
    proof,
  );
  const second = await creditDepositEvidence(
    pool,
    f.accountId,
    f.intentId,
    proof,
  );
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
  const saved = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(saved.state, 'finalized');
  assert.ok(saved.finalizedAt);
  assert.equal(saved.canSign, false);
  assert.equal(saved.canSubmit, false);
  const prior = sends(f).length;
  await submitOwnedPayment(pool, input, { rpc: f.rpc });
  assert.equal(sends(f).length, prior);
});

void test('account disabling during preflight prevents dispatch while retaining the signed attempt', async () => {
  const { f, input, signature } = await ready();
  f.handlers.getBlockHeight = async () => {
    await pool.query(
      'UPDATE accounts SET disabled_at=clock_timestamp() WHERE id=$1',
      [f.accountId],
    );
    return f.height;
  };
  await assert.rejects(submitOwnedPayment(pool, input, { rpc: f.rpc }), {
    code: 'ACCOUNT_UNAVAILABLE',
  });
  assert.equal(sends(f).length, 0);
  const row = (
    await pool.query(
      'SELECT signature,acknowledged_at FROM deposit_payments WHERE id=$1',
      [input.paymentId],
    )
  ).rows[0];
  assert.equal(row.signature, signature);
  assert.equal(row.acknowledged_at, null);
});

void test('unlinking the source wallet during preflight prevents broadcast and preserves recovery', async () => {
  const { f, input, signedTransaction, signature } = await ready();
  f.handlers.getBlockHeight = async () => {
    await pool.query(
      'UPDATE identities SET revoked_at=clock_timestamp() WHERE account_id=$1 AND subject=$2',
      [f.accountId, f.sourceWallet],
    );
    return f.height;
  };
  await assert.rejects(submitOwnedPayment(pool, input, { rpc: f.rpc }), {
    code: 'DEPOSIT_SOURCE_UNAVAILABLE',
  });
  assert.equal(sends(f).length, 0);
  const saved = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(saved.signature, signature);
  assert.equal(saved.acknowledgedAt, null);
  // A transfer finalized outside this submission still belongs to this account.
  const settled = await creditDepositEvidence(
    pool,
    f.accountId,
    f.intentId,
    evidence(f, signedTransaction),
  );
  assert.equal(settled.replayed, false);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});

void test('another finalized payment during preflight credits the intent and suppresses this send', async () => {
  const { f, input, signedTransaction } = await ready();
  f.handlers.getBlockHeight = async () => {
    const proof = evidence(f, signedTransaction);
    proof.signature = bs58.encode(randomBytes(64));
    proof.transaction.transaction.signatures = [proof.signature];
    await creditDepositEvidence(pool, f.accountId, f.intentId, proof);
    return f.height;
  };
  const result = await submitOwnedPayment(pool, input, { rpc: f.rpc });
  assert.equal(result.deposit.state, 'credited');
  assert.equal(result.replayed, true);
  assert.equal(sends(f).length, 0);
  assert.equal(result.payment.state, 'submitted');
  assert.equal(result.payment.finalizedAt, null);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});

void test('payment routes accept only owned exact bodies and use bounded explicit submit transport', async () => {
  const { f, payment, input } = await ready();
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    return Response.json({
      jsonrpc: '2.0',
      id,
      result: await f.rpc.call(method, params, init.signal),
    });
  };
  const route = async (suffix, body, method = 'POST') =>
    handleApi(() =>
      depositPaymentRoutes(
        pool,
        new Request(
          'https://workspace.example.test/api/deposits/' +
            f.intentId +
            '/' +
            suffix,
          {
            method,
            ...(method === 'GET'
              ? {}
              : {
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                }),
          },
        ),
        'deposits/' + f.intentId + '/' + suffix,
        f.accountId,
      ),
    );
  try {
    const read = await route('payment', null, 'GET');
    assert.equal(read.status, 200);
    assert.equal((await read.json()).payment.id, payment.id);
    const invalid = await route('payment/submit', {
      ...input,
      amountUsd6: '2',
    });
    assert.equal(invalid.status, 400);
    const result = await route('payment/submit', {
      paymentId: payment.id,
      signedTransaction: input.signedTransaction,
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).submitted, true);
    const retried = await route('payment/retry', { paymentId: payment.id });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).replayed, true);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

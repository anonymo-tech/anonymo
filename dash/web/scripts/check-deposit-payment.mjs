import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  depositPaymentFixture,
  tokenAccountFixture,
} from './fixtures/deposit-payment.mjs';
import {
  prepareOwnedPayment,
  getOwnedPayment,
} from '../server/solana/deposit-payment.ts';
import {
  buildDepositTransaction,
  decodeTransactionBase64,
  encodeTransactionBase64,
} from '../lib/solana/deposit-transaction.ts';
import { TOKEN_2022_PROGRAM } from '../server/solana/validation.ts';

const pool = createDatabase(
  testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href,
  8,
);
before(() => migrate(pool));
after(() => pool.end());
const code = (value) => (error) => error.code === value;
const prepare = (f) =>
  prepareOwnedPayment(pool, f.accountId, f.intentId, { rpc: f.rpc });
const count = async (f) =>
  (
    await pool.query(
      'SELECT count(*)::int AS count FROM deposit_payments WHERE intent_id=$1',
      [f.intentId],
    )
  ).rows[0].count;

void test('preparation verifies chain balances and simulation then persists one exact unsigned transfer', async () => {
  const f = await depositPaymentFixture(pool),
    result = await prepare(f),
    payment = result.payment;
  assert.equal(result.replayed, false);
  assert.equal(payment.state, 'prepared');
  assert.equal(payment.canSign, true);
  assert.equal(payment.sourceTokenAccount, f.sourceAccounts[0]);
  assert.equal(payment.feeLamports, '5000');
  assert.ok(
    Date.parse(payment.expiresAt) - Date.parse(payment.preparedAt) <= 90000,
  );
  const expected = buildDepositTransaction({
    sourceWallet: f.sourceWallet,
    sourceTokenAccount: f.sourceAccounts[0],
    recipientTokenAccount: f.recipientTokenAccount,
    mint: f.mint,
    reference: f.reference,
    amountUsd6: f.amountUsd6,
    recentBlockhash: f.blockhash,
  });
  assert.equal(
    payment.unsignedTransaction,
    encodeTransactionBase64(expected.unsignedTransaction),
  );
  assert.equal(
    payment.messageBase64,
    encodeTransactionBase64(expected.message),
  );
  assert.equal(await count(f), 1);
  assert.ok(!f.calls.some((call) => call.method === 'sendTransaction'));
  const simulation = f.calls.find(
    (call) => call.method === 'simulateTransaction',
  );
  assert.equal(simulation.params[0], payment.unsignedTransaction);
  assert.equal(simulation.params[1].sigVerify, false);
  assert.equal(simulation.params[1].replaceRecentBlockhash, false);
});
void test('owned prepare replay rechecks original validity and never regenerates bytes', async () => {
  const f = await depositPaymentFixture(pool),
    first = await prepare(f);
  f.calls.length = 0;
  const second = await prepare(f);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.payment, first.payment);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['getGenesisHash', 'isBlockhashValid', 'getBlockHeight'],
  );
});
void test('concurrent preparations converge on the one unique immutable attempt', async () => {
  const f = await depositPaymentFixture(pool),
    results = await Promise.all([prepare(f), prepare(f)]);
  assert.equal(await count(f), 1);
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(results[0].payment.id, results[1].payment.id);
  assert.equal(
    results[0].payment.unsignedTransaction,
    results[1].payment.unsignedTransaction,
  );
});
void test('independent payment gate prevents preparation and disables read actions', async () => {
  const f = await depositPaymentFixture(pool);
  process.env.CONCLAVE_DEPOSIT_PAYMENTS_ENABLED = 'false';
  await assert.rejects(prepare(f), code('DEPOSIT_PAYMENT_UNAVAILABLE'));
  assert.equal(f.calls.length, 0);
  f.installConfig();
  await prepare(f);
  process.env.CONCLAVE_DEPOSIT_PAYMENTS_ENABLED = 'false';
  const view = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(view.canSign, false);
  assert.equal(view.canSubmit, false);
});
void test('ownership identity and disabled accounts are checked before external reads', async () => {
  const f = await depositPaymentFixture(pool),
    other = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [other]);
  await assert.rejects(
    prepareOwnedPayment(pool, other, f.intentId, { rpc: f.rpc }),
    code('DEPOSIT_NOT_FOUND'),
  );
  await pool.query('DELETE FROM identities WHERE account_id=$1', [f.accountId]);
  await assert.rejects(prepare(f), code('WALLET_NOT_VERIFIED'));
  assert.equal(f.calls.length, 0);
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    f.accountId,
  ]);
  await assert.rejects(
    getOwnedPayment(pool, f.accountId, f.intentId),
    code('ACCOUNT_UNAVAILABLE'),
  );
});
void test('wrong genesis and stale context never produce a payment attempt', async () => {
  const f = await depositPaymentFixture(pool);
  f.genesisHash = 'wrong';
  await assert.rejects(prepare(f), code('wrong_cluster'));
  assert.equal(await count(f), 0);
  const g = await depositPaymentFixture(pool);
  g.handlers.getTokenAccountsByOwner = () => ({
    context: { slot: g.slot - 1 },
    value: [],
  });
  await assert.rejects(prepare(g), code('invalid_response'));
  assert.equal(await count(g), 0);
});
void test('invalid or insufficient existing source accounts are rejected without account creation', async () => {
  for (const change of [
    { state: 2 },
    { delegate: '11111111111111111111111111111111' },
    {},
  ]) {
    const f = await depositPaymentFixture(pool);
    f.handlers.getTokenAccountsByOwner = () => ({
      context: { slot: f.slot },
      value: [
        {
          pubkey: f.sourceAccounts[0],
          account: tokenAccountFixture(
            f.mint,
            f.sourceWallet,
            Object.keys(change).length ? 5_000_000n : 1n,
            change,
          ),
        },
      ],
    });
    await assert.rejects(prepare(f), code('DEPOSIT_SOURCE_UNAVAILABLE'));
    assert.equal(await count(f), 0);
  }
});
void test('mint program precision and treasury ownership or freeze mismatches fail closed', async () => {
  for (const mutate of [
    (values) => {
      values[0].owner = TOKEN_2022_PROGRAM;
    },
    (values) => {
      const data = decodeTransactionBase64(values[0].data[0]);
      data[44] = 9;
      values[0].data[0] = encodeTransactionBase64(data);
    },
    (values, f) => {
      values[2] = tokenAccountFixture(f.mint, f.sourceWallet, 0n);
    },
    (values, f) => {
      values[2] = tokenAccountFixture(f.mint, f.recipientWallet, 0n, {
        state: 2,
      });
    },
  ]) {
    const f = await depositPaymentFixture(pool);
    f.handlers.getMultipleAccounts = (params) => {
      const response = f.reply('getMultipleAccounts', params);
      mutate(response.value, f);
      return response;
    };
    await assert.rejects(prepare(f), (error) =>
      ['invalid_response', 'deposit_mismatch'].includes(error.code),
    );
    assert.equal(await count(f), 0);
  }
});
void test('native network fee insufficiency and failed simulation never create a signing attempt', async () => {
  const f = await depositPaymentFixture(pool);
  f.balanceLamports = 1;
  await assert.rejects(prepare(f), code('DEPOSIT_FEE_BALANCE_REQUIRED'));
  assert.equal(await count(f), 0);
  const g = await depositPaymentFixture(pool);
  g.handlers.simulateTransaction = () => ({
    context: { slot: g.slot },
    value: { err: { InstructionError: [0, 'synthetic'] } },
  });
  await assert.rejects(prepare(g), code('DEPOSIT_SIMULATION_FAILED'));
  assert.equal(await count(g), 0);
});
void test('simulation cannot replace the blockhash or hide additional inner instructions', async () => {
  for (const mutation of [
    (value) => {
      value.replacementBlockhash = { blockhash: 'unexpected' };
    },
    (value) => {
      value.innerInstructions = [{ index: 0, instructions: [{}] }];
    },
  ]) {
    const f = await depositPaymentFixture(pool);
    f.handlers.simulateTransaction = (params) => {
      const result = f.reply('simulateTransaction', params);
      mutation(result.value);
      return result;
    };
    await assert.rejects(prepare(f), (error) =>
      ['invalid_response', 'unsupported_instruction'].includes(error.code),
    );
    assert.equal(await count(f), 0);
  }
});
void test('expired original blockhash and review time require recovery instead of replacement', async () => {
  const f = await depositPaymentFixture(pool),
    first = await prepare(f);
  f.calls.length = 0;
  f.blockhashValid = false;
  await assert.rejects(prepare(f), code('DEPOSIT_PAYMENT_RECOVERY_REQUIRED'));
  assert.equal(await count(f), 1);
  assert.ok(!f.calls.some((call) => call.method === 'getLatestBlockhash'));
  const originalNow = Date.now;
  Date.now = () => Date.parse(first.payment.expiresAt) + 1;
  try {
    await assert.rejects(prepare(f), code('DEPOSIT_PAYMENT_RECOVERY_REQUIRED'));
    assert.equal(
      (await getOwnedPayment(pool, f.accountId, f.intentId)).canSign,
      false,
    );
  } finally {
    Date.now = originalNow;
  }
});
void test('final write rechecks an account disabled during simulation', async () => {
  const f = await depositPaymentFixture(pool);
  f.handlers.simulateTransaction = async (params) => {
    await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
      f.accountId,
    ]);
    return f.reply('simulateTransaction', params);
  };
  await assert.rejects(prepare(f), code('ACCOUNT_UNAVAILABLE'));
  assert.equal(await count(f), 0);
});
void test('aborted preparation never persists bytes even after successful reads', async () => {
  const f = await depositPaymentFixture(pool),
    controller = new AbortController();
  f.handlers.simulateTransaction = (params) => {
    controller.abort();
    return f.reply('simulateTransaction', params);
  };
  await assert.rejects(
    prepareOwnedPayment(pool, f.accountId, f.intentId, {
      rpc: f.rpc,
      signal: controller.signal,
    }),
  );
  assert.equal(await count(f), 0);
});
void test('database rejects changed prepared bytes deletion and changed signed submission evidence', async () => {
  const f = await depositPaymentFixture(pool),
    { payment } = await prepare(f);
  await assert.rejects(
    pool.query('UPDATE deposit_payments SET recent_blockhash=$2 WHERE id=$1', [
      payment.id,
      f.sourceAccounts[0],
    ]),
    code('23514'),
  );
  await assert.rejects(
    pool.query('DELETE FROM deposit_payments WHERE id=$1', [payment.id]),
    code('23514'),
  );
  const signed = f.signPayment(payment),
    signature = (await import('bs58')).default.encode(
      decodeTransactionBase64(signed).subarray(1, 65),
    );
  await pool.query(
    "UPDATE deposit_payments SET state='submitted',signed_transaction=$2,signature=$3,submitted_at=clock_timestamp() WHERE id=$1",
    [payment.id, signed, signature],
  );
  assert.equal(
    (await getOwnedPayment(pool, f.accountId, f.intentId)).canSubmit,
    true,
  );
  await assert.rejects(
    pool.query('UPDATE deposit_payments SET signature=$2 WHERE id=$1', [
      payment.id,
      '1'.repeat(64),
    ]),
    code('23514'),
  );
  await assert.rejects(
    pool.query("UPDATE deposit_payments SET state='prepared' WHERE id=$1", [
      payment.id,
    ]),
    code('23514'),
  );
});

void test('unlinking disables payment signing flags but preserves the owned prepared record', async () => {
  const f = await depositPaymentFixture(pool),
    { payment } = await prepare(f);
  await pool.query(
    'UPDATE identities SET revoked_at=clock_timestamp() WHERE account_id=$1',
    [f.accountId],
  );
  const saved = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(saved.canSign, false);
  assert.equal(saved.canSubmit, false);
  assert.equal(saved.id, payment.id);
  assert.equal(saved.unsignedTransaction, payment.unsignedTransaction);
  assert.equal(await count(f), 1);
});

void test('unlinking during preparation replay refuses signing after the final locked check', async () => {
  const f = await depositPaymentFixture(pool),
    { payment } = await prepare(f);
  f.calls.length = 0;
  f.handlers.getBlockHeight = async () => {
    await pool.query(
      'UPDATE identities SET revoked_at=clock_timestamp() WHERE account_id=$1',
      [f.accountId],
    );
    return f.height;
  };
  await assert.rejects(prepare(f), code('WALLET_NOT_VERIFIED'));
  const saved = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(saved.id, payment.id);
  assert.equal(saved.canSign, false);
  assert.equal(await count(f), 1);
  assert.ok(
    !f.calls.some(
      (call) =>
        call.method === 'getLatestBlockhash' ||
        call.method === 'sendTransaction',
    ),
  );
});

void test('unlinked submitted payments remain readable for recovery without enabling another send', async () => {
  const f = await depositPaymentFixture(pool),
    { payment } = await prepare(f),
    signed = f.signPayment(payment);
  const signature = (await import('bs58')).default.encode(
    decodeTransactionBase64(signed).subarray(1, 65),
  );
  await pool.query(
    "UPDATE deposit_payments SET state='submitted',signed_transaction=$2,signature=$3,submitted_at=clock_timestamp() WHERE id=$1",
    [payment.id, signed, signature],
  );
  await pool.query(
    'UPDATE identities SET revoked_at=clock_timestamp() WHERE account_id=$1',
    [f.accountId],
  );
  const saved = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(saved.state, 'submitted');
  assert.equal(saved.signature, signature);
  assert.equal(saved.canSubmit, false);
  assert.equal(saved.canSign, false);
});

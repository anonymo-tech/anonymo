import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createDatabase } from '../server/db/database.ts';
import { testEndpoint } from './check-database.mjs';
import { depositPaymentFixture } from './fixtures/deposit-payment.mjs';
import {
  prepareOwnedPayment,
  getOwnedPayment,
  paymentTerms,
} from '../server/solana/deposit-payment.ts';
import { submitOwnedPayment } from '../server/solana/deposit-submit.ts';
import {
  buildDepositTransaction,
  encodeTransactionBase64,
} from '../lib/solana/deposit-transaction.ts';
const endpoint = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL);
const pool = createDatabase(endpoint.href, 4);
let legacy;
const code = (code) => (error) => error.code === code;
const prepare = (f) =>
  prepareOwnedPayment(pool, f.accountId, f.intentId, { rpc: f.rpc });
function terms(f, createRecipientAccount = false) {
  return {
    sourceWallet: f.sourceWallet,
    sourceTokenAccount: f.sourceAccounts[0],
    recipientTokenAccount: f.recipientTokenAccount,
    recipientWallet: f.recipientWallet,
    mint: f.mint,
    reference: f.reference,
    amountUsd6: f.amountUsd6,
    recentBlockhash: f.blockhash,
    createRecipientAccount,
  };
}
async function insert(f, built, rent, includeColumn = true) {
  const paymentId = randomUUID();
  await pool.query(
    `INSERT INTO deposit_payments(id,intent_id,account_id,source_token_account,message_base64,unsigned_transaction,recent_blockhash,last_valid_block_height,context_slot,fee_lamports,prepared_at,expires_at${includeColumn ? ',account_creation_lamports' : ''})
 VALUES($1,$2,$3,$4,$5,$6,$7,1200,2000,5000,clock_timestamp(),clock_timestamp()+interval '80 seconds'${includeColumn ? ',$8' : ''})`,
    [
      paymentId,
      f.intentId,
      f.accountId,
      f.sourceAccounts[0],
      encodeTransactionBase64(built.message),
      encodeTransactionBase64(built.unsignedTransaction),
      f.blockhash,
      ...(includeColumn ? [rent] : []),
    ],
  );
  return paymentId;
}
before(async () => {
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'",
      )
    ).rows[0].n,
    0,
    'Use a new isolated empty test database',
  );
  const dir = new URL('../server/db/migrations/', import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => /^\d{3}-.*\.sql$/.test(n) && n < '039')
    .sort())
    await pool.query(await readFile(new URL(name, dir), 'utf8'));
  legacy = await depositPaymentFixture(pool);
  legacy.built = buildDepositTransaction(terms(legacy));
  legacy.paymentId = await insert(legacy, legacy.built, 0, false);
  await pool.query(
    await readFile(new URL('039-deposit-recipient-account.sql', dir), 'utf8'),
  );
});
after(() => pool.end());
void test('039 preserves an existing legacy attempt and its exact signed-message contract', async () => {
  const view = await getOwnedPayment(pool, legacy.accountId, legacy.intentId);
  assert.equal(view.id, legacy.paymentId);
  assert.equal(view.accountCreationLamports, '0');
  assert.equal(view.createRecipientAccount, false);
  assert.equal(
    view.unsignedTransaction,
    encodeTransactionBase64(legacy.built.unsignedTransaction),
  );
  const result = await prepare(legacy);
  assert.equal(result.replayed, true);
  assert.deepEqual(result.payment, view);
});
void test('missing canonical ATA prepares an exact creation+transfer and persists disclosed live rent', async () => {
  const f = await depositPaymentFixture(pool, { createRecipientAccount: true });
  f.handlers.simulateTransaction = () => ({
    context: { slot: f.slot },
    value: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 5 }] }],
      unitsConsumed: 25000,
    },
  });
  const { payment } = await prepare(f);
  const expected = buildDepositTransaction(terms(f, true));
  assert.equal(payment.createRecipientAccount, true);
  assert.equal(payment.recipientWallet, f.recipientWallet);
  assert.equal(payment.accountCreationLamports, '2039280');
  assert.equal(payment.feeLamports, '5000');
  assert.equal(
    payment.unsignedTransaction,
    encodeTransactionBase64(expected.unsignedTransaction),
  );
  assert.equal(expected.message.length, 353);
  assert.equal(expected.unsignedTransaction.length, 418);
  assert.ok(!f.calls.some((c) => c.method === 'sendTransaction'));
  const reread = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.deepEqual(reread, payment);
  const again = await prepare(f);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.payment, payment);
});
void test('missing non-derived recipient, source or mint never prepares a payment', async () => {
  for (const missing of [0, 1, 2, 3]) {
    const f = await depositPaymentFixture(pool);
    const orig = f.reply;
    f.handlers.getMultipleAccounts = () => {
      const r = orig('getMultipleAccounts');
      r.value[missing] = null;
      return r;
    };
    await assert.rejects(prepare(f));
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM deposit_payments WHERE intent_id=$1',
          [f.intentId],
        )
      ).rows[0].n,
      0,
    );
  }
});
void test('source must cover both network fee and account rent, and invalid rent fails closed', async () => {
  const f = await depositPaymentFixture(pool, { createRecipientAccount: true });
  f.balanceLamports = 2039280;
  await assert.rejects(prepare(f), code('DEPOSIT_FEE_BALANCE_REQUIRED'));
  for (const rent of [0, -1, 10000001, '2039280']) {
    const g = await depositPaymentFixture(pool, {
      createRecipientAccount: true,
    });
    g.handlers.getMinimumBalanceForRentExemption = () => rent;
    await assert.rejects(prepare(g));
  }
});
void test('account creation does not permit transfer CPI or arbitrary extra simulated outer work', async () => {
  const f = await depositPaymentFixture(pool, { createRecipientAccount: true });
  f.handlers.simulateTransaction = () => ({
    context: { slot: f.slot },
    value: {
      err: null,
      innerInstructions: [{ index: 1, instructions: [{ programIdIndex: 5 }] }],
    },
  });
  await assert.rejects(prepare(f), code('unsupported_instruction'));
});
void test('rent changes block saved signing and submission without altering retained bytes or sending', async () => {
  const f = await depositPaymentFixture(pool, { createRecipientAccount: true });
  const { payment } = await prepare(f);
  f.handlers.getMinimumBalanceForRentExemption = () => 2039281;
  await assert.rejects(prepare(f), code('DEPOSIT_RENT_CHANGED'));
  await assert.rejects(
    submitOwnedPayment(
      pool,
      {
        accountId: f.accountId,
        intentId: f.intentId,
        paymentId: payment.id,
        signedTransaction: f.signPayment(payment),
      },
      { rpc: f.rpc },
    ),
  );
  assert.ok(!f.calls.some((c) => c.method === 'sendTransaction'));
  const reread = await getOwnedPayment(pool, f.accountId, f.intentId);
  assert.equal(reread.unsignedTransaction, payment.unsignedTransaction);
});
void test('explicit signed creation attempt validates and relays its exact immutable bytes', async () => {
  const f = await depositPaymentFixture(pool, { createRecipientAccount: true });
  const { payment } = await prepare(f);
  const signed = f.signPayment(payment);
  await submitOwnedPayment(
    pool,
    {
      accountId: f.accountId,
      intentId: f.intentId,
      paymentId: payment.id,
      signedTransaction: signed,
    },
    { rpc: f.rpc },
  );
  const sends = f.calls.filter((c) => c.method === 'sendTransaction');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params[0], signed);
  const row = (
    await pool.query('SELECT * FROM deposit_payments WHERE id=$1', [payment.id])
  ).rows[0];
  assert.equal(paymentTerms(f.intent, row).createRecipientAccount, true);
  assert.equal(row.signed_transaction, signed);
  assert.equal(row.account_creation_lamports, '2039280');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM deposit_events WHERE intent_id=$1',
        [f.intentId],
      )
    ).rows[0].n,
    0,
  );
});
void test('039 rejects mismatched lengths/rent and preserves immutable rent quote', async () => {
  for (const create of [false, true]) {
    const f = await depositPaymentFixture(pool, {
      createRecipientAccount: true,
    });
    await assert.rejects(
      insert(
        f,
        buildDepositTransaction(terms(f, create)),
        create ? 0 : 2039280,
      ),
      code('23514'),
    );
  }
  const f = await depositPaymentFixture(pool, { createRecipientAccount: true });
  const built = buildDepositTransaction(terms(f, true));
  built.message = new Uint8Array(354);
  built.unsignedTransaction = new Uint8Array(419);
  built.unsignedTransaction[0] = 1;
  await assert.rejects(insert(f, built, 2039280), code('23514'));
  const good = await depositPaymentFixture(pool, {
    createRecipientAccount: true,
  });
  const { payment } = await prepare(good);
  await assert.rejects(
    pool.query(
      'UPDATE deposit_payments SET account_creation_lamports=account_creation_lamports+1 WHERE id=$1',
      [payment.id],
    ),
    code('23514'),
  );
});

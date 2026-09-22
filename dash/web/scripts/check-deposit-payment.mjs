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

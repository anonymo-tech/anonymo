import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { creditVerifiedDeposit, getBalance, markHoldRunning, markReconciliationPending, reserveQuote, settleHold } from '../server/ledger/ledger.ts';
import { decimalUsd6, usd6 } from '../server/ledger/money.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection) throw new Error('Set CONCLAVE_TEST_DATABASE_URL to an isolated PostgreSQL test database.');
const parsed = new URL(connection);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
  throw new Error('Ledger tests require a loopback database whose name ends in _test.');
}
const pool = createDatabase(connection, 12);
before(async () => { await migrate(pool); await migrate(pool); });
after(async () => { await pool.end(); });

async function fixture(balance = '1000000', max = '600000') {
  const accountId = randomUUID(), projectId = randomUUID(), routeId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query('INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)', [projectId, accountId, 'Ledger test']);
  await pool.query(`INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,'fixture','fixture','chat',true,'{}','{}',now()+interval '1 hour')`, [routeId, `fixture-${routeId}`]);
  await creditVerifiedDeposit(pool, { accountId, reference: `fixture_${randomUUID()}`, amountUsd6: balance });
  const newQuote = async (maximum = max) => {
    const quoteId = randomUUID();
    await pool.query(`INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
      VALUES($1,$2,$3,$4,'hash',$5,1000,now()+interval '5 minutes')`, [quoteId, accountId, projectId, routeId, maximum]);
    return { accountId, quoteId, idempotencyKey: randomUUID(), requestHash: 'hash' };
  };
  return { accountId, projectId, routeId, newQuote };
}

void test('integer money rejects floating, negative, malformed and excessive values', () => {
  assert.equal(decimalUsd6('1.000001'), 1000001n);
  assert.equal(usd6('9000000000000000'), 9000000000000000n);
  for (const value of [1, 0.1, '-1', '+1', '01', '1e6', '9000000000000001']) assert.throws(() => usd6(value));
  for (const value of ['0.0000001', 'NaN', '-0.2', '1e2']) assert.throws(() => decimalUsd6(value));
});

void test('simultaneous reservations cannot overspend and the journal balances', async () => {
  const f = await fixture();
  const inputs = await Promise.all(Array.from({ length: 8 }, () => f.newQuote()));
  const results = await Promise.allSettled(inputs.map((input) => reserveQuote(pool, input)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'INSUFFICIENT_BALANCE'));
  assert.deepEqual(await getBalance(pool, f.accountId), { availableUsd6: '400000', reservedUsd6: '600000', currency: 'USD6' });
  const bad = await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_usd6)<>0');
  assert.equal(bad.rowCount, 0);
});

void test('same idempotency key concurrently reserves and settles exactly once', async () => {
  const f = await fixture();
  const input = await f.newQuote();
  const results = await Promise.all(Array.from({ length: 6 }, () => reserveQuote(pool, input)));
  assert.equal(new Set(results.map((result) => result.hold.id)).size, 1);
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  const holdId = results[0].hold.id;
  await markHoldRunning(pool, f.accountId, holdId);
  await assert.rejects(markHoldRunning(pool, f.accountId, holdId), { code: 'HOLD_NOT_DISPATCHABLE' });
  const settled = await Promise.all(Array.from({ length: 6 }, () => settleHold(pool, {
    accountId: f.accountId, holdId, actualUsd6: '123456', providerReference: 'fixture-provider',
  })));
  assert.equal(settled.filter((result) => !result.replayed).length, 1);
  assert.deepEqual(await getBalance(pool, f.accountId), { availableUsd6: '876544', reservedUsd6: '0', currency: 'USD6' });
  await assert.rejects(settleHold(pool, { accountId: f.accountId, holdId, actualUsd6: '123457', providerReference: null }), { code: 'SETTLEMENT_CONFLICT' });
});

void test('replayed deposits credit once and cannot move ownership or change amount', async () => {
  const f = await fixture();
  const input = { accountId: f.accountId, reference: `deposit_${randomUUID()}`, amountUsd6: '750000' };
  const results = await Promise.all(Array.from({ length: 5 }, () => creditVerifiedDeposit(pool, input)));
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1750000');
  await assert.rejects(creditVerifiedDeposit(pool, { ...input, amountUsd6: '1' }), { code: 'REFERENCE_CONFLICT' });
  const other = await fixture();
  await assert.rejects(creditVerifiedDeposit(pool, { ...input, accountId: other.accountId }), { code: 'REFERENCE_CONFLICT' });
});

void test('expired, disabled, foreign and altered quotes never create holds', async () => {
  const f = await fixture();
  const expired = await f.newQuote();
  await pool.query("UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.quoteId]);
  await assert.rejects(reserveQuote(pool, expired), { code: 'QUOTE_EXPIRED' });
  const input = await f.newQuote();
  await assert.rejects(reserveQuote(pool, { ...input, requestHash: 'changed' }), { code: 'QUOTE_MISMATCH' });
  const other = await fixture();
  await assert.rejects(reserveQuote(pool, { ...input, accountId: other.accountId }), { code: 'QUOTE_NOT_FOUND' });
  await pool.query('UPDATE route_versions SET enabled=false WHERE id=$1', [f.routeId]);
  await assert.rejects(reserveQuote(pool, input), { code: 'QUOTE_EXPIRED' });
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '0');
});

void test('ambiguous billing keeps funds reserved until a conclusive settlement', async () => {
  const f = await fixture();
  const { hold } = await reserveQuote(pool, await f.newQuote());
  await markHoldRunning(pool, f.accountId, hold.id);
  await markReconciliationPending(pool, f.accountId, hold.id);
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '600000');
  await assert.rejects(settleHold(pool, { accountId: f.accountId, holdId: hold.id, actualUsd6: '600001', providerReference: null }), { code: 'COST_EXCEEDS_RESERVATION' });
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '600000');
  await settleHold(pool, { accountId: f.accountId, holdId: hold.id, actualUsd6: '0', providerReference: null });
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});

void test('a quote cannot be charged under a second idempotency key', async () => {
  const f = await fixture();
  const input = await f.newQuote('100000');
  await reserveQuote(pool, input);
  await assert.rejects(reserveQuote(pool, { ...input, idempotencyKey: randomUUID() }), { code: 'QUOTE_ALREADY_USED' });
  const other = await f.newQuote('100000');
  await assert.rejects(reserveQuote(pool, { ...other, idempotencyKey: input.idempotencyKey }), { code: 'IDEMPOTENCY_CONFLICT' });
});

void test('database rejects unbalanced, empty, edited and late-appended journal transactions', async () => {
  const f = await fixture();
  const account = (await pool.query("SELECT id FROM ledger_accounts WHERE owner_id=$1 AND kind='available'", [f.accountId])).rows[0];
  await assert.rejects(transaction(pool, async (client) => {
    const id = randomUUID();
    await client.query("INSERT INTO ledger_transactions(id,reference,kind) VALUES($1,$2,'deposit')", [id, `invalid_${id}`]);
    await client.query('INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,1)', [id, account.id]);
  }), { code: '23514' });
  await assert.rejects(pool.query("INSERT INTO ledger_transactions(id,reference,kind) VALUES($1,$2,'deposit')", [randomUUID(), `empty_${randomUUID()}`]), { code: '23514' });
  const entry = (await pool.query('SELECT id,transaction_id FROM ledger_entries LIMIT 1')).rows[0];
  await assert.rejects(pool.query('UPDATE ledger_entries SET amount_usd6=2 WHERE id=$1', [entry.id]), { code: '23514' });
  await assert.rejects(pool.query('DELETE FROM ledger_entries WHERE id=$1', [entry.id]), { code: '23514' });
  await assert.rejects(pool.query('INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,1)', [entry.transaction_id, account.id]), { code: '23514' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { transaction } from '../server/db/database.ts';
import { ledgerAccount,getBalance } from '../server/ledger/ledger.ts';
import { grantWalletWelcomeCreditInTransaction as grant,welcomeCreditGrantedUsd6 } from '../server/ledger/welcome-credit.ts';
import { welcomeTestDatabase,newWalletAccount,activate } from './fixtures/welcome-credit-db.mjs';

const campaignId='wallet-welcome-2026-10-14';
const constraint=error=>error?.code==='23514';
const denied=error=>error?.code==='42501';
const rollback=Symbol('rollback');
async function rolledBack(pool,work) { try { await transaction(pool,async c=>{await work(c);throw rollback;}); } catch(e) {if(e!==rollback)throw e;} }
async function direct(client,input,{amount='5000000',omitGrant=false,wrongOwner=false,wrongFunding=false,wrongReference=false}={}) {
  const available=await ledgerAccount(client,wrongOwner?(await newWalletAccount(client)).accountId:input.accountId,'available');
  const funding=(await client.query("SELECT id FROM ledger_accounts WHERE owner_id IS NULL AND kind=$1",[wrongFunding?'clearing':'promotional_funding'])).rows[0]??await ledgerAccount(client,null,'clearing');
  const id=crypto.randomUUID();
  await client.query('INSERT INTO ledger_transactions(id,reference,kind) VALUES($1,$2,$3)',[id,wrongReference?`wrong:${id}`:`wallet-welcome:${campaignId}:${input.accountId}`,'promotional_credit']);
  if(!omitGrant)await client.query('INSERT INTO wallet_welcome_grants(account_id,identity_id,wallet_address,campaign_id,amount_usd6,ledger_transaction_id) VALUES($1,$2,$3,$4,$5,$6)',[input.accountId,input.identityId,input.walletAddress,campaignId,'5000000',id]);
  await client.query('SELECT id FROM ledger_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[available.id,funding.id].sort()]);
  await client.query('INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,$3),($1,$4,$5)',[id,available.id,amount,funding.id,(-BigInt(amount)).toString()]);
  return id;
}

test('wallet welcome campaign database invariants',async t=>{
  const db=await welcomeTestDatabase();
  const {pool}=db;
  try {
    let old,first;
    await t.test('migration creates no campaign or grant; missing campaign is a no-op',async()=>{
      assert.equal((await pool.query('SELECT count(*)::int n FROM wallet_welcome_campaigns')).rows[0].n,0);
      old=await transaction(pool,async c=>{const input=await newWalletAccount(c);assert.equal(await grant(c,input),null);return input;});
      assert.equal(await welcomeCreditGrantedUsd6(pool,old.accountId),'0');
    });
    await t.test('disabled campaign is a no-op and fixed terms cannot widen',async()=>{
      await rolledBack(pool,async c=>{await activate(c,false);assert.equal(await grant(c,await newWalletAccount(c)),null);});
      for(const values of [[6000000,20,120000000],[5000000,21,105000000],[5000000,20,200000000]]) await assert.rejects(pool.query('INSERT INTO wallet_welcome_campaigns(id,amount_usd6,max_grants,budget_usd6,enabled) VALUES($1,$2,$3,$4,true)',[campaignId,...values]),constraint);
    });
    await activate(pool);
    await t.test('old account, new linked wallet, passkey, revoked and disabled identities are ineligible',async()=>{
      assert.equal(await transaction(pool,c=>grant(c,old)),null);
      await transaction(pool,async c=>assert.equal(await grant(c,await newWalletAccount(c,{accountId:old.accountId})),null));
      await transaction(pool,async c=>assert.equal(await grant(c,await newWalletAccount(c,{kind:'passkey'})),null));
      for(const column of ['revoked_at','disabled_at'])await transaction(pool,async c=>{const input=await newWalletAccount(c);await c.query(`UPDATE ${column==='revoked_at'?'identities':'accounts'} SET ${column}=now() WHERE id=$1`,[column==='revoked_at'?input.identityId:input.accountId]);assert.equal(await grant(c,input),null);});
      await assert.rejects(transaction(pool,c=>direct(c,old)),constraint);
    });
    await t.test('new account grant fully rolls back if signup fails',async()=>{
      await rolledBack(pool,async c=>{const result=await grant(c,await newWalletAccount(c));assert.equal(result.amountUsd6,'5000000');});
      assert.equal((await pool.query('SELECT count(*)::int n FROM wallet_welcome_grants')).rows[0].n,0);
      assert.equal((await pool.query("SELECT balance_usd6 FROM ledger_accounts WHERE kind='promotional_funding'")).rows[0].balance_usd6,'0');
    });
    await t.test('actual API role can create $5 with RLS and narrow grants, and replay is idempotent',async()=>{
      first=await db.api(async c=>{const input=await newWalletAccount(c);return {...input,result:await grant(c,input)};});
      assert.equal(first.result.amountUsd6,'5000000');assert.equal(first.result.replayed,false);
      assert.deepEqual(await db.api(c=>grant(c,first)),{...first.result,replayed:true});
      assert.equal((await getBalance(pool,first.accountId)).availableUsd6,'5000000');
      assert.equal(await db.api(c=>welcomeCreditGrantedUsd6(c,first.accountId)),'5000000');
    });
    await t.test('API cannot activate, alter amount, delete claims or access trigger functions directly',async()=>{
      for(const sql of ['UPDATE wallet_welcome_campaigns SET enabled=false','UPDATE wallet_welcome_campaigns SET amount_usd6=6000000','DELETE FROM wallet_welcome_grants','INSERT INTO wallet_welcome_campaigns(id,amount_usd6,max_grants,budget_usd6) VALUES(\'x\',1,1,1)','SELECT guard_wallet_welcome_grant()'])await assert.rejects(db.api(c=>c.query(sql)),denied);
    });
    await t.test('direct SQL cannot omit grant or change owner, amount, reference or funding source',async()=>{
      for(const options of [{omitGrant:true},{wrongOwner:true},{amount:'4999999'},{wrongReference:true},{wrongFunding:true}])await assert.rejects(transaction(pool,async c=>direct(c,await newWalletAccount(c),options)),constraint);
      assert.equal((await pool.query('SELECT count(*)::int n FROM wallet_welcome_grants')).rows[0].n,1);
    });
    await t.test('24 concurrent helper/direct SQL signups reach exactly20/$100; excess helper signup succeeds without grant',async()=>{
      const results=await Promise.allSettled(Array.from({length:24},(_,index)=>transaction(pool,async c=>{const input=await newWalletAccount(c);return index%2===0?grant(c,input):direct(c,input);})));
      for(const item of results)if(item.status==='rejected')assert.match(item.reason.message,/Welcome campaign limit reached/);
      const total=(await pool.query('SELECT count(*)::int n,sum(amount_usd6)::text total FROM wallet_welcome_grants')).rows[0];
      assert.deepEqual(total,{n:20,total:'100000000'});
      const extra=await db.api(async c=>{const input=await newWalletAccount(c);assert.equal(await grant(c,input),null);return input;});
      assert.equal((await pool.query('SELECT id FROM accounts WHERE id=$1',[extra.accountId])).rowCount,1);
      assert.equal(await welcomeCreditGrantedUsd6(pool,extra.accountId),'0');
      await assert.rejects(transaction(pool,async c=>direct(c,await newWalletAccount(c))),constraint);
    });
    await t.test('every award is exact and balanced; no deposit or internal test credit is fabricated',async()=>{
      const rows=await pool.query(`SELECT t.kind,count(e.id)::int entries,sum(e.amount_usd6)::text total FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id GROUP BY t.id`);
      assert.equal(rows.rowCount,20);for(const row of rows.rows)assert.deepEqual(row,{kind:'promotional_credit',entries:2,total:'0'});
      assert.equal((await pool.query("SELECT balance_usd6 FROM ledger_accounts WHERE kind='promotional_funding'")).rows[0].balance_usd6,'-100000000');
      assert.equal((await pool.query('SELECT sum(balance_usd6)::text total FROM ledger_accounts')).rows[0].total,'0');
      assert.equal((await pool.query("SELECT count(*)::int n FROM ledger_transactions WHERE kind IN ('deposit','internal_test_credit')")).rows[0].n,0);
    });
    await t.test('immutable campaign/claims cannot reset, and restart insert leaves cap unchanged',async()=>{
      for(const sql of ['DELETE FROM wallet_welcome_campaigns','UPDATE wallet_welcome_campaigns SET starts_at=clock_timestamp()','UPDATE wallet_welcome_campaigns SET max_grants=21','DELETE FROM wallet_welcome_grants','UPDATE wallet_welcome_grants SET created_at=clock_timestamp()'])await assert.rejects(pool.query(sql),constraint);
      await activate(pool);
      assert.equal((await pool.query('SELECT count(*)::int n FROM wallet_welcome_grants')).rows[0].n,20);
      await pool.query('UPDATE wallet_welcome_campaigns SET enabled=false');
      assert.equal(await transaction(pool,async c=>grant(c,await newWalletAccount(c))),null);
      await assert.rejects(pool.query('UPDATE wallet_welcome_campaigns SET enabled=true'),constraint);
    });
    await t.test('existing burn/token kinds and ownership survive migration',async()=>{
      const definitions=(await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid IN ('ledger_accounts'::regclass,'ledger_transactions'::regclass) AND contype='c'")).rows.map(row=>row.definition).join(' ');
      for(const kind of ['burn_reserve','burn_executed','token_float','token_deposit','promotional_funding','promotional_credit'])assert.ok(definitions.includes(kind));
      await pool.query("INSERT INTO ledger_accounts(id,owner_id,kind) VALUES(gen_random_uuid(),NULL,'burn_reserve'),(gen_random_uuid(),NULL,'token_float') ON CONFLICT(owner_id,kind) DO NOTHING");
    });
  } finally {await db.close();}
});

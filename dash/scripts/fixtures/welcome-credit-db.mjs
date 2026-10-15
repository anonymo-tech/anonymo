import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import bs58 from 'bs58';
import { transaction } from '../../server/db/database.ts';

export async function welcomeTestDatabase() {
  const endpoint = new URL(process.env.CONCLAVE_WELCOME_TEST_URL ?? 'postgresql://conclave_test@127.0.0.1:55439/conclave_welcome_test');
  if (!['127.0.0.1','localhost'].includes(endpoint.hostname) || !endpoint.pathname.endsWith('_test') || endpoint.search || endpoint.password) throw new Error('A password-free loopback *_test database is required.');
  const schema = `welcome_${process.pid}_${randomBytes(4).toString('hex')}`;
  const role = `${schema}_api`;
  const admin = new pg.Pool({connectionString:endpoint.href,max:1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({connectionString:endpoint.href,max:28,options:`-c search_path=${schema},pg_catalog -c timezone=UTC -c statement_timeout=15000`});
  const files = (await readdir(new URL('../../server/db/migrations/',import.meta.url))).filter(name => /^(0(?:0[1-9]|1[0-9]|2[0-6])|039|040)-.*\.sql$/.test(name)).sort();
  for (const file of files) await transaction(pool,async client => client.query(await readFile(new URL(`../../server/db/migrations/${file}`,import.meta.url),'utf8')));
  // Reproduce hosted API permissions and service-role policy without ownership or bypassRLS.
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT ON accounts,identities,ledger_accounts,ledger_transactions,ledger_entries,wallet_welcome_campaigns,wallet_welcome_grants TO ${role};
    GRANT INSERT ON accounts,identities,ledger_accounts,ledger_transactions,ledger_entries,wallet_welcome_grants TO ${role};
    GRANT UPDATE(id) ON accounts,wallet_welcome_campaigns TO ${role};
    GRANT UPDATE(balance_usd6) ON ledger_accounts TO ${role};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role};`);
  for (const table of ['accounts','identities','ledger_accounts','ledger_transactions','ledger_entries','wallet_welcome_campaigns','wallet_welcome_grants']) await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; CREATE POLICY api_service ON ${table} TO ${role} USING(true) WITH CHECK(true)`);
  const functions = await pool.query('SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',[schema]);
  for(const item of functions.rows) await pool.query(`ALTER FUNCTION ${item.name} SET search_path=${schema},pg_catalog`);
  return {pool,role,schema,async api(work){ return transaction(pool,async client=>{await client.query(`SET LOCAL ROLE ${role}`);return work(client);}); }, async close(){await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.query(`DROP ROLE ${role}`);await admin.end();}};
}
export async function newWalletAccount(client,options={}) {
  const accountId=options.accountId??crypto.randomUUID(),identityId=crypto.randomUUID(),walletAddress=bs58.encode(randomBytes(32));
  if(!options.accountId) await client.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
  await client.query('INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,$3,$4)',[identityId,accountId,options.kind??'solana',walletAddress]);
  return {accountId,identityId,walletAddress};
}
export const activate = (client,enabled=true) => client.query('INSERT INTO wallet_welcome_campaigns(id,amount_usd6,max_grants,budget_usd6,enabled) VALUES($1,5000000,20,100000000,$2) ON CONFLICT(id) DO NOTHING',['wallet-welcome-2026-10-14',enabled]);

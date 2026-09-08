import { createDatabase } from '../server/db/database.ts';
import { recoverExpiredJobs } from '../server/db/jobs.ts';
import { recoverExpiredMediaJobs } from '../server/media/worker.ts';
import { recoverExpiredMediaIngests } from '../server/media/ingest.ts';

if (!process.env.CONCLAVE_DATABASE_URL)
  throw new Error('CONCLAVE_DATABASE_URL is required.');
const pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 1);
try {
  await recoverExpiredJobs(pool);
  await recoverExpiredMediaJobs(pool);
  await recoverExpiredMediaIngests(pool);
  for (const [table, key] of [
    ['auth_security_grants', 'token_hash'],
    ['auth_security_challenges', 'id'],
    ['passkey_challenges', 'id'],
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE ${key} IN (
      SELECT ${key} FROM ${table} WHERE expires_at<clock_timestamp()-interval '1 hour'
      ORDER BY expires_at LIMIT 1000)`);
  }
  await pool.query(
    "DELETE FROM auth_challenges WHERE expires_at<now()-interval '1 hour'",
  );
  await pool.query(
    "DELETE FROM sessions WHERE expires_at<now()-interval '7 days' OR revoked_at<now()-interval '1 day'",
  );
  await pool.query(
    "DELETE FROM rate_limits WHERE window_start<now()-interval '1 hour'",
  );
  // Reconciliation records arrive with migration 020; a database that has
  // not applied it yet still gets every other check.
  const reconciled = (
    await pool.query(
      "SELECT to_regclass('hold_reconciliations') IS NOT NULL AS ready",
    )
  ).rows[0].ready;
  const invariants = await pool.query(`SELECT
    (SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_usd6)<>0) t) AS imbalanced,
    (SELECT count(*) FROM ledger_accounts a WHERE a.balance_usd6<>COALESCE((SELECT sum(e.amount_usd6) FROM ledger_entries e WHERE e.ledger_account_id=a.id),0)) AS balance_drift,
    (SELECT count(*) FROM holds WHERE state IN ('held','running','reconciliation_pending') AND updated_at<now()-interval '15 minutes') AS stale_holds,
    (SELECT count(*) FROM jobs WHERE state='dead') AS dead_jobs,
    (SELECT count(*) FROM media_jobs WHERE state='reconciliation_pending') AS pending_media_reconciliation,
    (SELECT count(*) FROM media_ingests WHERE state='failed') AS failed_media_imports,
    (SELECT count(*) FROM media_ingests WHERE state IN ('queued','retry','processing') AND updated_at<now()-interval '15 minutes') AS stale_media_imports,
    (SELECT count(*) FROM holds h JOIN calls c ON c.hold_id=h.id WHERE h.state='reconciliation_pending') AS pending_holds,
    (SELECT COALESCE(sum(h.maximum_usd6),0) FROM holds h JOIN calls c ON c.hold_id=h.id WHERE h.state='reconciliation_pending') AS pending_reserved_usd6${
      reconciled
        ? `,
    (SELECT count(*) FROM hold_reconciliations WHERE resolution='capped') AS capped_settlements,
    (SELECT COALESCE(sum(overage_usd6),0) FROM hold_reconciliations WHERE overage_usd6 IS NOT NULL) AS uncaptured_overage_usd6`
        : ''
    }`);
  // Pending chat holds by reason, flattened so each count is reported on its own.
  const pending =
    await pool.query(`SELECT ${reconciled ? 'COALESCE(x.reason_code,c.error_code)' : 'c.error_code'} AS code,count(*) AS holds
    FROM holds h JOIN calls c ON c.hold_id=h.id ${reconciled ? 'LEFT JOIN hold_reconciliations x ON x.hold_id=h.id' : ''}
    WHERE h.state='reconciliation_pending' GROUP BY 1 ORDER BY 1`);
  const byCode = {};
  for (const row of pending.rows) {
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(row.code ?? '')
      ? row.code
      : 'UNRECORDED';
    const key = `pending_holds_${code.toLowerCase()}`;
    byCode[key] = String(Number(byCode[key] ?? 0) + Number(row.holds));
  }
  // Operational output is aggregate only, with no identity, prompt or provider material.
  process.stdout.write(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      ...invariants.rows[0],
      ...byCode,
    }) + '\n',
  );
  if (
    Number(invariants.rows[0].imbalanced) ||
    Number(invariants.rows[0].balance_drift)
  )
    process.exitCode = 2;
} finally {
  await pool.end();
}

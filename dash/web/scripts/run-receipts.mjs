import { createDatabase } from '../server/db/database.ts';
import {
  configuredReceiptSigner,
  configuredReceiptTrust,
  issuePendingReceipts,
  buildCompletedReceiptHours,
} from '../server/receipts/service.ts';

// Explicit operator job, safe to repeat. Does not create keys or contact a chain.
const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args.length === 1 && !['--once', '--batch-only'].includes(args[0]))
) {
  process.stderr.write(
    'Usage: node --experimental-strip-types scripts/run-receipts.mjs [--once|--batch-only]\n',
  );
  process.exitCode = 1;
} else {
  let pool, signer;
  try {
    if (!process.env.CONCLAVE_DATABASE_URL) throw new Error();
    const trust = configuredReceiptTrust();
    signer = args[0] === '--batch-only' ? undefined : configuredReceiptSigner();
    pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 2);
    const issuance = signer
      ? await issuePendingReceipts(pool, signer)
      : { issued: 0, replayed: 0 };
    const batches = await buildCompletedReceiptHours(pool, trust);
    process.stdout.write(
      JSON.stringify({
        ...issuance,
        batches: batches.length,
        publicationState: 'pending_anchor',
        at: new Date().toISOString(),
      }) + '\n',
    );
  } catch (error) {
    const allowed = new Set([
      'RECEIPT_SIGNER_UNAVAILABLE',
      'RECEIPT_INTEGRITY_FAILED',
      'RECEIPT_SIGNER_NOT_TRUSTED',
      'RECEIPT_HOUR_CAPACITY',
    ]);
    process.stderr.write(
      JSON.stringify({
        code: allowed.has(error?.code) ? error.code : 'RECEIPT_JOB_FAILED',
      }) + '\n',
    );
    process.exitCode = 1;
  } finally {
    signer?.seed.fill(0);
    if (pool) await pool.end();
  }
}

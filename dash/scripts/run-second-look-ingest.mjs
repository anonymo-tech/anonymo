import { createDatabase } from '../server/db/database.ts';
import { runWalletIngestOnce } from '../server/second-look/ingest.ts';
import { walletCapability } from '../server/second-look/wallet-config.ts';
// Explicit bounded operator invocation; no scheduling, credentials or provider provisioning.
const args = process.argv.slice(2);
if (args.some((a) => a !== '--once'))
  throw new Error('Only --once is supported.');
if (!walletCapability().configured || !process.env.CONCLAVE_DATABASE_URL)
  throw new Error(
    'Configure read-only wallet ingestion and its database before running.',
  );
const pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 2),
  controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const result = await runWalletIngestOnce(pool, { signal: controller.signal });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.state === 'blocked') process.exitCode = 1;
} finally {
  await pool.end();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}

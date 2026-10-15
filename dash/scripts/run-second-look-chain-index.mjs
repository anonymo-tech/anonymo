import { createDatabase } from '../server/db/database.ts';
import { chainIndexConfig } from '../server/second-look/chain-index.ts';
import { runChainIndexOnce } from '../server/second-look/chain-index-worker.ts';

// Deliberately one bounded invocation. No automatic daemon or migration.
if (process.argv.slice(2).join(' ') !== '--once') throw Error('Use --once.');
const config = chainIndexConfig();
if (!config.enabled) {
  console.log(
    JSON.stringify({ state: 'disabled', blocks: 0, transactions: 0 }),
  );
} else {
  if (!process.env.CONCLAVE_DATABASE_URL)
    throw Error('Worker database configuration required.');
  const pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 1);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    console.log(
      JSON.stringify(
        await runChainIndexOnce(pool, { config, signal: controller.signal }),
      ),
    );
  } catch {
    console.error(
      'Chain index stopped. Coverage remains unverified; no source details logged.',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

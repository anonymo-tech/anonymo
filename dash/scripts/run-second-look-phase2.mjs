import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../server/db/database.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import { runWalletIngestOnce } from '../server/second-look/ingest.ts';
import { walletCapability } from '../server/second-look/wallet-config.ts';
import { runFollowIngestOnce } from '../server/second-look/follow-ingest.ts';
import { runCoolHeadOnce } from '../server/second-look/cool-head-worker.ts';
import { processNextExitWatch } from '../server/second-look/exit-watch.ts';
import { runSecondLookPushOnce } from '../server/second-look/push-worker.ts';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--once', '--loop'].includes(args[0]))
  throw Error('Choose --once or --loop.');
if (!process.env.CONCLAVE_DATABASE_URL)
  throw Error('Configure the worker database before running.');
configuredKeyring();
const pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 4),
  controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
async function step(name, operation) {
  if (controller.signal.aborted) return;
  try {
    const result = await operation();
    // Only bounded operational labels/counts leave the worker. No account IDs, URLs or payloads.
    process.stdout.write(
      JSON.stringify({
        task: name,
        state:
          result.state ??
          result.status ??
          (result.processed ? 'processed' : 'idle'),
        reason: result.reason ?? null,
        inserted: result.inserted ?? result.alerts ?? 0,
      }) + '\n',
    );
  } catch {
    process.stdout.write(
      JSON.stringify({ task: name, state: 'unavailable' }) + '\n',
    );
    process.exitCode = 1;
  }
}
try {
  do {
    if (walletCapability().configured)
      await step('wallet-index', () =>
        runWalletIngestOnce(pool, { signal: controller.signal }),
      );
    await step('follow-index', () =>
      runFollowIngestOnce(pool, { signal: controller.signal }),
    );
    await step('cool-head', () => runCoolHeadOnce(pool));
    await step('exit-watch', () => processNextExitWatch(pool));
    await step('browser-push', () => runSecondLookPushOnce(pool));
    if (args[0] === '--once' || controller.signal.aborted) break;
    await delay(5000, undefined, { signal: controller.signal }).catch(() => {});
  } while (!controller.signal.aborted);
} finally {
  await pool.end();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}

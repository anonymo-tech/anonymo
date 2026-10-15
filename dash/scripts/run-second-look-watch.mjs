import { createDatabase } from '../server/db/database.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import {
  exitWatchConfig,
  exitWatchCapability,
} from '../server/second-look/exit-sources.ts';
import { processNextExitWatch } from '../server/second-look/exit-watch.ts';
const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !['--check', '--loop'].includes(arg)))
  throw new Error('Unsupported watcher option.');
const config = exitWatchConfig();
if (args.has('--check'))
  process.stdout.write(JSON.stringify(exitWatchCapability(config)) + '\n');
else {
  let pool,
    stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (
      !process.env.CONCLAVE_DATABASE_URL ||
      !exitWatchCapability(config).configured
    )
      throw new Error('Unavailable');
    configuredKeyring();
    pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 2);
    do {
      const result = await processNextExitWatch(pool, config);
      process.stdout.write(
        JSON.stringify({
          processed: result.processed,
          alerts: result.alerts,
          reason: result.reason,
        }) + '\n',
      );
      if (!args.has('--loop') || stopped) break;
      await new Promise((resolve) => {
        const timer = setTimeout(done, config.pollIntervalMs);
        function done() {
          clearTimeout(timer);
          process.removeListener('SIGINT', done);
          process.removeListener('SIGTERM', done);
          resolve();
        }
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
    } while (!stopped);
  } catch {
    process.stderr.write(
      'Exit watch unavailable. Provider details and credentials are not logged.\n',
    );
    process.exitCode = 1;
  } finally {
    await pool?.end();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

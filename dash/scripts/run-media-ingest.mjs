import { gatewayApiOrigin } from '../server/gateway/origin.ts';
import { createDatabase } from '../server/db/database.ts';
import { serviceConfig, requireService } from '../server/core/config.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import {
  runNextMediaIngest,
  recoverExpiredMediaIngests,
} from '../server/media/ingest.ts';

let pool;
const controller = new AbortController();
const stop = () => controller.abort();
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--once'))
    throw new Error();
  if (!gatewayApiOrigin()) throw new Error();
  const config = requireService(serviceConfig());
  const keys = configuredKeyring();
  // No GATEWAY credential is needed: this worker cannot generate or re-submit.
  pool = createDatabase(config.databaseUrl, 2);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let failures = 0;
  do {
    let ran = false;
    try {
      await recoverExpiredMediaIngests(pool);
      ran = await runNextMediaIngest(pool, keys, { signal: controller.signal });
      failures = 0;
    } catch {
      failures++;
      process.stderr.write(
        JSON.stringify({
          event: 'MEDIA_INGEST_CYCLE_FAILED',
          at: new Date().toISOString(),
        }) + '\n',
      );
      if (args.includes('--once')) process.exitCode = 1;
    }
    if (args.includes('--once') || controller.signal.aborted) break;
    if (!ran)
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(30000, 1000 * 2 ** Math.min(failures, 5)),
        );
        controller.signal.addEventListener('abort', done, { once: true });
        if (controller.signal.aborted) done();
      });
  } while (!controller.signal.aborted);
} catch {
  process.stderr.write(
    'Media import requires valid server storage configuration and accepts only --once. No configuration values are logged.\n',
  );
  process.exitCode = 1;
} finally {
  controller.abort();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (pool) await pool.end();
}

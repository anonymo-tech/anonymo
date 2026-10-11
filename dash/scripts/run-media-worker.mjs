import { gatewayConfigured } from '../server/gateway/origin.ts';
import { createDatabase } from '../server/db/database.ts';
import { serviceConfig, requireService } from '../server/core/config.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import { createGatewayClient } from '../server/gateway/index.ts';
import { mediaStorageConfigured } from '../server/media/contract.ts';
import {
  recoverExpiredMediaJobs,
  runNextMediaJob,
} from '../server/media/worker.ts';

let pool;
let stopping = false;
const stop = () => {
  stopping = true;
};

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--once'))
    throw new Error('Invalid worker arguments.');
  if (!gatewayConfigured()) throw new Error();
  const config = requireService(serviceConfig());
  const keys = configuredKeyring();
  const storageReady = mediaStorageConfigured();
  if (!config.gatewayKey || !/^[\x21-\x7e]{1,512}$/.test(config.gatewayKey))
    throw new Error('Provider configuration is unavailable.');
  const provider = createGatewayClient({ apiKey: config.gatewayKey });
  pool = createDatabase(config.databaseUrl, 2);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let failures = 0;
  do {
    let ran = false;
    try {
      await recoverExpiredMediaJobs(pool);
      ran = await runNextMediaJob(pool, provider, keys, { storageReady });
      failures = 0;
    } catch {
      failures++;
      process.stderr.write(
        JSON.stringify({
          event: 'MEDIA_WORKER_CYCLE_FAILED',
          at: new Date().toISOString(),
        }) + '\n',
      );
      if (args.includes('--once')) process.exitCode = 1;
    }
    if (args.includes('--once') || stopping) break;
    if (!ran)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(30000, 1000 * 2 ** Math.min(failures, 5))),
      );
  } while (!stopping);
} catch {
  process.stderr.write(
    'Media worker requires valid server configuration and accepts only --once. No configuration values are logged.\n',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (pool) await pool.end();
}

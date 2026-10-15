import { createDatabase } from '../server/db/database.ts';
import { recoverExpiredJobs } from '../server/db/jobs.ts';
import { serviceConfig, requireService } from '../server/core/config.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import { createPpqClient } from '../server/ppq/index.ts';
import { runNextCall } from '../server/routes/call-worker.ts';
import { runWorkerLoop } from './runtime/worker-loop.mjs';
import { refreshBaselineRoutes } from '../server/routes/baseline-catalog.ts';

const log = (event) =>
  process.stderr.write(
    JSON.stringify({ event, at: new Date().toISOString() }) + '\n',
  );
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let pool, pulse;
try {
  const config = requireService(serviceConfig());
  if (!config.ppqKey || !config.inferenceEnabled) throw new Error();
  const keys = configuredKeyring();
  const concurrency = Number(process.env.CONCLAVE_WORKER_CONCURRENCY ?? '4');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error();
  pool = createDatabase(config.databaseUrl, 4);
  await pool.query('SELECT 1');
  await refreshBaselineRoutes(pool);
  let nextCatalogCheck = Date.now() + 6 * 60 * 60 * 1000;
  const provider = createPpqClient({ apiKey: config.ppqKey });
  if (process.send) {
    process.send({ type: 'worker-ready' }, () => {});
    pulse = setInterval(() => {
      if (process.connected) process.send({ type: 'worker-pulse' }, () => {});
    }, 10000);
  }
  await runWorkerLoop({
    runNextCall: () =>
      runNextCall(pool, provider, keys, { jobScope: 'baseline-inference' }),
    recover: async () => {
      if (Date.now() >= nextCatalogCheck) {
        try {
          await refreshBaselineRoutes(pool);
          nextCatalogCheck = Date.now() + 6 * 60 * 60 * 1000;
        } catch {
          // Existing quotes retain their exact immutable terms; expired routes
          // fail closed. Retry a transient catalog outage after five minutes.
          log('CATALOG_REFRESH_UNAVAILABLE');
          nextCatalogCheck = Date.now() + 5 * 60 * 1000;
        }
      }
      return recoverExpiredJobs(pool, 'baseline-inference');
    },
    signal: controller.signal,
    concurrency,
    once: process.argv.includes('--once'),
    log,
  });
} catch {
  log('WORKER_FAILED');
  process.exitCode = 1;
} finally {
  clearInterval(pulse);
  try {
    await pool?.end();
  } catch {
    process.exitCode = 1;
  }
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  if (process.connected) process.disconnect();
}

import { gatewayConfigured } from '../server/gateway/origin.ts';
import { createDatabase } from '../server/db/database.ts';
import { recoverExpiredJobs } from '../server/db/jobs.ts';
import { serviceConfig, requireService } from '../server/core/config.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import { createGatewayClient } from '../server/gateway/index.ts';
import { runNextCall } from '../server/routes/call-worker.ts';
import { runCrossCheckSweep } from '../server/crosscheck/execution.ts';
import { runBriefSynthesisSweep } from '../server/briefs/execution.ts';

const config = requireService(serviceConfig());
if (!config.gatewayKey || !gatewayConfigured())
  throw new Error('GATEWAY_API_KEY is required to start the inference worker.');
if (!config.inferenceEnabled)
  throw new Error(
    'CONCLAVE_INFERENCE_ENABLED must be explicitly enabled for the inference worker.',
  );
const keys = configuredKeyring();
const concurrency = Number(process.env.CONCLAVE_WORKER_CONCURRENCY ?? '4');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
  throw new Error('CONCLAVE_WORKER_CONCURRENCY must be between one and four.');
const pool = createDatabase(config.databaseUrl, 4);
const provider = createGatewayClient({ apiKey: config.gatewayKey });
let stopping = false;
let consecutiveFailures = 0;
process.once('SIGINT', () => {
  stopping = true;
});
process.once('SIGTERM', () => {
  stopping = true;
});
try {
  do {
    let ran = false;
    try {
      await recoverExpiredJobs(pool);
      const results = await Promise.allSettled(
        Array.from({ length: concurrency }, () =>
          runNextCall(pool, provider, keys),
        ),
      );
      ran = results.some(
        (result) => result.status === 'fulfilled' && result.value,
      );
      await runCrossCheckSweep(pool, keys);
      await runBriefSynthesisSweep(pool, keys);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Worker batch incomplete.');
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
      process.stderr.write(
        JSON.stringify({
          event: 'WORKER_CYCLE_FAILED',
          at: new Date().toISOString(),
        }) + '\n',
      );
      if (process.argv.includes('--once')) process.exitCode = 1;
    }
    if (process.argv.includes('--once')) break;
    if (!ran)
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(30000, 1000 * 2 ** Math.min(consecutiveFailures, 5)),
        ),
      );
  } while (!stopping);
} finally {
  await pool.end();
}

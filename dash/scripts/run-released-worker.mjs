import { createDatabase } from "../server/db/database.ts";
import { recoverExpiredJobs } from "../server/db/jobs.ts";
import { serviceConfig, requireService } from "../server/core/config.ts";
import { configuredKeyring } from "../server/core/encryption.ts";
import { createPpqClient } from "../server/ppq/index.ts";
import { runNextCall } from "../server/routes/call-worker.ts";
import { runWorkerLoop, interruptibleSleep } from "./runtime/worker-loop.mjs";
import { refreshBaselineRoutes } from "../server/routes/baseline-catalog.ts";
import { refreshWorkspaceCatalog } from "../server/workspace/catalog.ts";
import { runScheduledAgents } from "../server/workspace/services.ts";
import { runCrossCheckSweep } from "../server/crosscheck/execution.ts";
import { runBriefSynthesisSweep } from "../server/briefs/execution.ts";
import { runNextMediaJob, recoverExpiredMediaJobs } from "../server/media/worker.ts";
import { runNextMediaIngest, recoverExpiredMediaIngests } from "../server/media/ingest.ts";
import { issuePendingReceipts, buildCompletedReceiptHours } from "../server/receipts/service.ts";
import { runtimeSigner } from "../server/receipts/runtime-signer.ts";
import { featureOn } from "../components/dashboard/feature-switches.ts";
const log = (event) =>
  process.stderr.write(JSON.stringify({ event, at: new Date().toISOString() }) + "\n");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const pools = [];
let pulse;
try {
  const config = requireService(serviceConfig());
  if (!config.ppqKey || !config.inferenceEnabled) throw Error();
  const keys = configuredKeyring(),
    provider = createPpqClient({ apiKey: config.ppqKey });
  const pool = createDatabase(config.databaseUrl, 4);
  pools.push(pool);
  await pool.query("SELECT 1");
  await refreshBaselineRoutes(pool);
  await refreshWorkspaceCatalog(pool);
  let importer, receipts;
  if (featureOn("studio")) {
    importer = createDatabase(process.env.CONCLAVE_IMPORTER_DATABASE_URL, 1);
    pools.push(importer);
    await importer.query("SELECT 1");
  }
  if (featureOn("receipts")) {
    receipts = createDatabase(process.env.CONCLAVE_RECEIPTS_DATABASE_URL, 1);
    pools.push(receipts);
    const signer = await runtimeSigner(receipts);
    signer.seed.fill(0);
  }
  if (process.send) {
    process.send({ type: "worker-ready" }, () => {});
    pulse = setInterval(() => {
      if (process.connected) process.send({ type: "worker-pulse" }, () => {});
    }, 10000);
  }
  let nextCatalog = Date.now() + 3600000,
    nextSweep = 0;
  const loops = [
    runWorkerLoop({
      runNextCall: () => runNextCall(pool, provider, keys, { jobScope: "released-inference" }),
      recover: async () => {
        if (Date.now() >= nextCatalog) {
          try {
            await refreshBaselineRoutes(pool);
            await refreshWorkspaceCatalog(pool);
            nextCatalog = Date.now() + 3600000;
          } catch {
            log("CATALOG_REFRESH_UNAVAILABLE");
            nextCatalog = Date.now() + 300000;
          }
        }
        if (Date.now() >= nextSweep) {
          if (featureOn("crosscheck")) await runCrossCheckSweep(pool, keys);
          if (featureOn("synthesis")) await runBriefSynthesisSweep(pool, keys);
          await runScheduledAgents(pool);
          nextSweep = Date.now() + 10000;
        }
        return recoverExpiredJobs(pool, "released-inference");
      },
      signal: controller.signal,
      concurrency: Number(process.env.CONCLAVE_WORKER_CONCURRENCY ?? 2),
      log,
    }),
  ];
  if (importer) {
    loops.push(
      runWorkerLoop({
        runNextCall: () => runNextMediaJob(pool, provider, keys, { storageReady: true }),
        recover: () => recoverExpiredMediaJobs(pool),
        signal: controller.signal,
        concurrency: 1,
        log,
      }),
    );
    loops.push(
      runWorkerLoop({
        runNextCall: () => runNextMediaIngest(importer, keys, { signal: controller.signal }),
        recover: () => recoverExpiredMediaIngests(importer),
        signal: controller.signal,
        concurrency: 1,
        log,
      }),
    );
  }
  if (receipts)
    loops.push(
      (async () => {
        while (!controller.signal.aborted) {
          let signer;
          try {
            signer = await runtimeSigner(receipts);
            await issuePendingReceipts(receipts, signer, 25);
            await buildCompletedReceiptHours(receipts, signer.trust);
          } catch {
            log("RECEIPT_CYCLE_FAILED");
          } finally {
            signer?.seed.fill(0);
          }
          await interruptibleSleep(15000, controller.signal);
        }
      })(),
    );
  await Promise.all(loops);
} catch (error) {
  log("WORKER_FAILED");
  controller.abort();
  process.exitCode = 1;
} finally {
  controller.abort();
  clearInterval(pulse);
  for (const p of pools) await p.end().catch(() => {});
  if (process.connected) process.disconnect();
}

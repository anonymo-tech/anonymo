import { registerRushJobs } from "../rush/monitor.ts"; // ON3
import { runWebhooks } from "../webhooks/worker.ts"; // V86: bounded event delivery.
import type { Ctx } from "../context.ts";
import { expireHolds } from "../ledger/ledger.ts";
import { pollChain } from "../chain/indexer.ts";
import { runSpendWatch } from "./spend-watch.ts";
import { retryAnchors, runAnchor, runKeyRotation } from "./anchor.ts";
import { runAttestor } from "./attestor.ts";
import { runMeasurementJob } from "./measurement-bundles.ts";
import { runDayzero } from "./dayzero.ts";
import { runCanaries } from "./canaries.ts";
import { runProbes } from "./probes.ts";
import { runRegistry } from "./registry.ts";
import { runSettlement } from "./settlement.ts";
import { runSlasher } from "./slasher.ts";
import { ALERT_INTERVAL_MS, runAlertNotifier } from "./alerts.ts";
import { runBatches, type Dispatch } from "./batches.ts";
import { expirePaidResults } from "../pay/recovery.ts";

export function registerJobs(ctx: Ctx, dispatch?: Dispatch) {
  const { cfg, jobs } = ctx;
  registerRushJobs(ctx); // ON3
  const chainOn = () => ["credits", "callPay", "providerBond", "receiptAnchor", "royalty"].some((n) => ctx.chain.address(n as never));
  jobs.register("health-flush", 5_000, () => ctx.health.flush(ctx.db));
  jobs.register("holds-expire", 60_000, () => expireHolds(ctx.db));
  // x402 payment recovery: rows and sealed answers past their 24 hours are deleted.
  jobs.register("x402-recovery-expire", 3_600_000, () => expirePaidResults(ctx));
  jobs.register("catalog-refresh", 30_000, () => ctx.catalog.refresh(), { atStart: true });
  jobs.register("provider-registry", cfg.workers.registryIntervalMs, () => runRegistry(ctx), { atStart: true });
  if (cfg.routing.probes) jobs.register("health-probes", cfg.routing.probeIntervalMs, () => runProbes(ctx), { atStart: true });
  if (cfg.canaries.enabled) jobs.register("canaries", cfg.canaries.intervalMs, () => runCanaries(ctx));
  jobs.register("attestor", cfg.attestation.intervalMs, () => runAttestor(ctx), { atStart: true });
  // Off unless MEASUREMENTS_ENABLED: Rekor lookups, signed measurement bundles (with MEASUREMENT_PUBLIC_KEY) and
  // register() calldata for attested measurements. Sends nothing.
  if (cfg.measurements.enabled) jobs.register("measurements", cfg.measurements.intervalMs, () => runMeasurementJob(ctx));
  // Off unless DAYZERO_ENABLED: watch Hugging Face for new fine-tunes of the configured permissive base models, and
  // evaluate and promote candidates an operator has linked and approved. Serving anything still needs an approval.
  if (cfg.lane.dayzero.enabled) jobs.register("dayzero", cfg.lane.dayzero.intervalMs, () => runDayzero(ctx));
  jobs.register("receipts-anchor", cfg.receipts.anchorIntervalMs, async () => ({ anchor: await runAnchor(ctx), retry: await retryAnchors(ctx) }), { atStart: true });
  jobs.register("receipt-key-rotation", 3_600_000, () => runKeyRotation(ctx), { atStart: true });
  jobs.register("settlement", cfg.workers.settlementIntervalMs, () => runSettlement(ctx), { atStart: true });
  jobs.register("slasher", 3_600_000, () => runSlasher(ctx));
  jobs.register("chain-indexer", 5_000, async () => (chainOn() ? pollChain(ctx) : { skipped: "no contracts" }), { atStart: true });
  if (cfg.webhookSigningEnabled) jobs.register("webhooks", 60_000, () => runWebhooks(ctx)); // V86.
  jobs.register("spend-watch", 60_000, () => runSpendWatch(ctx));
  jobs.register("alert-notifier", ALERT_INTERVAL_MS, () => runAlertNotifier(ctx), { atStart: true });
  // Batch API: runs queued batch lines in spare capacity, expires overdue batches and deletes results past BATCH_RESULTS_TTL.
  if (dispatch) jobs.register("batches", cfg.batch.intervalMs, () => runBatches(ctx, dispatch));
}

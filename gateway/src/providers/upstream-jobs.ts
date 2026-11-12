// WS04 · Background jobs for Anonymo upstreams, registered once from src/anonymo/routes.ts:
//   anonymo-canaries   wakes every 10 s and runs the liveness canary of every route that is due (config interval_s)
//   anonymo-balances   reads every prepaid upstream's wallet balance each minute, alarms and drains (providers/balance.ts)
// Both only act on Anonymo routes (offers with a tier); without config/upstreams.yaml seeded they do nothing.
// A worker process runs them only once its WORKER_JOBS allowlist (src/config.ts, WS01/WS10) names them.

import type { Ctx } from "../context.ts";
import { runUpstreamCanaries, UPSTREAM_CANARY_TICK_MS } from "../services/canaries.ts";
import { setAnonymoScoring } from "../routing/score.ts";
import { BALANCE_INTERVAL_MS, runBalanceAlarms } from "./balance.ts";
import { loadUpstreamsRuntime } from "./tiers.ts";

export const UPSTREAM_JOB_NAMES = ["anonymo-canaries", "anonymo-balances"] as const;

export function registerUpstreamJobs(ctx: Ctx) {
  ctx.jobs.register("anonymo-canaries", UPSTREAM_CANARY_TICK_MS, () => runUpstreamCanaries(ctx), { atStart: true });
  ctx.jobs.register("anonymo-balances", BALANCE_INTERVAL_MS, () => runBalanceAlarms(ctx), { atStart: true });
}

/** Load the configured route-score weights into this process (each canary tick reloads them too). */
export async function loadAnonymoScoring(ctx: Pick<Ctx, "db">) {
  setAnonymoScoring((await loadUpstreamsRuntime(ctx.db))?.scoring);
}

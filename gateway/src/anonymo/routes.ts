// Every Anonymo route is mounted here, so workstreams add one line in this file instead of editing src/app.ts.
// Keep the list in workstream order; each line names its owner.

import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { abuseRoutes } from "./abuse/routes.ts";
import { refusalRoutes } from "./refusal/routes.ts";
import { mediaRoutes } from "./media/routes.ts";
import { trustRoutes } from "./trust/routes.ts";
import { anonymoMoneyRoutes } from "./deposits/index.ts";
import { registerUpstreamJobs } from "../providers/upstream-jobs.ts";
import { freeTierRoutes } from "./freetier/routes.ts";
import { askMoRoutes } from "./askmo/routes.ts";
import { memorySyncRoutes } from "./memory-sync/routes.ts";
import { ventureRoutes } from "./ventures/routes.ts";
import { keySafeRoutes } from "./keysafe/routes.ts";
import { codesRoutes } from "./codes/routes.ts";
import { everydayContractRoutes } from "./everyday-contracts.ts";
import { lifeboatRoutes } from "./lifeboat/routes.ts";
import { complianceRoutes, mountRegionGate } from "./region/compliance.ts";

export function anonymoRegionGate(app: Hono, ctx: Ctx, env: Record<string, unknown>) {
  return ctx.cfg.features.compliance ? mountRegionGate(app, ctx, env) : undefined;
}

export function anonymoRoutes(app: Hono, ctx: Ctx, regionAccess?: ReturnType<typeof mountRegionGate>) {
  if (regionAccess) complianceRoutes(app, ctx, regionAccess);
  abuseRoutes(app, ctx); // WS02 · abuse inbox, takedowns, floor-hit reporting (region rules mount in app.ts, see region/middleware.ts)
  refusalRoutes(app, ctx); // WS03 · per-key refusal-catch setting
  registerUpstreamJobs(ctx); // WS04 · upstream canaries and wallet-balance alarms (jobs, no routes)
  anonymoMoneyRoutes(app, ctx); // WS05 · keys, deposits, withdrawals, x402 on Base and Solana
  if (ctx.cfg.features.media) mediaRoutes(app, ctx); // WS06 · media endpoints (src/anonymo/media/routes.ts), off unless ANONYMO_FEATURE_MEDIA
  if (ctx.cfg.features.freeTier) freeTierRoutes(app, ctx);
  if (ctx.cfg.features.memorySync) memorySyncRoutes(app, ctx); // Everyday 27 · Vault Memory
  trustRoutes(app, ctx); // WS09 · receipts and proofs, manifest, leaderboard
  if (ctx.cfg.features.askMo) askMoRoutes(app, ctx);
  if (ctx.cfg.features.ventures) ventureRoutes(app, ctx); // WS11, off unless ANONYMO_FEATURE_VENTURES · Anonymo Ventures: the crew, Run Mode, Recipes, People's Forks (model anonymo-swarm mounts in app.ts)
  if (ctx.cfg.features.keySafe) keySafeRoutes(app, ctx); // Everyday 26 · passkey-wrapped backups
  if (ctx.cfg.features.codes) codesRoutes(app, ctx); // Everyday 25 · voucher issuance and redemption
  if (ctx.cfg.features.everydayContracts) everydayContractRoutes(app);
  if (ctx.cfg.features.lifeboat) lifeboatRoutes(app, ctx);
}

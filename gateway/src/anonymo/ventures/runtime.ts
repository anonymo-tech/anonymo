// WS11 · the Ventures runtime: the task registry, the services the crew uses, and the background jobs.
//
// One runtime per gateway context. Services default to what a single gateway host can run: the local sandbox driver
// (macOS sandbox-exec or Linux bwrap, plus a per-sandbox egress proxy), or a self-hosted E2B cluster when
// VENTURES_E2B_URL is set (required in production, where CLEAN sandboxes need OS- or VM-level network isolation).

import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Ctx } from "../../context.ts";
import { keys } from "../../db/schema.ts";
import { log } from "../../lib/util.ts";
import { usdToPico } from "../../lib/money.ts";
import { VentureEvents } from "./events.ts";
import { chargeCrew } from "./money.ts";
import { adKit, comparison, landingCopy, switchKit, takeoverAds } from "./mos/adman.ts";
import { buildApp, buildImport, redTeam, writeImportTests, writeTests } from "./mos/build.ts";
import { designSystem, landingPage } from "./mos/designer.ts";
import { forkRepo, rebrand, scanBuild } from "./mos/licence.ts";
import { scout, specFilter } from "./mos/scout.ts";
import { commitRepo, deploySite } from "./mos/ship.ts";
import { forkPlan, launch, parity, plan, research } from "./mos/strategist.ts";
import type { RoleHandler, VentureDeps } from "./orchestrator.ts";
import { adsTask, briefTask, improveTask, runModeTick, watchTask } from "./runmode.ts";
import { E2BDriver, LocalDriver, SandboxPool } from "./sandbox/index.ts";
import { purgeArtifacts } from "./store/artifacts.ts";
import { configureBodies, defaultArtifactDir, FsBodyStore } from "./store/bodies.ts";

export const HANDLERS: Record<string, RoleHandler> = {
  "scout.site": scout,
  "spec.filter": specFilter,
  "strategist.research": research,
  "strategist.plan": plan,
  "strategist.parity": parity,
  "strategist.launch": launch,
  "strategist.fork-plan": forkPlan,
  "designer.system": designSystem,
  "designer.landing": landingPage,
  "adman.landing": landingCopy,
  "adman.adkit": adKit,
  "adman.comparison": comparison,
  "adman.switch": switchKit,
  "adman.takeover-ads": takeoverAds,
  "tester.tests": writeTests,
  "tester.import": writeImportTests,
  "builder.app": buildApp,
  "builder.import": buildImport,
  "builder.rebrand": rebrand,
  "redteam.scan": redTeam,
  "licence.scan": scanBuild,
  "licence.fork": forkRepo,
  "repo.commit": commitRepo,
  "deployer.static": deploySite,
  "run.watch": watchTask,
  "run.improve": improveTask,
  "run.ads": adsTask,
  "run.brief": briefTask,
};

export type VenturesRuntime = { deps: VentureDeps; events: VentureEvents };

const runtimes = new WeakMap<Ctx, VenturesRuntime>();

export function defaultSandboxPool(ctx: Ctx, env: Record<string, string | undefined> = process.env): SandboxPool {
  const production = ctx.cfg.env === "production";
  const { VENTURES_E2B_URL: baseUrl, VENTURES_E2B_API_KEY: apiKey } = env;
  const driver = baseUrl ? new E2BDriver({ baseUrl, apiKey }) : new LocalDriver();
  return new SandboxPool({ driver, maxConcurrent: Number(env.VENTURES_SANDBOX_MAX ?? 200), pricePerVcpuMinuteUsd: Number(env.VENTURES_VCPU_MINUTE_USD ?? 0.002), production });
}

/** The runtime for this gateway (created on first use). Tests pass overrides for services, handlers, the clock or the Llm. */
export function venturesRuntime(app: Hono, ctx: Ctx, overrides: Partial<Pick<VentureDeps, "services" | "handlers" | "now" | "llmFor">> = {}): VenturesRuntime {
  const have = runtimes.get(ctx);
  if (have) {
    // Overrides change the one runtime in place, so routes mounted earlier see them too.
    if (overrides.services) Object.assign(have.deps.services, overrides.services);
    if (overrides.handlers) Object.assign(have.deps.handlers, overrides.handlers);
    if ("now" in overrides) have.deps.now = overrides.now;
    if ("llmFor" in overrides) have.deps.llmFor = overrides.llmFor;
    return have;
  }
  const events = new VentureEvents();
  const deps: VentureDeps = {
    app,
    ctx,
    events,
    handlers: { ...HANDLERS, ...overrides.handlers },
    now: overrides.now,
    llmFor: overrides.llmFor,
    services: { gatewayHost: process.env.VENTURES_GATEWAY_HOST ?? "anonymo.tech", ...overrides.services },
    chargeCrew: async (v, usd, ref) => {
      if (!v.crewKeyHash) return false;
      const [crew] = await ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, v.crewKeyHash));
      return crew ? chargeCrew(ctx, { accountId: crew.accountId, keyHash: v.crewKeyHash, amount: usdToPico(usd.toFixed(12)), ref }) : false;
    },
  };
  if (!deps.services.sandboxPool) deps.services.sandboxPool = defaultSandboxPool(ctx);
  configureBodies(ctx.db, new FsBodyStore(defaultArtifactDir(), ctx.cfg.appSecret));
  const rt = { deps, events };
  runtimes.set(ctx, rt);
  return rt;
}

/** Background work: Run Mode ticks every five minutes, the 30-day artifact purge daily. */
export function registerVentureJobs(ctx: Ctx, rt: VenturesRuntime) {
  ctx.jobs.register("ventures-run-mode", 5 * 60_000, async () => {
    const out = await runModeTick(rt.deps, (rt.deps.now ?? (() => new Date()))());
    if (out.length) log.info("run mode tick", { ran: out.filter((o) => o.ran).length, waited: out.filter((o) => !o.ran).length });
  });
  ctx.jobs.register("ventures-purge", 24 * 3_600_000, () => purgeArtifacts(ctx.db), { atStart: true });
}

import { accountRunwayRoutes } from "./api/account-runway.ts"; // B119
import { hardeningMiddleware, originLockMiddleware } from "./hardening/middleware.ts"; // HD1
import { internalEnv } from "./hardening/client.ts"; // HD1
import { initializeUpstreamMonitor } from "./rush/monitor.ts"; // ON3
import { facilitatorRoutes } from "./facilitator/routes.ts"; // v6 F: hosted x402 facilitator
import { firstCallRoutes, firstCallCsp } from "./developers/first-call.ts"; // ON2
import { inferenceScopeMiddleware, keyDefaultsRoutes } from "./provisioning/scope.ts"; // ZK6
import { structuredOutputMiddleware } from "./structured-output/chat.ts"; // V83
import { paymentRecovery } from "./pay/recovery.ts";
import { statementRoutes } from "./api/statements.ts"; // V87
import { laneReportRoutes } from "./api/lane-report.ts"; // Lane report
import { insightsRoutes } from "./api/insights.ts"; // V88: spend insights.
import { webhookRoutes } from "./webhooks/routes.ts"; // V86: signed destinations.
import { activityRoutes } from "./api/activity.ts";
import { EXPOSED_RESPONSE_HEADERS } from "./api/common.ts";
import { kv } from "./db/schema.ts";
import { deployedInventory, inventoryJson } from "./privacy/inventory.ts";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { loadConfig } from "./config.ts";
import { openDatabase, type DbHandle } from "./db/client.ts";
import { Catalog } from "./catalog/catalog.ts";
import { HealthTracker } from "./services/health.ts";
import { ReceiptSigner } from "./receipts/signer.ts";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./lib/ratelimit.ts";
import { ChainService } from "./chain/service.ts";
import { ResponseCache } from "./gateway/cache.ts";
import { Telemetry } from "./gateway/otel.ts";
import { TracingExporter } from "./services/tracing.ts";
import { Jobs } from "./services/jobs.ts";
import type { Ctx } from "./context.ts";
import { ApiError } from "./lib/errors.ts";
import { log, setLogLevel } from "./lib/util.ts";
import { chatRoutes } from "./api/chat.ts";
import { keyPolicyMiddleware } from "./anonymo/deposits/index.ts";
import { regionMiddleware } from "./anonymo/region/middleware.ts";
import { regionRulesFromEnv } from "./anonymo/region/rules.ts";
import { anonymoRoutes } from "./anonymo/routes.ts";
import { swarmMiddleware } from "./anonymo/ventures/routes.ts";
import { createAnonymoServices, type AnonymoServices } from "./anonymo/services.ts";
import { modelsRoutes } from "./api/models.ts";
import { generationRoutes } from "./api/generation.ts";
import { keysRoutes } from "./api/keys.ts";
import { savedRoutesRoutes } from "./api/saved-routes.ts";
import { presetsRoutes } from "./api/presets.ts";
import { characterRoutes } from "./api/characters.ts";
import { memoryRoutes } from "./api/memory.ts";
import { agentSessionsRoutes } from "./api/agent-sessions.ts";
import { spendRoutes } from "./api/spend.ts";
import { disclosureRoutes } from "./api/disclosure.ts";
import { attestationRoutes } from "./api/attestation.ts";
import { attestationHistoryRoutes } from "./api/attestation-history.ts";
import { measurementRoutes } from "./api/measurements.ts";
import { laneRoutes } from "./api/lane.ts";
import { dayzeroRoutes } from "./api/dayzero.ts";
import { creatorClaimRoutes } from "./api/creator-claims.ts";
import { publicRoutes } from "./api/public.ts";
import { batchesRoutes } from "./api/batches.ts";
import { adminRoutes } from "./admin/trpc.ts";
import { registerJobs } from "./services/register.ts";
import { mcpRoutes } from "./api/mcp.ts";
import { anthropicRoutes } from "./api/anthropic.ts";
import { responsesRoutes } from "./api/responses.ts";
import { siteRoutes } from "./api/site.ts";
import { badgeRoutes } from "./api/badge.ts";
import { statusRoutes } from "./api/status.ts";
import { startStatusLoop, statusMiddleware } from "./services/slo.ts";

export type AppOptions = {
  env?: Record<string, unknown>;
  rand?: () => number;
  chain?: ChainService;
  startJobs?: boolean;
  /** Already initialized, caller-owned database for embedding or sharing an in-memory test store. */
  database?: Pick<DbHandle, "db" | "kind">;
  /** Replace Anonymo's floor gate or refusal classifier (tests, and the real implementations once built). */
  anonymo?: Partial<AnonymoServices>;
};

export async function createApp(opts: AppOptions = {}) {
  const cfg = loadConfig(opts.env ?? {});
  // The same settings loadConfig read (process env, then overrides).
  const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, unknown>;
    setLogLevel(cfg.logLevel);
  const ownedDatabase = opts.database ? undefined : await openDatabase(cfg.databaseUrl, { migrate: cfg.autoMigrate });
  const handle = opts.database ?? ownedDatabase!;
  const redis = cfg.redisUrl ? new (await import("ioredis")).Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }) : undefined;
  const limiter: RateLimiter = redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter();
  const signer = new ReceiptSigner(handle.db, cfg.appSecret, cfg.receipts.rotationDays, cfg.receipts.signingKey);
  await signer.init();
  const catalog = new Catalog(handle.db);
  await catalog.refresh();
  const health = new HealthTracker(cfg.routing.outageWindowMs);
    await health.refreshAggregates(handle.db).catch(() => undefined);

  const ctx: Ctx = {
    cfg,
    db: handle.db,
    dbKind: handle.kind,
    catalog,
    health,
    signer,
    limiter,
    chain: opts.chain ?? new ChainService(cfg),
    cache: new ResponseCache(cfg.appSecret, 5_000, redis),
    telemetry: new Telemetry(cfg.gateway.otlpEndpoint, cfg.gateway.otelServiceName),
    tracing: new TracingExporter(cfg.appSecret),
    jobs: new Jobs(cfg.redisUrl, async (state) => {
      const value = { ...state, last_error: state.last_error ? "Job failed; inspect private operator logs." : null };
      await handle.db.insert(kv).values({ key: `job-health:${state.name}`, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    }, cfg.runtimeRole === "worker" ? cfg.workerJobs : undefined),
    rand: opts.rand,
    anonymo: createAnonymoServices(env, opts.anonymo),
  };

  await initializeUpstreamMonitor(ctx); // ON3
  // The workspace UI is dash/ (WS07), deployed on its own; the router serves the API and a small built-in page.
  const csp = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'";
  const app = new Hono();
  app.use("*", originLockMiddleware(ctx)); // HD1: authenticate ingress before CORS, including preflights.
  // The OpenAI-style /v1/* aliases get the same CORS as /api/*, so a browser can read the receipt, lane and policy headers on either.
  const apiCors = cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-payment", "payment-signature", "payment-recovery", "x-wallet-auth", "x-anonymo-cache", "x-anonymo-disclosure-max", "x-anonymo-lane", "x-anonymo-lane-downgrade", "x-anonymo-sealed", "x-anonymo-refusal-catch", /* WS01: old names, one release */ "x-anonymo-cache", "x-anonymo-disclosure-max", "x-anonymo-lane", "x-anonymo-lane-downgrade", "http-referer", "x-title", "traceparent", "x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access"], exposeHeaders: [...EXPOSED_RESPONSE_HEADERS, ...(cfg.routeExplain ? ["x-anonymo-route"] : []), /* V84 */ ...(cfg.structuredOutputCheckEnabled ? ["x-anonymo-json-check"] : []), /* V83 */] });
  app.use("/api/*", apiCors);
  app.use("/v1/*", apiCors);
  app.use("/facilitator/*", apiCors); // v6 F
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    if (c.res.headers.get("content-type")?.includes("text/html")) {
      c.header("content-security-policy", firstCallCsp(c.req.method, c.req.path, cfg.developerFirstCallEnabled) ?? csp); // ON2: retain the script-free endpoint page policy.
    }
    if (cfg.production) c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  app.use("*", hardeningMiddleware(ctx)); // HD1: after CORS/security headers, before every body reader.
  app.use("*", statusMiddleware(ctx)); // public-lane outcomes per API surface for /api/v1/status/slo; private lanes are not counted here
  app.use("*", inferenceScopeMiddleware(ctx)); // ZK6: deny by default before account middleware.
  paymentRecovery(app, ctx); // a lost x402 answer is sent again, never paid twice; outside every other route middleware
  structuredOutputMiddleware(app, ctx); // V83: ordinary chat routes bill each call.
  firstCallRoutes(app, cfg.developerFirstCallEnabled, cfg.siteUrl); // ON2: the public site address, not the router host
  app.use("*", regionMiddleware(regionRulesFromEnv(env))); // WS02: 451 for blocked regions, before chat and media.
  app.use("*", keyPolicyMiddleware(ctx)); // WS05: ip_allow, sealed_only and spend windows on inference calls.
  if (cfg.features.ventures) for (const p of ["/v1/chat/completions", "/api/v1/chat/completions"]) app.use(p, swarmMiddleware(ctx, app)); // WS11: model anonymo-swarm starts a Ventures run
  chatRoutes(app, ctx);
  anonymoRoutes(app, ctx); // Anonymo: every workstream mounts its routes in src/anonymo/routes.ts
  batchesRoutes(app, ctx);
  modelsRoutes(app, ctx);
  generationRoutes(app, ctx);
  activityRoutes(app, ctx);
  statementRoutes(app, ctx); // V87
  laneReportRoutes(app, ctx); // Lane report: read-only, with statements
  insightsRoutes(app, ctx); // V88: read-only, off by default.
  accountRunwayRoutes(app, ctx); // B119
  keyDefaultsRoutes(app, ctx); // ZK6: before /keys/:hash.
  keysRoutes(app, ctx);
  savedRoutesRoutes(app, ctx);
  presetsRoutes(app, ctx);
  characterRoutes(app, ctx);
  memoryRoutes(app, ctx);
  agentSessionsRoutes(app, ctx);
  spendRoutes(app, ctx);
  webhookRoutes(app, ctx); // V86.
  disclosureRoutes(app, ctx);
  attestationHistoryRoutes(app, ctx); // before attestationRoutes: /attestation/summary must not be read as a provider id
  attestationRoutes(app, ctx);
  measurementRoutes(app, ctx);
  badgeRoutes(app, ctx);
  laneRoutes(app, ctx);
  dayzeroRoutes(app, ctx);
  creatorClaimRoutes(app, ctx);
  statusRoutes(app, ctx);
  publicRoutes(app, ctx);
  mcpRoutes(app, ctx);
  anthropicRoutes(app, ctx);
  responsesRoutes(app, ctx);
  facilitatorRoutes(app, ctx); // v6 F: answers 503 facilitator_disabled until FACILITATOR_ENABLED
  adminRoutes(app, ctx);
  // Public documents that used to ship inside the website: the OpenAPI description and the data inventory ("what we keep").
  const openapi = readFileSync(resolve(import.meta.dir, "../docs/openapi.json"), "utf8");
  app.get("/openapi.json", (c) => c.body(openapi, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" }));
  const inventory = inventoryJson(deployedInventory(cfg.features.ventures));
  app.get("/keep/inventory.json", (c) => c.body(inventory, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" }));
  siteRoutes(app, ctx); // a small built-in page that lists models and rankings

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    return c.json(new ApiError(404, `No route for ${c.req.method} ${path}.`, "not_found").toJSON(), 404);
  });
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json(err.toJSON(), err.status as never);
    }
    if (err instanceof ZodError) {
      return c.json(new ApiError(400, "Invalid request: " + err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), "invalid_request").toJSON(), 400);
    }
    if ((err as Error)?.name === "AbortError") return c.json(new ApiError(499, "Client closed the request.", "cancelled").toJSON(), 499 as never);
    log.error("unhandled error", { path: new URL(c.req.url).pathname, error: (err as Error)?.message, stack: (err as Error)?.stack?.split("\n").slice(0, 5).join(" | ") });
    return c.json(new ApiError(500, "Internal router error.", "internal").toJSON(), 500);
  });

  // Batch lines are dispatched in process with a marker in `env` that no network request can carry (router/batch-line.ts).
  registerJobs(ctx, (path, init, env) => app.request(path, init, internalEnv(env) as never));
  if (opts.startJobs ?? cfg.workers.enabled) await ctx.jobs.start();

  // Passive health belongs to each API replica, not the shared registry worker's memory.
  const healthTimer = cfg.runtimeRole === "api" ? setInterval(() => void ctx.health.flush(ctx.db).catch(() => undefined), 5000) : null;
  healthTimer?.unref();
  const stopStatus = startStatusLoop(ctx);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (healthTimer) clearInterval(healthTimer);
    await stopStatus();
    await ctx.jobs.stop();
    await ctx.health.flush(ctx.db).catch(() => undefined);
    await ctx.telemetry.close();
    await ctx.tracing.close();
    await limiter.close();
    redis?.disconnect();
    await ownedDatabase?.close();
  };
  return { app, ctx, close, fetch: app.fetch };
}

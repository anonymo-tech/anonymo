// WS11 · the Ventures API (Ventures Backend PART 2, PART 11; Overview §3 and §6).
//
//   GET    /v1/ventures/pricing            prices, tiers, launch lines (public)
//   GET    /v1/ventures/tier               this key's tier and what it unlocks
//   POST   /v1/ventures                    start a run: { mode, brief, target_url?, repo_url?, brand?, rival?, ... }
//   GET    /v1/ventures                    this key's runs
//   GET    /v1/ventures/{id}               the run, its steps, candidates, costs
//   GET    /v1/ventures/{id}/events        step events (SSE; Last-Event-ID or ?after= to resume)
//   GET    /v1/ventures/{id}/artifacts     artifact hashes (both zones); GET …/artifacts/{sha} returns a CLEAN body
//   GET    /v1/ventures/{id}/receipt       every route, candidate and charge, and the clean-room root
//   GET    /v1/ventures/{id}/export        the repo as .tar.gz (always works, Law 8)
//   POST   /v1/ventures/{id}/push          push the repo to the owner's https remote
//   POST   /v1/ventures/{id}/cancel        stop a run
//   POST   /v1/ventures/{id}/run-mode      switch Run Mode on for a finished run; DELETE on the RUN venture turns it off
//   POST   /v1/ventures/{id}/support-reply draft a support reply (Run Mode; nothing stored)
//   POST   /v1/ventures/{id}/recipe        save the run's pipeline as a Recipe
//   GET    /v1/recipes, /v1/recipes/{id}   the Recipe marketplace (public)
//   POST   /v1/forks/{id}/target           register a People's Fork url against its on-chain commitment
//   GET    /v1/forks                       People's Forks the gateway has seen
// and model `anonymo-swarm` on POST /v1/chat/completions (swarmMiddleware): starts a run, and with stream: true streams
// its step events as chat chunks.

import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { stream as honoStream } from "hono/streaming";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { z } from "zod";
import type { Ctx } from "../../context.ts";
import { requireKey, type KeyRow } from "../../api/auth.ts";
import { balanceOf } from "../../ledger/ledger.ts";
import { ApiError, fail } from "../../lib/errors.ts";
import { usdToPico } from "../../lib/money.ts";
import { uid } from "../../lib/util.ts";
import { anonymoKeys } from "../deposits/schema.ts";
import { planVenture, RUN_TASKS, type RunTask } from "./boss.ts";
import { LAUNCH_LINES } from "./copy.ts";
import { crewPool } from "./crew/families.ts";
import { inProcessLlm } from "./crew/caller.ts";
import { webhookSecretFor, ventureWebhookProblem } from "./events.ts";
import { chainOrderReader, claimOrder, fuelAvailable, fuelPoolAvailable, releaseOrder, spendFuel, syncOrders } from "./fuel.ts";
import { registerForkTarget, syncForks, syncVotes, viemReader, type ChainReader } from "./forks.ts";
import { checkOwnerCaps, crewSecret, HOUSE_ACCOUNT, openCrewWallet } from "./money.ts";
import { generateApiKey } from "../../chain/keys.ts";
import { registerRootKey } from "../../api/auth.ts";
import { ensureAccount, post } from "../../ledger/ledger.ts";
import { decrypt, encrypt } from "../../lib/util.ts";
import type { Address } from "viem";
import { cancelVenture, createSteps, loadInput, runVenture, storeInput, ventureSnapshot, type StepTemplate, type VentureInput } from "./orchestrator.ts";
import { crewBudgetOf, crewBudgetUsd, PER_STEP_SHARE, priceList, priceOf, TIER_RULES, tierAllows } from "./pricing.ts";
import { listRecipes, loadRecipe, payRecipeRun, recipeJson, saveRecipe, validateDag } from "./recipes.ts";
import { receiptBundle } from "./receipt.ts";
import { exportTarball, pushToRemote } from "./repo.ts";
import { disableRunMode, draftSupportReply, enableRunMode } from "./runmode.ts";
import { registerVentureJobs, venturesRuntime, type VenturesRuntime } from "./runtime.ts";
import { getArtifact, listArtifacts, tryJson } from "./store/artifacts.ts";
import { ventureForks, ventureRunMode, ventures } from "./store/schema.ts";
import { tierOfKey } from "./tiers.ts";
import { VENTURE_MODES, type Tier, type VentureEvent, type VentureMode } from "./types.ts";

export const SWARM_MODEL = "anonymo-swarm";
const TARGET_MODES: VentureMode[] = ["BUILD_BETTER", "TAKEOVER"];

const CreateBody = z.object({
  mode: z.enum(VENTURE_MODES),
  brief: z.string().max(4000).default(""),
  target_url: z.string().max(2000).optional(),
  repo_url: z.string().max(2000).optional(),
  brand: z.string().max(60).optional(),
  rival: z.string().max(60).optional(),
  publish_source: z.boolean().optional(),
  source_url: z.string().max(2000).optional(),
  deploy: z.object({ domain: z.string().max(253).optional(), ens: z.string().max(253).optional(), ens_resolver: z.string().max(42).optional(), arns: z.string().max(51).optional() }).optional(),
  webhook_url: z.string().max(2000).optional(),
  recipe_id: z.string().max(60).optional(),
  /** A Checkout order (paid on chain in USDG or $NYMO) that pays this run instead of the key's balance. */
  order_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  /** Spend today's Build Fuel credits first (default true when the key has a wallet). */
  use_fuel: z.boolean().optional(),
});
export type CreateVenture = z.infer<typeof CreateBody>;

const PRIVATE_HOST = /^(?:localhost|.*\.local|.*\.internal|.*\.localhost|0\.0\.0\.0|\[?::1\]?|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?f[cd][0-9a-f]{2}:.*|\[?fe80:.*)$/i;

/** A public http(s) url with no credentials; private and loopback hosts are refused (the scout must not reach in). */
export function targetProblem(raw: string, allowPrivate = false): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "target_url is not a url";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "target_url must be http or https";
  if (u.username || u.password) return "target_url must not carry credentials";
  if (!allowPrivate && PRIVATE_HOST.test(u.hostname)) return "target_url must be a public site";
  return null;
}

const usd = (p: bigint) => Number(p) / 1e12;

function owned(rt: VenturesRuntime) {
  return async (c: Context): Promise<{ key: KeyRow; v: typeof ventures.$inferSelect }> => {
    const key = await requireKey(rt.deps.ctx, c.req.header("authorization"));
    const [v] = await rt.deps.ctx.db.select().from(ventures).where(and(eq(ventures.id, c.req.param("id")!), eq(ventures.keyHash, key.keyHash)));
    if (!v) fail(404, "Venture not found.", "not_found");
    return { key, v: v! };
  };
}

/** Starts a run for a key. Shared by POST /v1/ventures and the anonymo-swarm model. */
export async function startVenture(rt: VenturesRuntime, key: KeyRow, body: CreateVenture) {
  const { ctx } = rt.deps;
  const allowPrivate = !!rt.deps.services.allowPrivateTargets;
  if (body.mode === "DUPE_DROP") fail(501, "Dupe Drop is not built yet.", "not_built");
  if (body.mode === "RUN") fail(400, "Run Mode attaches to a finished run: POST /v1/ventures/{id}/run-mode.", "invalid_request");
  const recipe = body.recipe_id ? await loadRecipe(ctx, body.recipe_id) : null;
  if (body.recipe_id && !recipe) fail(404, "Recipe not found.", "not_found");
  const mode = (recipe?.mode as VentureMode | undefined) ?? body.mode;
  const { tier } = await tierOfKey(ctx, key.keyHash);
  if (body.order_id && recipe) fail(400, "A Checkout order pays a plain run; recipes are paid from the balance.", "invalid_request");
  if (!tierAllows(tier, mode)) fail(403, `${mode} needs a higher tier than ${tier}.`, "tier_required");
  const target = TARGET_MODES.includes(mode) ? body.target_url : undefined;
  if (TARGET_MODES.includes(mode)) {
    if (!target) fail(400, "This mode needs target_url.", "invalid_request");
    const p = targetProblem(target!, allowPrivate);
    if (p) fail(400, p, "invalid_request");
  }
  if (mode === "FORK_FLIP" && !body.repo_url) fail(400, "Fork & Flip needs repo_url.", "invalid_request");
  if (mode === "IDEA_TO_LIVE" && body.brief.trim().length < 10) fail(400, "Describe the idea in brief (at least a sentence).", "invalid_request");
  if (body.webhook_url) {
    const p = ventureWebhookProblem(body.webhook_url);
    if (p) fail(400, `webhook_url: ${p}`, "invalid_request");
  }
  if (!crewPool(ctx).length) fail(503, "No model family is available for the crew right now.", "crew_unavailable");
  // Law 7: the brief passes the floor gate before anything is charged, exactly as a chat prompt does.
  const briefText = [body.brief, body.brand, body.rival].filter(Boolean).join("\n");
  if (briefText.trim()) {
    let verdict;
    try {
      verdict = await ctx.anonymo.floor.check({ text: briefText, modality: "text", hasUpload: false });
    } catch {
      fail(503, "The safety check is unavailable. Nothing was started or charged; try again shortly.", "floor_unavailable");
    }
    if (!verdict!.ok) fail(451, "This request crosses a line Anonymo blocks for everyone. Nothing was started or charged.", "floor_blocked", { category: verdict!.category });
  }

  const plan: StepTemplate[] = recipe ? (recipe.dag as StepTemplate[]) : planVenture(mode, { tier, deploy: !!body.deploy && !TARGET_MODES.includes(mode) });
  if (recipe) validateDag(mode, plan);
  const priceUsd = priceOf(mode);
  const price = usdToPico(priceUsd);
  const id = uid("v_");
  // What pays the price: an on-chain Checkout order, then today's Build Fuel credits, then the key's balance.
  const [kw] = await ctx.db.select({ wallet: anonymoKeys.wallet }).from(anonymoKeys).where(eq(anonymoKeys.keyHash, key.keyHash));
  const wallet = kw?.wallet ?? null;
  if (body.order_id && !(await claimOrder(ctx, { orderId: body.order_id, wallet, mode, ventureId: id, price }))) fail(402, "That Checkout order is unknown, already used, for another mode, paid by another wallet, or paid less than the price.", "order_invalid");
  const byOrder = body.order_id ? price : 0n;
  const fuel = byOrder === price || body.use_fuel === false ? 0n : await fuelAvailable(ctx, wallet, new Date(), await fuelPoolAvailable(ctx));
  const byFuel = fuel < price - byOrder ? fuel : price - byOrder;
  const fromBalance = price - byOrder - byFuel;
  const total = fromBalance + (recipe?.priceUsdg ?? 0n);
  if (total > 0n) {
    try {
      await checkOwnerCaps(ctx, key.keyHash, total);
      const bal = await balanceOf(ctx.db, key.accountId);
      if (bal.available < total) fail(402, `This run costs $${usd(total)} from the balance; the key has $${usd(bal.available)} available.`, "insufficient_balance");
    } catch (e) {
      if (body.order_id) await releaseOrder(ctx, body.order_id);
      throw e;
    }
  }

  const salt = toHex(randomBytes(32));
  const targetCommit = target ? keccak256(new Uint8Array([...toBytes(salt as Hex), ...toBytes(target)])) : null;
  const input: VentureInput = { mode, brief: body.brief.trim(), brand: body.brand?.trim() || undefined, rival: body.rival?.trim() || undefined, repo: body.repo_url, publishSource: body.publish_source, sourceUrl: body.source_url, deploy: body.deploy ? { domain: body.deploy.domain, ens: body.deploy.ens, arns: body.deploy.arns, ensResolver: body.deploy.ens_resolver } : undefined };
  await ctx.db.insert(ventures).values({ id, keyHash: key.keyHash, accountId: key.accountId, mode, targetCommit, tier, caps: { total: crewBudgetUsd(priceUsd), perStep: crewBudgetUsd(priceUsd) * PER_STEP_SHARE }, priceUsd: price, paidBalance: fromBalance, status: "QUEUED", webhookUrl: body.webhook_url ?? null, recipeId: recipe?.id ?? null });
  await storeInput(ctx, id, input);
  let crew;
  try {
    if (byFuel > 0n && wallet) await spendFuel(ctx, wallet, byFuel);
    crew = await openCrewWallet(ctx, { ventureId: id, ownerKeyHash: key.keyHash, ownerAccountId: key.accountId, amount: fromBalance, sponsored: byOrder + byFuel, sponsoredKind: byOrder ? "checkout_order" : "build_fuel" });
  } catch (e) {
    if (body.order_id) await releaseOrder(ctx, body.order_id);
    await ctx.db.delete(ventures).where(eq(ventures.id, id));
    throw e;
  }
  if (recipe) await payRecipeRun(ctx, recipe, id, { keyHash: key.keyHash, accountId: key.accountId });
  await ctx.db.update(ventures).set({ crewKeyHash: crew.keyHash, crewKeyEnc: crew.enc }).where(eq(ventures.id, id));
  await createSteps(ctx, id, plan, crewBudgetUsd(priceUsd), crewBudgetUsd(priceUsd) * PER_STEP_SHARE);
  const webhookSecret = body.webhook_url ? webhookSecretFor(ctx, id) : null;
  if (body.webhook_url) rt.events.setWebhook(id, body.webhook_url, webhookSecret!);
  const done = runVenture(rt.deps, id, target ?? null).catch((e) => {
    rt.events.emit({ type: "venture", ventureId: id, status: "FAILED", at: new Date().toISOString(), costUsd: 0 });
    return Promise.reject(e);
  });
  done.catch(() => undefined);
  return { id, mode, tier, price_usd: priceUsd, paid: { order_usd: usd(byOrder), fuel_usd: usd(byFuel), balance_usd: usd(fromBalance) }, recipe_price_usd: recipe ? usd(recipe.priceUsdg) : 0, steps: plan.map((s) => ({ key: s.key, role: s.role, fanout: s.fanout })), ...(target ? { target_commit: targetCommit, target_salt: salt } : {}), ...(webhookSecret ? { webhook_secret: webhookSecret } : {}), events: `/v1/ventures/${id}/events`, done };
}

/**
 * A People's Fork that triggered on chain: its funders already paid (ForkFund routed the USDG to the treasury), so the
 * gateway funds the crew key from that and runs Build Better on the url funders voted on. The repo is MIT.
 */
export async function startForkBuild(rt: VenturesRuntime, forkId: string): Promise<string | null> {
  const { ctx } = rt.deps;
  const [f] = await ctx.db.select().from(ventureForks).where(eq(ventureForks.forkId, forkId));
  if (!f || f.status !== "triggered" || f.ventureId || !f.targetEnc) return null;
  const priceUsd = priceOf("BUILD_BETTER");
  const price = usdToPico(priceUsd);
  // The fork's cash is the USDG it routed on chain; the workers' 80% of it must cover the crew's budget (80% of the
  // price). NYMO contributions were burned and pay for nothing. Too little cash: no build, nothing spent.
  const cash = (f.usdgRouted ?? 0n) * 1_000_000n; // USDG base units (6 decimals) → pico-USD
  if (crewBudgetOf(cash) < crewBudgetOf(price)) {
    await ctx.db.update(ventureForks).set({ status: "underfunded", updatedAt: new Date() }).where(eq(ventureForks.forkId, forkId));
    return null;
  }
  const target = decrypt(ctx.cfg.appSecret, f.targetEnc);
  const id = uid("v_");
  const plan = planVenture("BUILD_BETTER", { tier: "gang", deploy: false });
  const secret = generateApiKey();
  const crew = await registerRootKey(ctx, secret, `fork ${forkId}`);
  await ctx.db.insert(anonymoKeys).values({ keyHash: crew.keyHash, lifetimeCap: crewBudgetOf(price) }).onConflictDoNothing();
  await ctx.db.transaction(async (tx) => {
    await ensureAccount(tx, HOUSE_ACCOUNT, "house");
    await post(tx, { accountId: crew.accountId, keyHash: crew.keyHash, amount: price, kind: "fork_fund", ref: `fork:${f.chainId}:${forkId}:budget`, description: "People's Fork, paid on chain" });
  });
  await ctx.db.insert(ventures).values({ id, keyHash: `fork:${f.chainId}:${forkId}`, accountId: HOUSE_ACCOUNT, mode: "BUILD_BETTER", targetCommit: f.targetCommit, tier: "gang", caps: { total: crewBudgetUsd(priceUsd), perStep: crewBudgetUsd(priceUsd) * PER_STEP_SHARE }, priceUsd: price, status: "QUEUED", crewKeyHash: crew.keyHash, crewKeyEnc: encrypt(ctx.cfg.appSecret, secret) });
  await storeInput(ctx, id, { mode: "BUILD_BETTER", brief: "People's Fork: the better, MIT-licensed version funders voted for." });
  await ctx.db.update(ventureForks).set({ status: "building", ventureId: id, updatedAt: new Date() }).where(eq(ventureForks.forkId, forkId));
  await createSteps(ctx, id, plan, crewBudgetUsd(priceUsd), crewBudgetUsd(priceUsd) * PER_STEP_SHARE);
  void runVenture(rt.deps, id, target).catch(() => undefined);
  return id;
}

/** Votes and forks from chain, when the contracts are configured (or a reader is injected as services.chainReader). */
export async function syncChain(rt: VenturesRuntime): Promise<{ families: string[] | null; started: string[] }> {
  const { ctx } = rt.deps;
  const injected = rt.deps.services.chainReader as ChainReader | undefined;
  const forkFund = process.env.VENTURES_FORK_FUND_ADDRESS as Address | undefined;
  const voteRegistry = process.env.VENTURES_VOTE_REGISTRY_ADDRESS as Address | undefined;
  const reader = injected ?? (forkFund || voteRegistry ? viemReader(ctx.chain.client, { forkFund, voteRegistry, chainId: ctx.cfg.chain.id }) : null);
  const checkout = process.env.VENTURES_CHECKOUT_ADDRESS as Address | undefined;
  const orders = (rt.deps.services.orderReader as Parameters<typeof syncOrders>[1] | undefined) ?? (checkout ? chainOrderReader(ctx.chain.client, checkout, ctx.cfg.chain.id) : null);
  if (orders) await syncOrders(ctx, orders);
  if (!reader) return { families: null, started: [] };
  const families = await syncVotes(reader);
  await syncForks(ctx, reader);
  const ready = await ctx.db.select().from(ventureForks).where(eq(ventureForks.status, "triggered"));
  const started: string[] = [];
  for (const f of ready) {
    const v = await startForkBuild(rt, f.forkId);
    if (v) started.push(v);
  }
  return { families, started };
}

/** Writes a venture's events as SSE until it ends. `format` "chat" turns them into chat.completion.chunk deltas. */
function eventStream(c: Context, rt: VenturesRuntime, ventureId: string, after: number, format: "events" | "chat" = "events") {
  c.header("content-type", "text/event-stream; charset=utf-8");
  c.header("cache-control", "no-cache");
  c.header("x-accel-buffering", "no");
  return honoStream(c, async (s) => {
    const created = Math.floor(Date.now() / 1000);
    const line = (e: VentureEvent): string | null => {
      if (e.type === "step") return `${e.state === "RUNNING" ? "▶" : e.state === "DONE" ? "✓" : e.state === "FAILED" ? "✗" : "·"} ${e.role} · ${e.step} ${e.state.toLowerCase()}${e.error ? `: ${e.error}` : ""}\n`;
      if (e.type === "candidate") return `  ${e.chosen ? "★" : "·"} ${e.family}: ${e.passRate === null ? "no result" : `${Math.round(e.passRate * 100)}% tests`}${e.refused ? " (refused, rerouted)" : ""}\n`;
      if (e.type === "log" && e.message !== "__end__") return `  ${e.message}\n`;
      if (e.type === "venture") return `Venture ${e.status.toLowerCase()} · $${e.costUsd.toFixed(4)} used\n`;
      return null;
    };
    const queue: { id: number; event: VentureEvent }[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const sub = rt.events.subscribe(ventureId, after, (n) => {
      if (n.id === -1) ended = true;
      else queue.push(n);
      wake?.();
    });
    if (sub.closed) ended = true;
    s.onAbort(() => {
      sub.unsubscribe();
      ended = true;
      wake?.();
    });
    const ping = setInterval(() => void s.write(": ping\n\n").catch(() => undefined), 15_000);
    try {
      while (true) {
        while (queue.length) {
          const n = queue.shift()!;
          if (format === "events") await s.write(`id: ${n.id}\nevent: ${n.event.type}\ndata: ${JSON.stringify(n.event)}\n\n`);
          else {
            const text = line(n.event);
            if (text) await s.write(`data: ${JSON.stringify({ id: ventureId, object: "chat.completion.chunk", created, model: SWARM_MODEL, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
          }
        }
        if (ended) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      if (format === "chat") {
        await s.write(`data: ${JSON.stringify({ id: ventureId, object: "chat.completion.chunk", created, model: SWARM_MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        await s.write("data: [DONE]\n\n");
      } else await s.write(`event: end\ndata: {}\n\n`);
    } finally {
      clearInterval(ping);
      sub.unsubscribe();
    }
  });
}

/** model "anonymo-swarm" on the chat endpoint. Mounted ahead of the chat routes (one line in app.ts). */
export function swarmMiddleware(ctx: Ctx, app: Hono): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const body = (await c.req.json().catch(() => null)) as Record<string, any> | null;
    if (body?.model !== SWARM_MODEL) return next();
    const rt = venturesRuntime(app, ctx);
    const key = await requireKey(ctx, c.req.header("authorization"));
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = [...msgs].reverse().find((m: any) => m?.role === "user");
    const brief = typeof last?.content === "string" ? last.content : Array.isArray(last?.content) ? last.content.map((p: any) => p?.text ?? "").join(" ") : "";
    const opts = (body.swarm ?? body.venture ?? {}) as Record<string, unknown>;
    const parsed = CreateBody.safeParse({ mode: "IDEA_TO_LIVE", ...opts, brief: (opts.brief as string) ?? brief });
    if (!parsed.success) fail(400, `swarm: ${parsed.error.issues[0]?.message ?? "bad options"}`, "invalid_request");
    const v = await startVenture(rt, key, parsed.data!);
    if (body.stream) return eventStream(c, rt, v.id, 0, "chat");
    const { done: _done, ...data } = v;
    return c.json({
      id: v.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: SWARM_MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `The crew is on it: ${v.mode.toLowerCase().replaceAll("_", " ")} run ${v.id}, ${v.steps.length} steps, $${v.price_usd} all-in. Follow it at ${v.events} or GET /v1/ventures/${v.id}.` } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      venture: data,
    });
  };
}

export function ventureRoutes(app: Hono, ctx: Ctx) {
  const rt = venturesRuntime(app, ctx);
  const own = owned(rt);
  registerVentureJobs(ctx, rt);
  ctx.jobs.register("ventures-chain", 10 * 60_000, () => syncChain(rt));

  app.get("/v1/ventures/pricing", (c) => c.json({ data: { ...priceList(), launch_lines: LAUNCH_LINES } }));

  app.get("/v1/ventures/tier", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const t = await tierOfKey(ctx, key.keyHash);
    return c.json({ data: { ...t, rules: TIER_RULES[t.tier as Tier] } });
  });

  app.post("/v1/ventures", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) fail(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid_request");
    const { done: _done, ...data } = await startVenture(rt, key, parsed.data!);
    return c.json({ data }, 201);
  });

  app.get("/v1/ventures", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const rows = await ctx.db.select().from(ventures).where(eq(ventures.keyHash, key.keyHash)).orderBy(desc(ventures.createdAt)).limit(100);
    const data = await Promise.all(rows.map(async (v) => {
      const i = await loadInput(ctx, v);
      return { id: v.id, mode: v.mode, status: v.status, tier: v.tier, price_usd: usd(v.priceUsd), cost_usd: usd(v.costUsd), brand: i.brand ?? null, brief: i.brief ? i.brief.slice(0, 140) : null, created_at: v.createdAt.toISOString(), repo: v.repoUrl };
    }));
    return c.json({ data });
  });

  app.get("/v1/ventures/:id", async (c) => {
    const { v } = await own(c);
    const snap = await ventureSnapshot(ctx, v.id);
    const [rm] = await ctx.db.select().from(ventureRunMode).where(eq(ventureRunMode.ventureId, v.id));
    return c.json({ data: { ...snap, run_mode: rm ? { enabled: rm.enabled, daily_cap_usd: usd(rm.dailyCap), hours_per_day: rm.hoursPerDay, tasks: rm.tasks, spent_today_usd: usd(rm.spentToday), ticks_today: rm.ticksToday, next_tick_at: rm.nextTickAt?.toISOString() ?? null, last_brief: await tryJson(ctx.db, v.id, rm.lastBriefSha, "CLEAN") } : null } });
  });

  app.get("/v1/ventures/:id/events", async (c) => {
    const { v } = await own(c);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;
    if (!rt.events.history(v.id).length && !["QUEUED", "RUNNING"].includes(v.status)) {
      // Nothing in memory (finished before this process started): one snapshot event, then the end.
      rt.events.emit({ type: "venture", ventureId: v.id, status: v.status as never, at: v.updatedAt.toISOString(), costUsd: usd(v.costUsd) });
    }
    return eventStream(c, rt, v.id, after);
  });

  app.get("/v1/ventures/:id/artifacts", async (c) => {
    const { v } = await own(c);
    return c.json({ data: (await listArtifacts(ctx.db, v.id)).map((a) => ({ sha256: a.sha256, kind: a.kind, zone: a.zone, name: a.name, mime: a.mime, size: a.size, purged: a.purged, created_at: a.createdAt.toISOString() })) });
  });

  app.get("/v1/ventures/:id/artifacts/:sha", async (c) => {
    const { v } = await own(c);
    // The owner gets CLEAN bodies only. SCOUT artifacts are third-party pages and bundles: their hashes are in the
    // receipt, but the gateway does not republish them.
    const a = await getArtifact(ctx.db, v.id, c.req.param("sha"), "CLEAN").catch((e) => {
      if (e?.constructor?.name === "ZoneViolation") fail(403, "Scout artifacts are listed by hash only.", "scout_zone");
      throw e;
    });
    if (!a) fail(404, "Artifact not found.", "not_found");
    if (a!.body === null) fail(410, "This artifact was purged after 30 days; only its hash remains.", "purged");
    const isHtml = a!.mime.startsWith("text/html");
    return new Response(a!.body as string | Uint8Array<ArrayBuffer>, {
      headers: {
        "content-type": `${a!.mime}${a!.mime.startsWith("text/") || a!.mime.includes("json") ? "; charset=utf-8" : ""}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=60",
        ...(isHtml ? { "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:" } : {}),
      },
    });
  });

  app.get("/v1/ventures/:id/receipt", async (c) => {
    const { v } = await own(c);
    return c.json({ data: await receiptBundle(ctx, v.id) });
  });

  app.get("/v1/ventures/:id/export", async (c) => {
    const { v } = await own(c);
    const tar = await exportTarball(rt.deps.services.repoRoot as string | undefined, v.id);
    if (!tar) fail(404, "This run has no repo yet.", "no_repo");
    return new Response(tar as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${v.id}.tar.gz"` } });
  });

  app.post("/v1/ventures/:id/push", async (c) => {
    const { v } = await own(c);
    const b = (await c.req.json().catch(() => ({}))) as { remote?: string; branch?: string; token?: string; username?: string };
    if (!b.remote) fail(400, "remote is required.", "invalid_request");
    const r = await pushToRemote(rt.deps.services.repoRoot as string | undefined, v.id, b.remote!, { branch: b.branch, token: b.token, username: b.username });
    if (!r.ok) fail(502, `push failed: ${r.error}`, "push_failed");
    return c.json({ data: { pushed: true, branch: b.branch ?? "main" } });
  });

  app.post("/v1/ventures/:id/cancel", async (c) => {
    const { v } = await own(c);
    cancelVenture(v.id);
    return c.json({ data: { id: v.id, cancelling: true } });
  });

  app.post("/v1/ventures/:id/run-mode", async (c) => {
    const { key, v } = await own(c);
    const b = (await c.req.json().catch(() => ({}))) as { daily_cap_usd?: number; tasks?: string[]; target_url?: string };
    if (b.target_url) {
      const p = targetProblem(b.target_url, !!rt.deps.services.allowPrivateTargets);
      if (p) fail(400, p, "invalid_request");
    }
    const id = await enableRunMode(ctx, { parentId: v.id, ownerKeyHash: key.keyHash, ownerAccountId: key.accountId, dailyCapUsd: Number(b.daily_cap_usd), tasks: (b.tasks ?? ["improve", "ads", "brief"]) as RunTask[], target: b.target_url ?? null, now: (rt.deps.now ?? (() => new Date()))() });
    return c.json({ data: { id, tasks: b.tasks ?? ["improve", "ads", "brief"], available_tasks: RUN_TASKS } }, 201);
  });

  app.delete("/v1/ventures/:id/run-mode", async (c) => {
    const { key, v } = await own(c);
    await disableRunMode(ctx, v.id, key.keyHash);
    return c.json({ data: { id: v.id, enabled: false } });
  });

  app.post("/v1/ventures/:id/support-reply", async (c) => {
    const { v } = await own(c);
    if (v.mode !== "RUN" || !v.crewKeyEnc) fail(400, "Support drafts run on a Run Mode venture.", "invalid_request");
    const b = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (!b.message?.trim()) fail(400, "message is required.", "invalid_request");
    const pool = crewPool(ctx);
    if (!pool.length) fail(503, "No model family is available.", "crew_unavailable");
    const llm = rt.deps.llmFor?.(v) ?? inProcessLlm(app, ctx, crewSecret(ctx, v.crewKeyEnc!));
    const draft = await draftSupportReply(llm, pool[0]!.model, (await loadInput(ctx, v)).brand ?? "the product", b.message!);
    return c.json({ data: { draft } });
  });

  app.post("/v1/ventures/:id/recipe", async (c) => {
    const { key, v } = await own(c);
    const b = (await c.req.json().catch(() => ({}))) as { title?: string; summary?: string; price_usd?: number };
    const t = await tierOfKey(ctx, key.keyHash);
    const [k] = await ctx.db.select({ wallet: anonymoKeys.wallet }).from(anonymoKeys).where(eq(anonymoKeys.keyHash, key.keyHash));
    const r = await saveRecipe(ctx, { ventureId: v.id, ownerKeyHash: key.keyHash, ownerAccountId: key.accountId, wallet: k?.wallet ?? null, tier: t.tier, title: b.title ?? "", summary: b.summary ?? "", priceUsd: Number(b.price_usd ?? 0) });
    return c.json({ data: r }, 201);
  });

  app.get("/v1/recipes", async (c) => c.json({ data: await listRecipes(ctx) }));
  app.get("/v1/recipes/:id", async (c) => {
    const r = await loadRecipe(ctx, c.req.param("id"));
    if (!r) fail(404, "Recipe not found.", "not_found");
    return c.json({ data: recipeJson(r!) });
  });

  app.get("/v1/forks", async (c) => {
    const rows = await ctx.db.select().from(ventureForks).orderBy(desc(ventureForks.updatedAt)).limit(100);
    return c.json({ data: rows.map((f) => ({ fork_id: f.forkId, chain_id: f.chainId, target_commit: f.targetCommit, status: f.status, target_registered: !!f.targetEnc, venture_id: f.ventureId, repo_hash: f.repoHash, receipt_root: f.receiptRoot })) });
  });

  app.post("/v1/forks/:id/target", async (c) => {
    await requireKey(ctx, c.req.header("authorization"));
    const b = (await c.req.json().catch(() => ({}))) as { url?: string; salt?: string };
    if (!b.url || !b.salt || !/^0x[0-9a-f]{64}$/i.test(b.salt)) fail(400, "url and a 32-byte hex salt are required.", "invalid_request");
    const p = targetProblem(b.url!, !!rt.deps.services.allowPrivateTargets);
    if (p) fail(400, p, "invalid_request");
    if (!(await registerForkTarget(ctx, c.req.param("id"), b.url!, b.salt as Hex))) fail(409, "The url and salt do not match this fork's on-chain commitment.", "commitment_mismatch");
    return c.json({ data: { fork_id: c.req.param("id"), registered: true } });
  });
}

export { ApiError };

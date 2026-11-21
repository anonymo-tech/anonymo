// WS11 · Recipes (Ventures Overview §3 "Recipes", Backend PART 10 RecipeRegistry).
//
// A Recipe is a pipeline that worked: the step DAG of a finished venture (tasks, roles, fan-out, select modes, budget
// shares), never its content. Its creator can sell it in USDG (Gang tier and above). Running one charges the mode's
// price plus the recipe's price; the creator is credited the worker share (80%) of the recipe price per run, and the
// rest goes to the ventures house account (treasury, staker credits and buy-and-burn are split on chain by FeeRouter).
//
// A recipe can't weaken the firewall: every step is checked against the task registry, so a recipe can't put a
// builder in the SCOUT zone, give a CLEAN step a SCOUT input, or add a deploy step to a mode that has a target.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Ctx } from "../../context.ts";
import { ensureAccount, post } from "../../ledger/ledger.ts";
import { fail } from "../../lib/errors.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import { uid } from "../../lib/util.ts";
import { assertAcyclic, type StepTemplate } from "./orchestrator.ts";
import { HOUSE_ACCOUNT } from "./money.ts";
import { TIER_RULES } from "./pricing.ts";
import { ventureRecipeRuns, ventureRecipes, ventureSteps, ventures } from "./store/schema.ts";
import type { Role, Tier, VentureMode, Zone } from "./types.ts";

/** Every task a step may run, with the only role and zone it may run in. */
export const TASKS: Record<string, { role: Role; zone: Zone; targetOnly?: boolean; noTargetOnly?: boolean }> = {
  "scout.site": { role: "scout", zone: "SCOUT", targetOnly: true },
  "spec.filter": { role: "spec-filter", zone: "SCOUT", targetOnly: true },
  "strategist.research": { role: "strategist", zone: "CLEAN" },
  "strategist.plan": { role: "strategist", zone: "CLEAN" },
  "strategist.parity": { role: "strategist", zone: "CLEAN" },
  "strategist.launch": { role: "strategist", zone: "CLEAN" },
  "strategist.fork-plan": { role: "strategist", zone: "CLEAN" },
  "designer.system": { role: "designer", zone: "CLEAN" },
  "designer.landing": { role: "designer", zone: "CLEAN" },
  "adman.landing": { role: "adman", zone: "CLEAN" },
  "adman.adkit": { role: "adman", zone: "CLEAN" },
  "adman.comparison": { role: "adman", zone: "CLEAN" },
  "adman.switch": { role: "adman", zone: "CLEAN" },
  "adman.takeover-ads": { role: "adman", zone: "CLEAN" },
  "tester.tests": { role: "tester", zone: "CLEAN" },
  "tester.import": { role: "tester", zone: "CLEAN" },
  "builder.app": { role: "builder", zone: "CLEAN" },
  "builder.import": { role: "builder", zone: "CLEAN" },
  "builder.rebrand": { role: "builder", zone: "CLEAN" },
  "redteam.scan": { role: "red-team", zone: "CLEAN" },
  "licence.scan": { role: "licence", zone: "CLEAN" },
  "licence.fork": { role: "licence", zone: "CLEAN" },
  "repo.commit": { role: "boss", zone: "CLEAN" },
  "deployer.static": { role: "deployer", zone: "CLEAN", noTargetOnly: true },
};

const TARGET_MODES: VentureMode[] = ["BUILD_BETTER", "TAKEOVER"];
export const CREATOR_SHARE_BPS = 8_000n;

/** Throws unless every step of a DAG is a known task in its own role and zone, the zones are wired legally, and no
 *  deploy step rides on a target. */
export function validateDag(mode: VentureMode, dag: StepTemplate[]) {
  if (!dag.length || dag.length > 40) fail(400, "A recipe has 1 to 40 steps.", "invalid_recipe");
  const keys = new Set<string>();
  for (const s of dag) {
    const t = TASKS[s.task];
    if (!t) fail(400, `Unknown task ${s.task}.`, "invalid_recipe");
    if (!/^[a-z0-9-]{1,40}$/.test(s.key) || keys.has(s.key)) fail(400, `Bad or repeated step key ${s.key}.`, "invalid_recipe");
    keys.add(s.key);
    if (s.role !== t!.role || s.zone !== t!.zone) fail(400, `Task ${s.task} must run as ${t!.role} in the ${t!.zone} zone.`, "invalid_recipe");
    if (t!.targetOnly && !TARGET_MODES.includes(mode)) fail(400, `${s.task} only runs in modes with a target.`, "invalid_recipe");
    if (t!.noTargetOnly && TARGET_MODES.includes(mode)) fail(400, "Modes with a target can't deploy until the Similarity Gate passes.", "invalid_recipe");
    if (!(s.fanout >= 1 && s.fanout <= 8) || !(s.share > 0 && s.share <= 1)) fail(400, `Bad fan-out or budget share on ${s.key}.`, "invalid_recipe");
  }
  const byKey = new Map(dag.map((s) => [s.key, s]));
  for (const s of dag)
    for (const n of s.needs) {
      const dep = byKey.get(n);
      if (!dep) fail(400, `${s.key} needs unknown step ${n}.`, "invalid_recipe");
      // A CLEAN step may only need a SCOUT-zone step if that step is the Spec Filter (whose only outputs are CLEAN).
      if (s.zone === "CLEAN" && dep!.zone === "SCOUT" && dep!.task !== "spec.filter") fail(400, `${s.key} (CLEAN) can't take input from ${n} (SCOUT).`, "invalid_recipe");
    }
  try {
    assertAcyclic(dag);
  } catch (e) {
    fail(400, (e as Error).message, "invalid_recipe");
  }
}

const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null));

export const recipeHashOf = (mode: string, dag: StepTemplate[], creator: string) => "0x" + createHash("sha256").update(canonical({ mode, dag, creator })).digest("hex");

/** Turns a finished venture's steps back into a DAG template. */
export async function dagOfVenture(ctx: Ctx, ventureId: string): Promise<StepTemplate[]> {
  const rows = await ctx.db.select().from(ventureSteps).where(eq(ventureSteps.ventureId, ventureId)).orderBy(ventureSteps.position);
  const [v] = await ctx.db.select({ caps: ventures.caps }).from(ventures).where(eq(ventures.id, ventureId));
  const total = (v?.caps as { total: number } | undefined)?.total || 1;
  return rows.map((r) => ({ key: r.key, task: (r.inputs as { task: string }).task, role: r.role as Role, kind: r.kind as StepTemplate["kind"], zone: r.zone as Zone, fanout: r.fanout, select: r.selectMode as StepTemplate["select"], needs: r.needs, share: Math.min(1, Math.max(0.01, +(Number(r.capUsd) / 1e12 / total).toFixed(3))), ...((r.inputs as { optional?: boolean }).optional ? { optional: true } : {}) }));
}

export async function saveRecipe(ctx: Ctx, o: { ventureId: string; ownerKeyHash: string; ownerAccountId: string; wallet: string | null; tier: Tier; title: string; summary: string; priceUsd: number }) {
  const [v] = await ctx.db.select().from(ventures).where(and(eq(ventures.id, o.ventureId), eq(ventures.keyHash, o.ownerKeyHash)));
  if (!v) fail(404, "Venture not found.", "not_found");
  if (v!.status !== "DONE") fail(409, "Only a finished run can become a Recipe.", "venture_not_done");
  if (o.priceUsd > 0 && !TIER_RULES[o.tier].recipeSelling) fail(403, "Selling Recipes needs the Gang tier or above.", "tier_required");
  if (!(o.priceUsd >= 0 && o.priceUsd <= 500)) fail(400, "price_usd must be between 0 and 500.", "invalid_request");
  const title = o.title.trim().slice(0, 80);
  if (!title) fail(400, "A Recipe needs a title.", "invalid_request");
  const dag = await dagOfVenture(ctx, o.ventureId);
  validateDag(v!.mode as VentureMode, dag);
  const recipeHash = recipeHashOf(v!.mode, dag, o.ownerKeyHash);
  const id = uid("rcp_");
  const inserted = await ctx.db
    .insert(ventureRecipes)
    .values({ id, creatorKeyHash: o.ownerKeyHash, creatorAccountId: o.ownerAccountId, creatorWallet: o.wallet, title, summary: o.summary.trim().slice(0, 400), mode: v!.mode, dag, recipeHash, priceUsdg: usdToPico(o.priceUsd), sourceVentureId: o.ventureId })
    .onConflictDoNothing()
    .returning({ id: ventureRecipes.id });
  if (!inserted.length) fail(409, "This pipeline is already a Recipe.", "recipe_exists");
  return { id, recipeHash };
}

export const recipeJson = (r: typeof ventureRecipes.$inferSelect) => ({ id: r.id, title: r.title, summary: r.summary, mode: r.mode, steps: (r.dag as StepTemplate[]).map((s) => ({ key: s.key, task: s.task, role: s.role, fanout: s.fanout })), price_usd: Number(r.priceUsdg) / 1e12, runs: r.runs, recipe_hash: r.recipeHash, created_at: r.createdAt.toISOString() });

export async function listRecipes(ctx: Ctx, limit = 50) {
  return (await ctx.db.select().from(ventureRecipes).where(eq(ventureRecipes.published, true)).orderBy(desc(ventureRecipes.runs), desc(ventureRecipes.createdAt)).limit(limit)).map(recipeJson);
}

export async function loadRecipe(ctx: Ctx, id: string) {
  const [r] = await ctx.db.select().from(ventureRecipes).where(and(eq(ventureRecipes.id, id), eq(ventureRecipes.published, true)));
  return r ?? null;
}

/** Pays the creator their share of one run, once per order (venture). */
export async function payRecipeRun(ctx: Ctx, recipe: typeof ventureRecipes.$inferSelect, ventureId: string, payer: { keyHash: string; accountId: string }): Promise<Pico> {
  const price = recipe.priceUsdg;
  const share = (price * CREATOR_SHARE_BPS) / 10_000n;
  const ref = `recipe:${recipe.id}:${ventureId}`;
  await ctx.db.transaction(async (tx) => {
    if (price > 0n) {
      const fresh = await post(tx, { accountId: payer.accountId, keyHash: payer.keyHash, amount: -price, kind: "recipe_purchase", ref: `${ref}:buy` });
      if (!fresh) return;
      await ensureAccount(tx, recipe.creatorAccountId);
      await post(tx, { accountId: recipe.creatorAccountId, amount: share, kind: "recipe_payout", ref: `${ref}:creator` });
      await ensureAccount(tx, HOUSE_ACCOUNT, "house");
      if (price - share > 0n) await post(tx, { accountId: HOUSE_ACCOUNT, amount: price - share, kind: "recipe_fee", ref: `${ref}:house` });
    }
    const inserted = await tx.insert(ventureRecipeRuns).values({ orderRef: ref, recipeId: recipe.id, ventureId, creatorShare: share }).onConflictDoNothing().returning({ r: ventureRecipeRuns.orderRef });
    if (inserted.length) await tx.update(ventureRecipes).set({ runs: sql`${ventureRecipes.runs} + 1`, earned: sql`${ventureRecipes.earned} + ${share}` }).where(eq(ventureRecipes.id, recipe.id));
  });
  return share;
}

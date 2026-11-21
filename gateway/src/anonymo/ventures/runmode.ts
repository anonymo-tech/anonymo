// WS11 · Run Mode: the crew keeps operating a venture (Ventures Overview §3 "Run Mode", Backend PART 11 "run-mode").
//
// Turning Run Mode on creates a RUN venture tied to the one it operates. Every hour (up to the tier's hours per day) a
// tick runs the chosen tasks: watch the competitor (re-scout, diff the Spec), propose the next improvement, rotate ads,
// and on Mondays send the brief. Money: the owner sets a hard daily cap. On the first tick of a UTC day the $5 daily
// fee goes to the house account and the crew wallet is topped up to (cap − fee); a tick only starts when budget is
// left, so the crew stops at the daily cap and the next tick waits for the next day (acceptance test 8). Every
// top-up passes the owner key's own caps first (Law 6). Turning Run Mode off deletes the stored target.

import { and, eq, lte } from "drizzle-orm";
import type { Ctx } from "../../context.ts";
import { keys } from "../../db/schema.ts";
import { fail } from "../../lib/errors.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import { decrypt, encrypt, uid } from "../../lib/util.ts";
import { generateApiKey } from "../../chain/keys.ts";
import { registerRootKey } from "../../api/auth.ts";
import { anonymoKeys } from "../deposits/schema.ts";
import { runTickPlan, RUN_TASKS, type RunTask } from "./boss.ts";
import { askJson, askOne } from "./crew/ask.ts";
import { lintCopy, COPY_RULES_PROMPT } from "./copy.ts";
import { scrub } from "./mos/adman.ts";
import { createSteps, loadInput, runVenture, storeInput, type RoleHandler, type VentureDeps } from "./orchestrator.ts";
import { crewAvailable, topUpCrewWallet } from "./money.ts";
import { RUN_MODE, TIER_RULES } from "./pricing.ts";
import { getText, putArtifact, tryJson } from "./store/artifacts.ts";
import { ventureRunMode, ventureSpecs, ventureSteps, ventures } from "./store/schema.ts";
import type { Spec, Tier } from "./types.ts";

const HOUR = 3_600_000;
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const nextUtcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));

export type EnableInput = { parentId: string; ownerKeyHash: string; ownerAccountId: string; dailyCapUsd: number; tasks: RunTask[]; target?: string | null; now: Date };

export async function enableRunMode(ctx: Ctx, i: EnableInput) {
  const [parent] = await ctx.db.select().from(ventures).where(and(eq(ventures.id, i.parentId), eq(ventures.keyHash, i.ownerKeyHash)));
  if (!parent) fail(404, "Venture not found.", "not_found");
  if (parent!.mode === "RUN") fail(400, "This is already a Run Mode venture.", "invalid_request");
  const tier = TIER_RULES[parent!.tier as Tier];
  if (!tier.runModeHoursPerDay) fail(403, "Run Mode needs the Crew tier or above.", "tier_required");
  if (!(i.dailyCapUsd >= RUN_MODE.minDailyCapUsd && i.dailyCapUsd <= RUN_MODE.maxDailyCapUsd)) fail(400, `daily_cap_usd must be between ${RUN_MODE.minDailyCapUsd} and ${RUN_MODE.maxDailyCapUsd}.`, "invalid_request");
  const tasks = [...new Set(i.tasks)].filter((t) => (RUN_TASKS as readonly string[]).includes(t)) as RunTask[];
  if (!tasks.length) fail(400, `tasks must name at least one of ${RUN_TASKS.join(", ")}.`, "invalid_request");
  if (tasks.includes("watch") && !i.target) fail(400, "The watch task needs target_url (it is kept encrypted only while Run Mode is on).", "invalid_request");

  const id = uid("vr_");
  const secret = generateApiKey();
  const crew = await registerRootKey(ctx, secret, `run mode ${id}`);
  await ctx.db.insert(anonymoKeys).values({ keyHash: crew.keyHash, lifetimeCap: 0n }).onConflictDoNothing();
  await ctx.db.insert(ventures).values({
    id,
    keyHash: i.ownerKeyHash,
    accountId: i.ownerAccountId,
    mode: "RUN",
    targetCommit: parent!.targetCommit,
    tier: parent!.tier,
    caps: { total: i.dailyCapUsd - RUN_MODE.dailyFeeUsd, perStep: i.dailyCapUsd },
    priceUsd: 0n,
    status: "QUEUED",
    crewKeyHash: crew.keyHash,
    crewKeyEnc: encrypt(ctx.cfg.appSecret, secret),
  });
  const parentInput = await loadInput(ctx, parent!);
  await storeInput(ctx, id, { mode: "RUN", brief: parentInput.brief, brand: parentInput.brand, rival: parentInput.rival, parent: parent!.id, tasks });
  // The operated venture's plan and spec come along as CLEAN artifacts, so improve and ads have something to work from.
  for (const step of await ctx.db.select().from(ventureSteps).where(eq(ventureSteps.ventureId, parent!.id))) {
    for (const ref of (step.outputs as { name?: string; zone: string; kind: string; sha256: string }[]) ?? []) {
      if (ref.zone !== "CLEAN" || !["plan", "spec", "ads", "adkit"].includes(ref.name ?? "")) continue;
      const body = await getText(ctx.db, parent!.id, ref as never, "CLEAN").catch(() => null);
      if (body) await putArtifact(ctx.db, id, { kind: ref.kind as never, zone: "CLEAN", name: `parent-${ref.name}`, mime: "application/json", body });
    }
  }
  const [spec] = await ctx.db.select({ sha: ventureSpecs.sha256 }).from(ventureSpecs).where(eq(ventureSpecs.ventureId, parent!.id));
  await ctx.db.insert(ventureRunMode).values({
    ventureId: id,
    enabled: true,
    dailyCap: usdToPico(i.dailyCapUsd),
    hoursPerDay: tier.runModeHoursPerDay,
    tasks,
    nextTickAt: i.now,
    targetEnc: i.target ? encrypt(ctx.cfg.appSecret, i.target) : null,
    lastSpecHash: spec?.sha ?? null,
  });
  return id;
}

export async function disableRunMode(ctx: Ctx, ventureId: string, ownerKeyHash: string) {
  const [v] = await ctx.db.select().from(ventures).where(and(eq(ventures.id, ventureId), eq(ventures.keyHash, ownerKeyHash), eq(ventures.mode, "RUN")));
  if (!v) fail(404, "Run Mode venture not found.", "not_found");
  await ctx.db.update(ventureRunMode).set({ enabled: false, targetEnc: null, nextTickAt: null, updatedAt: new Date() }).where(eq(ventureRunMode.ventureId, ventureId));
  await ctx.db.update(ventures).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(ventures.id, ventureId));
}

export type TickOutcome = { ventureId: string; ran: boolean; reason: string; nextTickAt: string | null; costUsd?: number };

/** Runs every Run Mode venture that is due. Call it from the scheduler, or from a test with a fixed clock. */
export async function runModeTick(deps: VentureDeps, now: Date): Promise<TickOutcome[]> {
  const { ctx } = deps;
  const due = await ctx.db.select().from(ventureRunMode).where(and(eq(ventureRunMode.enabled, true), lte(ventureRunMode.nextTickAt, now)));
  const out: TickOutcome[] = [];
  for (const rm of due) out.push(await tickOne(deps, rm, now));
  return out;
}

async function tickOne(deps: VentureDeps, rm: typeof ventureRunMode.$inferSelect, now: Date): Promise<TickOutcome> {
  const { ctx } = deps;
  const [v] = await ctx.db.select().from(ventures).where(eq(ventures.id, rm.ventureId));
  if (!v || !v.crewKeyHash) return { ventureId: rm.ventureId, ran: false, reason: "missing", nextTickAt: null };
  const [crew] = await ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, v.crewKeyHash));
  const day = utcDay(now);
  const fee = usdToPico(RUN_MODE.dailyFeeUsd);
  let spentToday = rm.day === day ? rm.spentToday : 0n;
  let ticksToday = rm.day === day ? rm.ticksToday : 0;
  const waitTomorrow = async (reason: string) => {
    const next = nextUtcMidnight(now);
    await ctx.db.update(ventureRunMode).set({ day, spentToday, ticksToday, nextTickAt: next, updatedAt: now }).where(eq(ventureRunMode.ventureId, rm.ventureId));
    return { ventureId: rm.ventureId, ran: false, reason, nextTickAt: next.toISOString() };
  };
  if (ticksToday >= rm.hoursPerDay) return waitTomorrow("hours_per_day_reached");
  if (spentToday >= rm.dailyCap) return waitTomorrow("daily_cap_reached");

  // First tick of the day: the fee, and a top-up of the crew wallet to (cap − fee).
  if (rm.day !== day) {
    const have = await crewAvailable(ctx, crew!.accountId);
    const budget = rm.dailyCap - fee;
    const topUp = budget > have ? budget - have : 0n;
    try {
      const ok = await topUpCrewWallet(ctx, { ventureId: v.id, ref: `venture:${v.id}:day:${day}`, ownerKeyHash: v.keyHash, ownerAccountId: v.accountId, crewKeyHash: v.crewKeyHash, crewAccountId: crew!.accountId, amount: topUp + fee, fee });
      if (!ok) return waitTomorrow("owner_balance_too_low");
    } catch {
      return waitTomorrow("owner_key_cap_reached");
    }
    spentToday = fee;
  }
  const remaining = rm.dailyCap - spentToday;
  if (remaining <= 0n) return waitTomorrow("daily_cap_reached");

  const tick = ticksToday + 1;
  const tasks = (rm.tasks as RunTask[]).filter((t) => t !== "brief" || now.getUTCDay() === 1);
  const target = rm.targetEnc ? decrypt(ctx.cfg.appSecret, rm.targetEnc) : null;
  const plan = runTickPlan(Number(`${day.replaceAll("-", "")}${String(tick).padStart(2, "0")}`), tasks, { hasTarget: !!target });
  const remainingUsd = Number(remaining) / 1e12;
  await ctx.db.update(ventures).set({ caps: { total: remainingUsd, perStep: remainingUsd } }).where(eq(ventures.id, v.id));
  const before = v.costUsd;
  if (plan.length) {
    await createSteps(ctx, v.id, plan, remainingUsd, remainingUsd);
    await runVenture(deps, v.id, target);
  }
  const [after] = await ctx.db.select({ cost: ventures.costUsd }).from(ventures).where(eq(ventures.id, v.id));
  const tickCost: Pico = (after?.cost ?? before) - before;
  spentToday += tickCost;
  ticksToday = tick;
  const next = new Date(now.getTime() + HOUR);
  const capped = spentToday >= rm.dailyCap || ticksToday >= rm.hoursPerDay;
  const nextTickAt = capped ? nextUtcMidnight(now) : next;
  await ctx.db.update(ventureRunMode).set({ day, spentToday, ticksToday, nextTickAt, updatedAt: now }).where(eq(ventureRunMode.ventureId, rm.ventureId));
  return { ventureId: v.id, ran: true, reason: capped ? "ran; daily limit reached" : "ran", nextTickAt: nextTickAt.toISOString(), costUsd: Number(tickCost) / 1e12 };
}

// ---- the tick tasks --------------------------------------------------------------------------------------------------

const diffNames = (a: string[], b: string[]) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });

/** Compares the fresh Spec with the last one: features and plans added or removed, prices that moved. */
export function specDiff(prev: Spec | null, next: Spec) {
  const pf = prev?.features.map((f) => f.name) ?? [];
  const nf = next.features.map((f) => f.name);
  const pp = new Map((prev?.pricing.plans ?? []).map((p) => [p.name, p.priceUsdMonthly]));
  const prices = next.pricing.plans.filter((p) => pp.has(p.name) && pp.get(p.name) !== p.priceUsdMonthly).map((p) => ({ plan: p.name, from: pp.get(p.name) ?? null, to: p.priceUsdMonthly }));
  return { features: diffNames(pf, nf), plans: diffNames([...pp.keys()], next.pricing.plans.map((p) => p.name)), prices, changed: !prev || pf.join() !== nf.join() || prices.length > 0 };
}

export const watchTask: RoleHandler = async (s) => {
  const specRef = Object.values(s.needs).flat().find((r) => r.name === "spec");
  if (!specRef) throw new Error("no fresh spec");
  const next = await s.json<Spec>(specRef);
  const [rm] = await s.ctx.db.select().from(ventureRunMode).where(eq(ventureRunMode.ventureId, s.venture.id));
  let prev: Spec | null = null;
  if (rm?.lastSpecHash) {
    const [row] = await s.ctx.db.select({ ventureId: ventureSpecs.ventureId }).from(ventureSpecs).where(eq(ventureSpecs.sha256, rm.lastSpecHash));
    prev = row ? await tryJson<Spec>(s.ctx.db, row.ventureId, rm.lastSpecHash, "CLEAN") : null;
  }
  const diff = specDiff(prev, next);
  await s.put({ kind: "report", name: "watch", mime: "application/json", body: JSON.stringify({ at: s.now().toISOString(), spec: specRef.sha256, ...diff }) });
  await s.ctx.db.update(ventureRunMode).set({ lastSpecHash: specRef.sha256 }).where(eq(ventureRunMode.ventureId, s.venture.id));
  s.log(diff.changed ? `competitor changed: +${diff.features.added.length}/−${diff.features.removed.length} features, ${diff.prices.length} price change(s)` : "competitor unchanged");
};

async function parentArtifact(s: Parameters<RoleHandler>[0], name: string) {
  const { listArtifacts } = await import("./store/artifacts.ts");
  const row = (await listArtifacts(s.ctx.db, s.venture.id)).find((a) => a.name === name && a.zone === "CLEAN" && !a.purged);
  return row ? s.text({ sha256: row.sha256, kind: row.kind as never, zone: "CLEAN", name }) : null;
}

export const improveTask: RoleHandler = async (s) => {
  const plan = (await parentArtifact(s, "parent-plan")) ?? "{}";
  const { value } = await askJson<{ title: string; why: string; acceptance: string[] }>(s, [
    { role: "system", content: `You are Strategist Mo running a live venture week to week. ${COPY_RULES_PROMPT} Reply with JSON only.` },
    { role: "user", content: `Plan:\n${plan.slice(0, 6000)}\n\nPropose the single most valuable improvement to ship this week. JSON: {"title":"…","why":"…","acceptance":["testable criteria"]}` },
  ], { select: "single", maxTokens: 800 });
  await s.put({ kind: "plan", name: "improvement", mime: "application/json", body: JSON.stringify(value) });
};

export const adsTask: RoleHandler = async (s) => {
  const plan = (await parentArtifact(s, "parent-plan")) ?? "{}";
  const { value } = await askJson<{ ads: { channel: string; headline: string; body: string; cta: string }[] }>(s, [
    { role: "system", content: `You are Adman Mo. ${COPY_RULES_PROMPT} Reply with JSON only.` },
    { role: "user", content: `Plan:\n${plan.slice(0, 5000)}\n\nWrite 5 fresh ad variants to rotate in this week. JSON: {"ads":[{"channel":"x|reddit|meta|google","headline":"…","body":"…","cta":"…"}]}` },
  ], { select: "single", maxTokens: 1200 });
  const { value: clean } = scrub(value);
  await s.put({ kind: "copy", name: "ads-rotation", mime: "application/json", body: JSON.stringify(clean) });
};

export const briefTask: RoleHandler = async (s) => {
  const since = new Date(s.now().getTime() - 7 * 86_400_000);
  const steps = (await s.ctx.db.select().from(ventureSteps).where(eq(ventureSteps.ventureId, s.venture.id))).filter((x) => (x.endedAt ?? x.startedAt ?? new Date(0)) >= since);
  const facts = { ticks: new Set(steps.map((x) => x.key.split("-")[0])).size, done: steps.filter((x) => x.state === "DONE").length, failed: steps.filter((x) => x.state === "FAILED").length, costUsd: steps.reduce((n, x) => n + Number(x.costUsd) / 1e12, 0), tasks: [...new Set(steps.map((x) => x.key.split("-").slice(1).join("-")))] };
  const watch = Object.values(s.needs).flat().find((r) => r.name === "watch");
  const r = await askOne(s, [
    { role: "system", content: `You are Boss Mo writing the Monday brief: five short bullet points, plain and specific. ${COPY_RULES_PROMPT}` },
    { role: "user", content: `This week's facts: ${JSON.stringify(facts)}\nCompetitor watch: ${watch ? await s.text(watch) : "none"}\nWrite the brief.` },
  ], { maxTokens: 600 });
  const text = lintCopy(r.text).length ? "This week's brief was withheld: it broke the copy rules." : r.text;
  const brief = { at: s.now().toISOString(), facts, text };
  const ref = await s.put({ kind: "report", name: "brief", mime: "application/json", body: JSON.stringify(brief) });
  await s.ctx.db.update(ventureRunMode).set({ lastBriefSha: ref.sha256 }).where(eq(ventureRunMode.ventureId, s.venture.id));
};

/** Drafts a support reply for a message the owner pastes in. Nothing is stored. */
export async function draftSupportReply(llm: Parameters<RoleHandler>[0]["llm"], model: string, product: string, message: string): Promise<string> {
  const r = await llm.call({ model, maxTokens: 500, messages: [
    { role: "system", content: `You draft friendly, short support replies for ${product}. Never promise refunds or features that are not in the product. ${COPY_RULES_PROMPT}` },
    { role: "user", content: message.slice(0, 4000) },
  ] });
  return r.text;
}

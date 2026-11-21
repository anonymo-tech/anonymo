// WS11 · venture-orchestrator (Ventures Backend PART 1 and PART 3).
//
// A venture is a DAG of steps. Boss Mo (boss.ts) writes the DAG and the budget per step; this file runs it: every step
// whose needs are done starts at once, its model calls go through the gateway with the run's crew key (crew/caller.ts),
// its cost is counted against its own cap and the run's cap before every call (Law 6), and its outputs are stored as
// zoned artifacts. Zones are enforced here as well as in the sandbox mount table: a CLEAN step can only read CLEAN
// artifacts, and only SCOUT steps ever see the target url (Law 1). A floor block (451) or an exhausted cap stops the
// whole run; any other failure fails its step, and steps that needed it are skipped.

import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../../context.ts";
import { keys } from "../../db/schema.ts";
import { uid } from "../../lib/util.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import { inProcessLlm } from "./crew/caller.ts";
import { crewPool, type CrewModel } from "./crew/families.ts";
import type { VentureEvents } from "./events.ts";
import { CrewCallError, type CrewCall, type CrewReply, type Llm } from "./llm.ts";
import { crewSecret, HOUSE_ACCOUNT, settleCrewWallet } from "./money.ts";
import { TIER_RULES, type TierRules } from "./pricing.ts";
import { getJson, getText, putArtifact, tryJson, type PutInput } from "./store/artifacts.ts";
import { ventureCandidates, ventureSteps, ventures } from "./store/schema.ts";
import type { ArtifactRef, Kind, Role, Select, StepState, Tier, VentureMode, VentureStatus, Zone } from "./types.ts";

export type StepTemplate = {
  key: string;
  /** The handler that does the work, e.g. "scout.site", "strategist.parity". */
  task: string;
  role: Role;
  kind: Kind;
  zone: Zone;
  fanout: number;
  select: Select;
  needs: string[];
  /** Share of the run's budget this step may use (the per-step cap also applies). */
  share: number;
  /** A failed optional step does not fail the venture. */
  optional?: boolean;
};

export type VentureRow = typeof ventures.$inferSelect;
export type StepRow = typeof ventureSteps.$inferSelect;

export type VentureInput = {
  mode: VentureMode;
  brief: string;
  brand?: string;
  repo?: string;
  publishSource?: boolean;
  deploy?: { domain?: string; ens?: string; arns?: string; ensResolver?: string };
  rival?: string;
  [k: string]: unknown;
};

export class StepCapReached extends Error {}

/** Stores a venture's brief and options as its CLEAN "input" artifact (bodies never go into Postgres). */
export async function storeInput(ctx: Ctx, ventureId: string, input: VentureInput): Promise<string> {
  const ref = await putArtifact(ctx.db, ventureId, { kind: "report", zone: "CLEAN", name: "input", mime: "application/json", body: JSON.stringify(input) });
  await ctx.db.update(ventures).set({ inputSha256: ref.sha256 }).where(eq(ventures.id, ventureId));
  return ref.sha256;
}

/** The venture's brief and options, or a bare input once its artifacts were deleted after 30 days. */
export async function loadInput(ctx: Ctx, v: Pick<VentureRow, "id" | "mode" | "inputSha256">): Promise<VentureInput> {
  return (await tryJson<VentureInput>(ctx.db, v.id, v.inputSha256, "CLEAN")) ?? { mode: v.mode as VentureMode, brief: "" };
}

export type CandidateRecord = { family: string; model: string; passRate: number | null; lintErrors?: number; typeErrors?: number; bundleBytes?: number; refused: boolean; chosen: boolean; receiptId: string | null; costUsd: number; error?: string };

export type StepContext = {
  ctx: Ctx;
  deps: VentureDeps;
  venture: VentureRow;
  input: VentureInput;
  step: StepRow;
  tier: TierRules;
  llm: Llm;
  /** Model families available to this run (one cheapest model each). */
  pool: CrewModel[];
  /** The target url: set only for SCOUT steps. */
  target: string | null;
  /** The target's hostnames, for sandbox egress deny lists only. Never put into a prompt or an artifact. */
  denyHosts: string[];
  /** Outputs of the steps this one needs, by step key. */
  needs: Record<string, ArtifactRef[]>;
  /** The first output of a needed step with this name (or kind), or throws. */
  need(stepKey: string, name?: string): ArtifactRef;
  text(ref: ArtifactRef): Promise<string>;
  json<T>(ref: ArtifactRef): Promise<T>;
  put(a: Omit<PutInput, "zone"> & { zone?: Zone }): Promise<ArtifactRef>;
  log(message: string): void;
  candidate(c: CandidateRecord): Promise<void>;
  /** Adds a non-model cost (sandbox minutes) to the step. Returns false if it does not fit the budget. */
  charge(usd: number, ref: string): Promise<boolean>;
  remainingUsd(): number;
  now(): Date;
  signal: AbortSignal;
};

export type RoleHandler = (s: StepContext) => Promise<void>;

export type VentureDeps = {
  app: Hono;
  ctx: Ctx;
  events: VentureEvents;
  handlers: Record<string, RoleHandler>;
  now?: () => Date;
  /** Charges a non-model cost to the crew account (money.ts chargeCrew). */
  chargeCrew?: (v: VentureRow, usd: number, ref: string) => Promise<boolean>;
  /** Extra services handlers use (sandbox pool, scout fetch, deploy config, gate, repo root...). */
  services: Record<string, unknown>;
  /** Override the Llm (tests); default calls the gateway in process with the crew key. */
  llmFor?: (v: VentureRow) => Llm;
};

const at = (d: VentureDeps) => (d.now ?? (() => new Date()))().toISOString();

/** Writes the DAG's steps for a venture, with per-step caps, as QUEUED. */
export async function createSteps(ctx: Ctx, ventureId: string, plan: StepTemplate[], totalUsd: number, perStepUsd: number) {
  const keys = new Set(plan.map((s) => s.key));
  for (const s of plan) for (const n of s.needs) if (!keys.has(n)) throw new Error(`step ${s.key} needs unknown step ${n}`);
  assertAcyclic(plan);
  const rows = plan.map((s, i) => ({
    id: uid("st_"),
    ventureId,
    key: s.key,
    role: s.role,
    kind: s.kind,
    zone: s.zone,
    fanout: s.fanout,
    selectMode: s.select,
    needs: s.needs,
    state: "QUEUED",
    capUsd: usdToPico(Math.min(perStepUsd, totalUsd * s.share).toFixed(6), "floor"),
    receiptIds: [] as string[],
    inputs: { task: s.task, optional: !!s.optional } as Record<string, unknown>,
    outputs: [] as ArtifactRef[],
    position: i,
  }));
  if (rows.length) await ctx.db.insert(ventureSteps).values(rows);
  return rows;
}

export function assertAcyclic(plan: Pick<StepTemplate, "key" | "needs">[]) {
  const byKey = new Map(plan.map((s) => [s.key, s]));
  const state = new Map<string, 1 | 2>();
  const visit = (k: string, path: string[]) => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) throw new Error(`step DAG has a cycle: ${[...path, k].join(" → ")}`);
    state.set(k, 1);
    for (const n of byKey.get(k)?.needs ?? []) visit(n, [...path, k]);
    state.set(k, 2);
  };
  for (const s of plan) visit(s.key, []);
}

/** Rule of Law 1 for zones: a CLEAN step can never take a SCOUT artifact as input. */
export function checkZoneInputs(step: Pick<StepRow, "zone" | "key">, inputs: ArtifactRef[]) {
  if (step.zone !== "CLEAN") return;
  const bad = inputs.find((r) => r.zone === "SCOUT");
  if (bad) throw new Error(`zone violation: CLEAN step ${step.key} was handed SCOUT artifact ${bad.sha256.slice(0, 12)}…`);
}

const picoOf = (usd: number): Pico => usdToPico(Math.max(0, usd).toFixed(12), "ceil");

async function setVenture(ctx: Ctx, id: string, patch: Partial<VentureRow>) {
  await ctx.db.update(ventures).set({ ...patch, updatedAt: new Date() }).where(eq(ventures.id, id));
}

/** The target's host and its bare / www. forms, so a builder sandbox can't reach any of them. */
export function targetHosts(target: string | null): string[] {
  if (!target) return [];
  try {
    const h = new URL(target).hostname.toLowerCase();
    const bare = h.replace(/^www\./, "");
    return [...new Set([h, bare, `www.${bare}`])];
  } catch {
    return [];
  }
}

const running = new Map<string, AbortController>();
export const isRunning = (ventureId: string) => running.has(ventureId);
export function cancelVenture(ventureId: string) {
  running.get(ventureId)?.abort();
}

/**
 * Runs a venture's DAG to the end. `target` is the url (only SCOUT steps see it); it is never written anywhere.
 * Resolves with the final status.
 */
export async function runVenture(deps: VentureDeps, ventureId: string, target: string | null): Promise<VentureStatus> {
  const { ctx, events } = deps;
  const [venture] = await ctx.db.select().from(ventures).where(eq(ventures.id, ventureId));
  if (!venture) throw new Error(`no venture ${ventureId}`);
  const abort = new AbortController();
  running.set(ventureId, abort);
  const input = await loadInput(ctx, venture);
  const tier = TIER_RULES[venture.tier as Tier] ?? TIER_RULES.solo;
  const caps = venture.caps as { total: number; perStep: number };
  let ventureCost = 0;
  let fatal: { status: VentureStatus; message: string } | null = null;

  const denyHosts = targetHosts(target);
  const pool = crewPool(ctx);
  const priceByFamily = new Map(pool.map((m) => [m.family, m.pricePerMTokUsd]));
  const llm = deps.llmFor?.(venture) ?? inProcessLlm(deps.app, ctx, crewSecret(ctx, venture.crewKeyEnc!), undefined, (family) => priceByFamily.get(family) ?? Math.max(0, ...priceByFamily.values()));

  await setVenture(ctx, ventureId, { status: "RUNNING" });
  events.emit({ type: "venture", ventureId, status: "RUNNING", at: at(deps), costUsd: 0 });

  const steps = await ctx.db.select().from(ventureSteps).where(eq(ventureSteps.ventureId, ventureId)).orderBy(ventureSteps.position);
  const state = new Map<string, StepState>(steps.map((s) => [s.key, s.state as StepState]));
  const outputs = new Map<string, ArtifactRef[]>(steps.map((s) => [s.key, (s.outputs as ArtifactRef[]) ?? []]));

  const finishStep = async (s: StepRow, st: StepState, patch: Partial<StepRow> = {}) => {
    state.set(s.key, st);
    await ctx.db.update(ventureSteps).set({ state: st, endedAt: new Date(), ...patch }).where(eq(ventureSteps.id, s.id));
    events.emit({ type: "step", ventureId, step: s.key, role: s.role as Role, state: st, at: at(deps), costUsd: Number(patch.costUsd ?? s.costUsd) / 1e12, ...(patch.error ? { error: patch.error } : {}) });
  };

  const runStep = async (s: StepRow) => {
    const task = (s.inputs as { task: string }).task;
    const handler = deps.handlers[task];
    state.set(s.key, "RUNNING");
    await ctx.db.update(ventureSteps).set({ state: "RUNNING", startedAt: new Date() }).where(eq(ventureSteps.id, s.id));
    events.emit({ type: "step", ventureId, step: s.key, role: s.role as Role, state: "RUNNING", at: at(deps), costUsd: 0 });

    const capUsd = Number(s.capUsd) / 1e12;
    let stepCost = 0;
    const receipts: string[] = [];
    const produced: ArtifactRef[] = [];
    const needs: Record<string, ArtifactRef[]> = Object.fromEntries(s.needs.map((k) => [k, outputs.get(k) ?? []]));
    const inputs = Object.values(needs).flat();
    const remaining = () => Math.max(0, Math.min(capUsd - stepCost, caps.total - ventureCost));
    const spend = (usd: number) => {
      stepCost += usd;
      ventureCost += usd;
    };

    const guardedLlm: Llm = {
      async call(c: CrewCall): Promise<CrewReply> {
        if (abort.signal.aborted) throw new CrewCallError(499, "cancelled", "The run was cancelled.");
        if (remaining() <= 0) throw new StepCapReached(`step ${s.key} reached its budget of $${capUsd.toFixed(2)}`);
        const r = await llm.call(c);
        // A refused attempt is billed 0 to the caller, but the provider still charged for it: it counts here.
        spend(r.costUsd + (r.refusedCostUsd ?? 0));
        if (r.receiptId) receipts.push(r.receiptId);
        return r;
      },
    };

    const sc: StepContext = {
      ctx,
      deps,
      venture,
      input,
      step: s,
      tier,
      llm: guardedLlm,
      pool,
      target: s.zone === "SCOUT" ? target : null,
      denyHosts,
      needs,
      need(stepKey, name) {
        const refs = needs[stepKey];
        if (!refs) throw new Error(`step ${s.key} does not need ${stepKey}`);
        const r = name ? refs.find((x) => x.name === name || x.kind === name) : refs[0];
        if (!r) throw new Error(`step ${stepKey} produced no ${name ?? "output"}`);
        return r;
      },
      text: (ref) => getText(ctx.db, ventureId, ref, s.zone as Zone),
      json: (ref) => getJson(ctx.db, ventureId, ref, s.zone as Zone),
      async put(a) {
        // Only the Spec Filter may write across the firewall (SCOUT in, CLEAN out). Everyone else writes in its own zone.
        const zone = a.zone ?? (s.zone as Zone);
        if (zone !== s.zone && !(s.role === "spec-filter" && zone === "CLEAN")) throw new Error(`step ${s.key} (${s.zone}) may not write a ${zone} artifact`);
        const ref = await putArtifact(ctx.db, ventureId, { ...a, zone });
        produced.push(ref);
        events.emit({ type: "artifact", ventureId, step: s.key, artifact: ref, at: at(deps) });
        return ref;
      },
      log(message) {
        events.emit({ type: "log", ventureId, step: s.key, role: s.role as Role, message, at: at(deps) });
      },
      async candidate(c) {
        await ctx.db.insert(ventureCandidates).values({
          id: uid("cand_"),
          ventureId,
          stepId: s.id,
          family: c.family,
          model: c.model,
          passRate: c.passRate,
          lintErrors: c.lintErrors ?? null,
          typeErrors: c.typeErrors ?? null,
          bundleBytes: c.bundleBytes ?? null,
          refused: c.refused,
          chosen: c.chosen,
          receiptId: c.receiptId,
          costUsd: picoOf(c.costUsd),
          error: c.error ?? null,
        });
        events.emit({ type: "candidate", ventureId, step: s.key, family: c.family, model: c.model, passRate: c.passRate, chosen: c.chosen, refused: c.refused, at: at(deps) });
      },
      async charge(usd, ref) {
        if (usd <= 0) return true;
        if (usd > remaining()) return false;
        const ok = deps.chargeCrew ? await deps.chargeCrew(venture, usd, `venture:${ventureId}:${s.key}:${ref}`) : true;
        if (ok) spend(usd);
        return ok;
      },
      remainingUsd: remaining,
      now: () => (deps.now ?? (() => new Date()))(),
      signal: abort.signal,
    };

    try {
      checkZoneInputs(s, inputs);
      if (!handler) throw new Error(`no handler for task ${task}`);
      await handler(sc);
      outputs.set(s.key, produced);
      await finishStep(s, "DONE", { outputs: produced, costUsd: picoOf(stepCost), receiptIds: receipts });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      outputs.set(s.key, produced);
      await finishStep(s, "FAILED", { outputs: produced, costUsd: picoOf(stepCost), receiptIds: receipts, error: message.slice(0, 500) });
      if (e instanceof CrewCallError && e.fatal) fatal = { status: e.status === 451 ? "FAILED" : "CAPPED", message };
      else if (e instanceof CrewCallError && e.code === "cancelled") fatal = { status: "CANCELLED", message };
      else if (!(s.inputs as { optional?: boolean }).optional) fatal ??= { status: e instanceof StepCapReached ? "CAPPED" : "FAILED", message: `${s.key}: ${message}` };
    }
  };

  const inflight = new Map<string, Promise<void>>();
  const blocked = (s: StepRow) => s.needs.some((n) => ["FAILED", "SKIPPED"].includes(state.get(n)!));
  while (true) {
    if (abort.signal.aborted) fatal ??= { status: "CANCELLED", message: "cancelled" };
    for (const s of steps) {
      if (state.get(s.key) !== "QUEUED" || inflight.has(s.key)) continue;
      if (fatal || blocked(s)) {
        await finishStep(s, "SKIPPED");
        continue;
      }
      if (s.needs.every((n) => state.get(n) === "DONE")) {
        const p = runStep(s).finally(() => inflight.delete(s.key));
        inflight.set(s.key, p);
      }
    }
    if (!inflight.size) break;
    await Promise.race(inflight.values());
  }

  const failedRequired = steps.some((s) => state.get(s.key) === "FAILED" && !(s.inputs as { optional?: boolean }).optional);
  // A Run Mode venture never finishes: between ticks it waits (QUEUED), and its cost accumulates tick after tick.
  const runMode = venture.mode === "RUN";
  const status: VentureStatus = fatal?.status ?? (runMode ? "QUEUED" : failedRequired ? "FAILED" : "DONE");
  const cost = picoOf(ventureCost) + (runMode ? venture.costUsd : 0n);
  await setVenture(ctx, ventureId, { status, costUsd: cost, error: fatal?.message?.slice(0, 500) ?? null });
  if (venture.crewKeyHash && venture.mode !== "RUN") {
    const [crew] = await ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, venture.crewKeyHash));
    // Only a finished run keeps its all-in price; anything else hands the unused budget back to the owner.
    const refundTo = status === "DONE" || venture.accountId === HOUSE_ACCOUNT ? undefined : { accountId: venture.accountId, keyHash: venture.keyHash };
    if (crew) await settleCrewWallet(ctx, { ventureId, accountId: crew.accountId, keyHash: venture.crewKeyHash, price: venture.priceUsd, refundTo, refundCap: venture.paidBalance, costTracked: picoOf(ventureCost) });
  }
  running.delete(ventureId);
  events.emit({ type: "venture", ventureId, status, at: at(deps), costUsd: ventureCost });
  return status;
}

/** A plain snapshot of a venture and its steps, as GET /v1/ventures/{id} returns it. */
export async function ventureSnapshot(ctx: Ctx, ventureId: string, keyHash?: string) {
  const where = keyHash ? and(eq(ventures.id, ventureId), eq(ventures.keyHash, keyHash)) : eq(ventures.id, ventureId);
  const [v] = await ctx.db.select().from(ventures).where(where);
  if (!v) return null;
  const steps = await ctx.db.select().from(ventureSteps).where(eq(ventureSteps.ventureId, ventureId)).orderBy(ventureSteps.position);
  const cands = await ctx.db.select().from(ventureCandidates).where(eq(ventureCandidates.ventureId, ventureId));
  const usd = (p: bigint) => Number(p) / 1e12;
  return {
    id: v.id,
    mode: v.mode,
    status: v.status,
    tier: v.tier,
    caps: v.caps,
    price_usd: usd(v.priceUsd),
    cost_usd: usd(v.costUsd),
    target_commit: v.targetCommit,
    recipe_id: v.recipeId,
    error: v.error,
    created_at: v.createdAt.toISOString(),
    input: await loadInput(ctx, v).then((i) => ({ mode: i.mode, brief: i.brief, brand: i.brand ?? null, rival: i.rival ?? null })),
    steps: steps.map((s) => ({
      key: s.key,
      task: (s.inputs as { task: string }).task,
      role: s.role,
      kind: s.kind,
      zone: s.zone,
      fanout: s.fanout,
      select: s.selectMode,
      needs: s.needs,
      state: s.state,
      cost_usd: usd(s.costUsd),
      cap_usd: usd(s.capUsd),
      receipts: s.receiptIds,
      outputs: s.outputs,
      error: s.error,
      candidates: cands
        .filter((c) => c.stepId === s.id)
        .map((c) => ({ family: c.family, model: c.model, pass_rate: c.passRate, lint_errors: c.lintErrors, type_errors: c.typeErrors, bundle_bytes: c.bundleBytes, refused: c.refused, chosen: c.chosen, receipt_id: c.receiptId, cost_usd: usd(c.costUsd), error: c.error })),
    })),
  };
}

import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { Ctx } from "../../context.ts";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { usageInBucket, type ReserveInput } from "../../ledger/ledger.ts";
import { fail } from "../../lib/errors.ts";
import { usdgToPico } from "../../lib/money.ts";
import { checkpoints, stakeSlot, type IndexState } from "./indexer.ts";
import { PASS_CHAT_LIMIT, PRODUCTS, WINDOW, stakeAverage, stakeTier, tierLimits, utcDay, type Sku, type Tier } from "./policy.ts";
import { dailyMoCredits, passes, stakeLinks } from "./schema.ts";

export type Entitlements = Awaited<ReturnType<typeof entitlements>>;
type Pass = typeof passes.$inferSelect;

export async function activePasses(db: Db, keyHash: string, now: Date) {
  const rows = await db.selectDistinctOn([passes.sku]).from(passes)
    .where(and(eq(passes.keyHash, keyHash), lte(passes.starts, now), gt(passes.ends, now)))
    .orderBy(passes.sku, desc(passes.ends));
  return rows.reverse(); // Pass+ first.
}

export async function boughtPass(ctx: Ctx, keyHash: string) {
  if (!ctx.cfg.features.passes) return false;
  const [row] = await ctx.db.select({ id: passes.orderId }).from(passes).where(eq(passes.keyHash, keyHash)).limit(1);
  return !!row;
}

export async function entitlements(ctx: Ctx, keyHash: string, now = new Date()) {
  const active: Pass[] = ctx.cfg.features.passes ? await activePasses(ctx.db, keyHash, now) : [];
  let tier: Tier = "Free";
  let balance = 0n;
  let twab = 0n;
  let wallet: string | null = null;
  let daily = 0n;
  const day = utcDay(now);
  const contract = ctx.cfg.everyday?.stake;
  let table: IndexState["table"];
  if (ctx.cfg.features.stake && contract) {
    const [link] = await ctx.db.select().from(stakeLinks).where(eq(stakeLinks.keyHash, keyHash));
    const [row] = await ctx.db.select().from(kv).where(eq(kv.key, stakeSlot(contract)));
    const state = row?.value as IndexState | undefined;
    table = state?.table;
    wallet = link?.wallet ?? null;
    if (wallet && state?.table?.length === 3)
      ({ balance, twab, tier } = await stakeEntitlement(ctx, keyHash, day, now, contract, wallet, state));
    const [credit] = await ctx.db.select().from(dailyMoCredits).where(and(eq(dailyMoCredits.keyHash, keyHash), eq(dailyMoCredits.day, day)));
    daily = credit?.amount ?? 0n;
  }
  const limits = tierLimits(tier, active[0]?.sku as Sku | undefined);
  if (balance === 0n) limits.dailyVoiceSeconds = 0;
  return { active, tier, limits, balance, twab, wallet, table, day, daily };
}

async function stakeEntitlement(ctx: Ctx, keyHash: string, day: string, now: Date, contract: NonNullable<Ctx["cfg"]["everyday"]["stake"]>,
  wallet: string, state: IndexState) {
  const at = BigInt(state.at);
  const result = stakeAverage(await checkpoints(ctx.db, contract, wallet, at - WINDOW, at), at);
  const rule = stakeTier(result.twab, state.table!.map((entry) => ({ minTwab: BigInt(entry.minTwab), dailyMicroUsd: BigInt(entry.dailyMicroUsd) })));
  const confirmed = new Date(Number(at) * 1000);
  const fresh = now.getTime() - confirmed.getTime() <= 15 * 60_000 && confirmed <= now;
  const amount = usdgToPico(rule.dailyMicroUsd);
  if (fresh && utcDay(confirmed) === day && result.balance > 0n && amount > 0n && amount <= 9_223_372_036_854_775_807n)
    await ctx.db.insert(dailyMoCredits).values({ keyHash, day, amount }).onConflictDoNothing();
  return { ...result, tier: fresh ? rule.tier : "Free" as const };
}

export async function issueTodaysCredits(ctx: Ctx) {
  const contract = ctx.cfg.everyday.stake;
  if (!contract) return;
  const now = new Date();
  const day = utcDay(now);
  const slot = `everyday:daily:${contract}`;
  const [state, previous] = await Promise.all([
    ctx.db.select().from(kv).where(eq(kv.key, stakeSlot(contract))),
    ctx.db.select().from(kv).where(eq(kv.key, slot)),
  ]);
  const confirmed = state[0]?.value as IndexState | undefined;
  if (!confirmed?.table || previous[0]?.value === day || utcDay(new Date(Number(confirmed.at) * 1000)) !== day ||
      now.getTime() - Number(confirmed.at) * 1000 > 15 * 60_000) return;
  let after = "";
  while (true) {
    const batch = await ctx.db.select({ keyHash: stakeLinks.keyHash, wallet: stakeLinks.wallet }).from(stakeLinks)
      .where(and(gt(stakeLinks.wallet, after), sql`not exists (
        select 1 from ${dailyMoCredits} where ${dailyMoCredits.keyHash} = ${stakeLinks.keyHash} and ${dailyMoCredits.day} = ${day}::date
      )`)).orderBy(stakeLinks.wallet).limit(100);
    if (!batch.length) break;
    for (const link of batch) await stakeEntitlement(ctx, link.keyHash, day, now, contract, link.wallet, confirmed);
    after = batch.at(-1)!.wallet;
  }
  await ctx.db.insert(kv).values({ key: slot, value: day }).onConflictDoUpdate({
    target: kv.key, set: { value: day, updatedAt: new Date() },
    setWhere: sql`${kv.value} < ${JSON.stringify(day)}::jsonb`,
  });
}

export const creditBucket = (day: string) => `daily:${day}`;

export function everydayCoverage(
  keyHash: string, rights: Entitlements | undefined, kind: "chat" | "image" | "voice" | "credits", amount: bigint, units = 1,
): ReserveInput["cover"] {
  if (!rights || (!rights.active.length && !rights.limits.dailyVoiceSeconds && rights.daily === 0n)) return;
  return async (tx) => {
    for (const pass of kind === "credits" ? [] : rights.active) {
      if (pass.ends.getTime() <= Date.now()) continue;
      const product = PRODUCTS[pass.sku as Sku];
      const bucket = kind === "chat" ? `chat:${rights.day}` : `${kind}:${pass.orderId}`;
      const limit = kind === "chat" ? PASS_CHAT_LIMIT : kind === "image" ? product.images : product.voiceSeconds;
      const current = await usageInBucket(tx, keyHash, bucket);
      if (current.units + units <= limit) return { bucket, units, limit, covered: String(amount), full: true };
      if (kind === "chat") fail(429, "Today's Pass fair-use limit has been reached. It resets at midnight UTC.", "pass_fair_use");
    }
    if (kind === "voice" && rights.limits.dailyVoiceSeconds) {
      const bucket = `voice:${rights.day}`;
      const limit = rights.limits.dailyVoiceSeconds;
      if ((await usageInBucket(tx, keyHash, bucket)).units < limit)
        return { bucket, units, limit, covered: String(amount), full: true };
    }
    if (rights.daily === 0n) return;
    const bucket = creditBucket(rights.day);
    const reserved = await usageInBucket(tx, keyHash, bucket);
    const available = rights.daily - reserved.covered;
    if (available > 0n && amount > 0n)
      return { bucket, units: 0, covered: String(available < amount ? available : amount) };
  };
}

export async function keyEntitlements(ctx: Ctx, keyHash?: string | null) {
  if (keyHash && (ctx.cfg.features.passes || ctx.cfg.features.stake)) return entitlements(ctx, keyHash);
}

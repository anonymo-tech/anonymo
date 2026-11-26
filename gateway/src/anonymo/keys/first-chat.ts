// A first chat is one sponsored request, never a balance or ledger credit. The KV entries contain only
// an account ID, state, counters and a transient reservation ID. All replicas share Postgres.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { accounts, kv } from "../../db/schema.ts";
import { usdToPico } from "../../lib/money.ts";

const legacySlot = (accountId: string) => `first-chat:account:${accountId}`;
export const freshStartSlot = (accountId: string) => `first-chat:fresh-start:account:${accountId}`;
const campaignClaim = "fresh-start:";
const slotForClaim = (accountId: string, claim: string) => claim.startsWith(campaignClaim) ? freshStartSlot(accountId) : legacySlot(accountId);
const liveLegacyLease = (accountId: string) => sql`exists (select 1 from ${kv} as legacy
  where legacy.key = ${legacySlot(accountId)} and legacy.value->>'state' = 'reserved'
    and legacy.updated_at > now() - interval '2 minutes')`;
const dailySlot = sql<string>`'first-chat:daily:' || to_char(timezone('UTC', now()), 'YYYY-MM-DD')`;
// With the chat route's $0.01 worst-case request ceiling, all workers combined can sponsor at most $10 per UTC day.
export const FIRST_CHAT_DAILY_LIMIT = 1_000;
const maxReservations = 3;
const claimable = sql`(${kv.value}->>'attempts')::int < ${maxReservations} AND
  (${kv.value}->>'state' = 'available' OR
  (${kv.value}->>'state' = 'reserved' AND ${kv.updatedAt} <= now() - interval '2 minutes'))`;
const activeReservation = (claimId: string) => sql`${kv.value}->>'state' = 'reserved' AND
  ${kv.value}->>'claim' = ${claimId} AND ${kv.updatedAt} > now() - interval '2 minutes'`;

export async function issueFirstChat(db: Db, accountId: string, dashboardSignup: string | undefined): Promise<boolean> {
  if (!dashboardSignup) return false;
  return db.transaction(async (tx) => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for("update");
    if (!account) return false;
    // Each root key owns its own account. Re-enrollment must never reset a claimed or spent message.
    const issued = await tx.insert(kv).values({ key: freshStartSlot(accountId), value: { state: "available", attempts: 0 } })
      .onConflictDoNothing().returning({ key: kv.key });
    if (!issued.length) return false;
    // During rollout an old worker can still hold a live reservation. Its claim must finish against its own slot.
    // Supersede any unused legacy entitlement so a rolling deployment cannot stack both offers.
    await tx.update(kv).set({ value: { state: "superseded" }, updatedAt: sql`now()` })
      .where(and(eq(kv.key, legacySlot(accountId)), sql`(${kv.value}->>'state' = 'available' OR
        (${kv.value}->>'state' = 'reserved' AND ${kv.updatedAt} <= now() - interval '2 minutes'))`));
    return true;
  });
}

async function hasRoom(db: Db | Tx) {
  const [row] = await db.select({ used: kv.value }).from(kv).where(eq(kv.key, dailySlot));
  return !row || Number(row.used) < FIRST_CHAT_DAILY_LIMIT;
}

async function campaignEnrolled(db: Db | Tx, accountId: string): Promise<boolean> {
  const [row] = await db.select({ key: kv.key }).from(kv).where(eq(kv.key, freshStartSlot(accountId)));
  return !!row;
}

export async function firstChatAvailable(db: Db, accountId: string, pool?: FreePool | null): Promise<boolean> {
  if (pool) return poolAvailable(db, accountId, pool);
  const enrolled = await campaignEnrolled(db, accountId);
  const slot = enrolled ? freshStartSlot(accountId) : legacySlot(accountId);
  const [eligible] = await db.select({ id: accounts.id }).from(accounts).innerJoin(kv, eq(kv.key, slot))
    .where(and(eq(accounts.id, accountId), claimable, enrolled ? sql`not ${liveLegacyLease(accountId)}` :
      sql`${accounts.balance} <= ${accounts.held}`));
  return !!eligible && await hasRoom(db);
}

// ---- Free pool ------------------------------------------------------------------------------------------------------
// When ANONYMO_FREE_POOL_USD is set, a dashboard key with no balance chats free until its own daily cap or the daily
// amount shared by every key is used up (UTC days). Each request reserves the per-request ceiling before dispatch and
// settles to what the reply actually cost, so a cancelled or partial stream still counts what it used. The KV rows hold
// an account ID, a date and amounts only.

export type FreePool = { dailyUsd: number; perKeyUsd: number; requestUsd: number };
export const POOL_CLAIM = "pool:";
const isPoolClaim = (claim: string) => claim.startsWith(POOL_CLAIM);
const utcDate = () => new Date().toISOString().slice(0, 10);
export const poolDayKey = (day: string) => `free-pool:day:${day}`;
export const poolAccountKey = (accountId: string, day: string) => `free-pool:account:${accountId}:${day}`;
const poolClaimKey = (claim: string) => `free-pool:claim:${claim}`;
const pico = sql`coalesce((${kv.value}->>'pico')::numeric, 0)`;
const asPico = (value: unknown) => BigInt(String((value as { pico?: string } | null)?.pico ?? "0").split(".")[0] || "0");

class PoolFull extends Error {}

async function poolSpent(db: Db | Tx, key: string) {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));
  return row ? asPico(row.value) : 0n;
}

/** A key may use the pool when it came from a dashboard signup and has no spendable balance. */
async function poolEligible(db: Db | Tx, accountId: string, account?: { balance: bigint; held: bigint }) {
  const row = account ?? (await db.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, accountId)))[0];
  return !!row && row.balance <= row.held && await campaignEnrolled(db, accountId);
}

export async function poolAvailable(db: Db, accountId: string, pool: FreePool): Promise<boolean> {
  if (!await poolEligible(db, accountId)) return false;
  const day = utcDate();
  const need = usdToPico(pool.requestUsd);
  return await poolSpent(db, poolAccountKey(accountId, day)) + need <= usdToPico(pool.perKeyUsd, "floor") &&
    await poolSpent(db, poolDayKey(day)) + need <= usdToPico(pool.dailyUsd, "floor");
}

async function addToPool(tx: Tx, key: string, amount: bigint, limit: bigint) {
  const added = await tx.insert(kv).values({ key, value: { pico: amount.toString() } }).onConflictDoUpdate({
    target: kv.key,
    set: { value: sql`jsonb_build_object('pico', (${pico} + ${amount.toString()}::numeric)::text)`, updatedAt: sql`now()` },
    setWhere: sql`${pico} + ${amount.toString()}::numeric <= ${limit.toString()}::numeric`,
  }).returning({ key: kv.key });
  if (!added.length) throw new PoolFull();
}

async function reservePool(db: Db, accountId: string, pool: FreePool): Promise<string | null> {
  const amount = usdToPico(pool.requestUsd);
  const day = utcDate();
  const claim = POOL_CLAIM + randomUUID();
  try {
    await db.transaction(async (tx) => {
      const account = await lockAccount(tx, accountId);
      if (!account || !await poolEligible(tx, accountId, account)) throw new PoolFull();
      await addToPool(tx, poolAccountKey(accountId, day), amount, usdToPico(pool.perKeyUsd, "floor"));
      await addToPool(tx, poolDayKey(day), amount, usdToPico(pool.dailyUsd, "floor"));
      await tx.insert(kv).values({ key: poolClaimKey(claim), value: { account: accountId, day, pico: amount.toString() } });
    });
    return claim;
  } catch (e) {
    if (e instanceof PoolFull) return null;
    throw e;
  }
}

/** Replaces a reservation with what the request actually cost (0 when it never reached a model). Runs once per claim. */
async function settlePool(db: Db, claim: string, spent: bigint) {
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(kv).where(eq(kv.key, poolClaimKey(claim))).returning({ value: kv.value });
    if (!row) return;
    const { account, day } = row.value as { account: string; day: string };
    const delta = (spent < 0n ? 0n : spent) - asPico(row.value);
    for (const key of [poolAccountKey(account, day), poolDayKey(day)])
      await tx.update(kv).set({
        value: sql`jsonb_build_object('pico', greatest(${pico} + ${delta.toString()}::numeric, 0)::text)`, updatedAt: sql`now()`,
      }).where(eq(kv.key, key));
  });
}

async function lockAccount(tx: Tx, accountId: string) {
  const [row] = await tx.select({ balance: accounts.balance, held: accounts.held }).from(accounts)
    .where(eq(accounts.id, accountId)).for("update");
  return row;
}

/** An abandoned pre-send reservation can be reclaimed after two minutes. Three reservations bound retries per account. */
export async function reserveFirstChat(db: Db, accountId: string, pool?: FreePool | null): Promise<string | null> {
  if (pool) return reservePool(db, accountId, pool);
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, accountId);
    if (!account || !await hasRoom(tx)) return null;
    const enrolled = await campaignEnrolled(tx, accountId);
    if (!enrolled && account.balance > account.held) return null;
    const claim = (enrolled ? campaignClaim : "") + randomUUID();
    const reserved = await tx.update(kv).set({
      value: sql`jsonb_build_object('state', 'reserved', 'claim', ${claim}::text, 'attempts', (${kv.value}->>'attempts')::int + 1)`,
      updatedAt: sql`now()`,
    }).where(and(eq(kv.key, slotForClaim(accountId, claim)), claimable, enrolled ? sql`not ${liveLegacyLease(accountId)}` : undefined))
      .returning({ key: kv.key });
    return reserved.length ? claim : null;
  });
}

/** This must commit immediately before dispatch. Crashing after it, even after only a partial stream, never allows replay. */
export async function startFirstChat(db: Db, accountId: string, claim: string): Promise<boolean> {
  // A pool claim is counted when it is reserved; it only has to still exist.
  if (isPoolClaim(claim)) return (await db.select({ key: kv.key }).from(kv).where(eq(kv.key, poolClaimKey(claim)))).length > 0;
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, accountId);
    if (!account || (!claim.startsWith(campaignClaim) && account.balance > account.held)) return false;
    const where = and(eq(kv.key, slotForClaim(accountId, claim)), activeReservation(claim));
    const [reserved] = await tx.select({ id: kv.key }).from(kv).where(where).for("update");
    if (!reserved) return false;
    const used = await tx.insert(kv).values({ key: dailySlot, value: 1 }).onConflictDoUpdate({
      target: kv.key, set: { value: sql`to_jsonb((${kv.value} #>> '{}')::int + 1)`, updatedAt: sql`now()` },
      setWhere: sql`(${kv.value} #>> '{}')::int < ${FIRST_CHAT_DAILY_LIMIT}`,
    }).returning({ key: kv.key });
    if (!used.length) return false;
    await tx.update(kv).set({ value: sql`${kv.value} || '{"state":"started"}'::jsonb`, updatedAt: sql`now()` })
      .where(eq(kv.key, slotForClaim(accountId, claim)));
    return true;
  });
}

export async function finishFirstChat(db: Db, accountId: string, claim: string, outcome: "completed" | "failed" | "empty", spent = 0n): Promise<void> {
  if (isPoolClaim(claim)) return settlePool(db, claim, spent);
  const sameClaim = and(eq(kv.key, slotForClaim(accountId, claim)), sql`${kv.value}->>'claim' = ${claim}`);
  if (outcome === "failed") {
    // Only a claim that never reached dispatch can be returned to the account.
    const released = await db.update(kv).set({
      value: sql`jsonb_build_object('state', 'available', 'attempts', (${kv.value}->>'attempts')::int)`, updatedAt: sql`now()`,
    }).where(and(sameClaim, sql`${kv.value}->>'state' = 'reserved'`)).returning({ key: kv.key });
    if (released.length) return;
  }
  if (outcome === "empty" && claim.startsWith(campaignClaim)) {
    // The route confirmed a clean completion with no visible text. Keep every dispatch in the daily count.
    // A missing attempt count (old worker), an expired lease or the third attempt stays spent.
    await db.update(kv).set({
      value: sql`CASE WHEN (${kv.value}->>'attempts')::int BETWEEN 1 AND ${maxReservations - 1}
        AND ${kv.updatedAt} > now() - interval '2 minutes'
        THEN jsonb_build_object('state', 'available', 'attempts', (${kv.value}->>'attempts')::int)
        ELSE '{"state":"failed"}'::jsonb END`,
      updatedAt: sql`now()`,
    }).where(and(sameClaim, sql`${kv.value}->>'state' = 'started'`));
    return;
  }
  await db.update(kv).set({ value: { state: outcome === "empty" ? "failed" : outcome }, updatedAt: sql`now()` })
    .where(and(sameClaim, sql`${kv.value}->>'state' = 'started'`));
}

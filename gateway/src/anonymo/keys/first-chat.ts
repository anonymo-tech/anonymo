// A first chat is one sponsored request, never a balance or ledger credit. The KV entries contain only
// an account ID, state, counters and a transient reservation ID. All replicas share Postgres.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { accounts, kv } from "../../db/schema.ts";

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

export async function firstChatAvailable(db: Db, accountId: string): Promise<boolean> {
  const enrolled = await campaignEnrolled(db, accountId);
  const slot = enrolled ? freshStartSlot(accountId) : legacySlot(accountId);
  const [eligible] = await db.select({ id: accounts.id }).from(accounts).innerJoin(kv, eq(kv.key, slot))
    .where(and(eq(accounts.id, accountId), claimable, enrolled ? sql`not ${liveLegacyLease(accountId)}` :
      sql`${accounts.balance} <= ${accounts.held}`));
  return !!eligible && await hasRoom(db);
}

async function lockAccount(tx: Tx, accountId: string) {
  const [row] = await tx.select({ balance: accounts.balance, held: accounts.held }).from(accounts)
    .where(eq(accounts.id, accountId)).for("update");
  return row;
}

/** An abandoned pre-send reservation can be reclaimed after two minutes. Three reservations bound retries per account. */
export async function reserveFirstChat(db: Db, accountId: string): Promise<string | null> {
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

export async function finishFirstChat(db: Db, accountId: string, claim: string, outcome: "completed" | "failed" | "empty"): Promise<void> {
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

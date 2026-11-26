// A first chat is one sponsored request, never a balance or ledger credit. The KV entries contain only
// an account ID, state, counters and a transient reservation ID. All replicas share Postgres.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { accounts, kv } from "../../db/schema.ts";

const accountSlot = (accountId: string) => `first-chat:account:${accountId}`;
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
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for("key share");
    if (!account) return false;
    // Each root key owns its own account. Re-enrollment must never reset a claimed or spent message.
    const issued = await tx.insert(kv).values({ key: accountSlot(accountId), value: { state: "available", attempts: 0 } })
      .onConflictDoNothing().returning({ key: kv.key });
    return issued.length === 1;
  });
}

async function hasRoom(db: Db | Tx) {
  const [row] = await db.select({ used: kv.value }).from(kv).where(eq(kv.key, dailySlot));
  return !row || Number(row.used) < FIRST_CHAT_DAILY_LIMIT;
}

export async function firstChatAvailable(db: Db, accountId: string): Promise<boolean> {
  const [eligible] = await db.select({ id: accounts.id }).from(accounts)
    .innerJoin(kv, eq(kv.key, accountSlot(accountId)))
    .where(and(eq(accounts.id, accountId), sql`${accounts.balance} <= ${accounts.held}`, claimable));
  return !!eligible && await hasRoom(db);
}

async function lockUnfundedAccount(tx: Tx, accountId: string) {
  const [account] = await tx.select({ balance: accounts.balance, held: accounts.held }).from(accounts)
    .where(eq(accounts.id, accountId)).for("update");
  return !!account && account.balance <= account.held;
}

/** An abandoned pre-send reservation can be reclaimed after two minutes. Three reservations bound retries per account. */
export async function reserveFirstChat(db: Db, accountId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    if (!await lockUnfundedAccount(tx, accountId) || !await hasRoom(tx)) return null;
    const claim = randomUUID();
    const reserved = await tx.update(kv).set({
      value: sql`jsonb_build_object('state', 'reserved', 'claim', ${claim}::text, 'attempts', (${kv.value}->>'attempts')::int + 1)`,
      updatedAt: sql`now()`,
    }).where(and(eq(kv.key, accountSlot(accountId)), claimable)).returning({ key: kv.key });
    return reserved.length ? claim : null;
  });
}

/** This must commit immediately before dispatch. Crashing after it, even after only a partial stream, never allows replay. */
export async function startFirstChat(db: Db, accountId: string, claim: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!await lockUnfundedAccount(tx, accountId)) return false;
    const where = and(eq(kv.key, accountSlot(accountId)), activeReservation(claim));
    const [reserved] = await tx.select({ id: kv.key }).from(kv).where(where).for("update");
    if (!reserved) return false;
    const used = await tx.insert(kv).values({ key: dailySlot, value: 1 }).onConflictDoUpdate({
      target: kv.key, set: { value: sql`to_jsonb((${kv.value} #>> '{}')::int + 1)`, updatedAt: sql`now()` },
      setWhere: sql`(${kv.value} #>> '{}')::int < ${FIRST_CHAT_DAILY_LIMIT}`,
    }).returning({ key: kv.key });
    if (!used.length) return false;
    await tx.update(kv).set({ value: { state: "started", claim }, updatedAt: sql`now()` }).where(eq(kv.key, accountSlot(accountId)));
    return true;
  });
}

export async function finishFirstChat(db: Db, accountId: string, claim: string, outcome: "completed" | "failed"): Promise<void> {
  const sameClaim = and(eq(kv.key, accountSlot(accountId)), sql`${kv.value}->>'claim' = ${claim}`);
  if (outcome === "failed") {
    // Only a claim that never reached dispatch can be returned to the account.
    const released = await db.update(kv).set({
      value: sql`jsonb_build_object('state', 'available', 'attempts', (${kv.value}->>'attempts')::int)`, updatedAt: sql`now()`,
    }).where(and(sameClaim, sql`${kv.value}->>'state' = 'reserved'`)).returning({ key: kv.key });
    if (released.length) return;
  }
  await db.update(kv).set({ value: { state: outcome }, updatedAt: sql`now()` })
    .where(and(sameClaim, sql`${kv.value}->>'state' = 'started'`));
}

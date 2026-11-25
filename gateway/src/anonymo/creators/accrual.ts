import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { KeyRow } from "../../api/auth.ts";
import { chainEvents, keys, kv, ledger } from "../../db/schema.ts";
import type { Db, Tx } from "../../db/client.ts";
import { log } from "../../lib/util.ts";
import { FUNDING_KINDS } from "../freetier/policy.ts";
import { anonymoDeposits, anonymoKeys } from "../deposits/schema.ts";
import { dayOf, DAY_MS, type CreatorCounters } from "./counters.ts";
import { creatorAccruals, type creatorCharacters } from "./schema.ts";

export function effectiveCut(spend: bigint, bps: number) {
  return spend * BigInt(bps) / 10_000n;
}

export async function firstCreatorFunding(db: Db | Tx, key: Pick<KeyRow, "keyHash" | "accountId">) {
  const [first] = await db.select({ at: ledger.createdAt }).from(ledger)
    .where(and(eq(ledger.accountId, key.accountId), eq(ledger.keyHash, key.keyHash), gt(ledger.amount, 0n), inArray(ledger.kind, FUNDING_KINDS)))
    .orderBy(asc(ledger.createdAt)).limit(1);
  return first?.at;
}

async function creatorOwnsKey(tx: Tx, key: KeyRow, wallet: string) {
  const hashes = tx.select({ hash: keys.keyHash }).from(keys).where(eq(keys.accountId, key.accountId));
  const [source] = await tx.select({ found: sql`1` }).from(anonymoDeposits)
    .where(and(inArray(anonymoDeposits.keyHash, hashes), sql`lower(${anonymoDeposits.sourceAddr}) = ${wallet}`)).limit(1);
  if (source) return true;
  const commits = tx.select({ hash: keys.chainKeyHash }).from(keys).where(eq(keys.accountId, key.accountId));
  const [legacy] = await tx.select({ found: sql`1` }).from(chainEvents).where(and(
    eq(chainEvents.contract, "credits"), eq(chainEvents.event, "Deposited"), eq(chainEvents.processed, true),
    inArray(sql`${chainEvents.args}->>'keyHash'`, commits), sql`lower(${chainEvents.args}->>'from') = ${wallet}`,
  )).limit(1);
  if (legacy) return true;
  const [bound] = await tx.select({ found: sql`1` }).from(anonymoKeys)
    .where(and(inArray(anonymoKeys.keyHash, hashes), eq(anonymoKeys.wallet, wallet))).limit(1);
  return !!bound;
}

const BURST_SPEND = 100_000_000_000_000n;

export async function accrueCreator(tx: Tx, counters: CreatorCounters, row: typeof creatorCharacters.$inferSelect, key: KeyRow, spend: bigint, now = Date.now()) {
  if (spend <= 0n) return;
  const fundedAt = await firstCreatorFunding(tx, key);
  if (!fundedAt || await creatorOwnsKey(tx, key, row.creatorWallet)) return;
  let stats: { funded: number; newKeys: number };
  let capped: Awaited<ReturnType<CreatorCounters["cap"]>>;
  try {
    capped = await counters.cap(now, key.keyHash, row.creatorWallet, spend);
    stats = await counters.visit(now, key.keyHash, row.id, now - fundedAt.getTime() < DAY_MS);
  } catch {
    log.warn("Creator counters unavailable; accrual skipped");
    return;
  }
  const day = dayOf(now);
  // An empty Redis restart must never give the same key a fresh cap within the day.
  const marker = `creators-cap-day:${day}`;
  await tx.insert(kv).values({ key: marker, value: capped.epoch }).onConflictDoNothing();
  const [saved] = await tx.select({ value: kv.value }).from(kv).where(eq(kv.key, marker));
  if (saved?.value !== capped.epoch) {
    log.warn("Creator cap state was reset; accrual skipped");
    return;
  }
  const amount = effectiveCut(capped.allowed, row.shareBps);
  const ring = stats.newKeys >= 20 && stats.newKeys * 5 >= stats.funded * 4;
  const heldUntil = new Date(Date.parse(day) + 8 * DAY_MS);
  await tx.insert(creatorAccruals).values({
    characterId: row.id, day, amount, spend, chats: 1, fundedKeys: stats.funded, heldUntil, frozen: ring || spend >= BURST_SPEND,
  }).onConflictDoUpdate({
    target: [creatorAccruals.characterId, creatorAccruals.day],
    set: {
      amount: sql`${creatorAccruals.amount} + ${amount}`,
      spend: sql`${creatorAccruals.spend} + ${spend}`,
      chats: sql`${creatorAccruals.chats} + 1`,
      fundedKeys: sql`greatest(${creatorAccruals.fundedKeys}, ${stats.funded})`,
      frozen: sql`${creatorAccruals.frozen} or (not ${creatorAccruals.reviewed} and (${ring} or ${creatorAccruals.spend} + ${spend} >= ${BURST_SPEND}))`,
    },
  });
}

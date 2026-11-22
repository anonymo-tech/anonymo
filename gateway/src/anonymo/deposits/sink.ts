// The one place a confirmed deposit becomes credit (seams.ts DepositSink). Every chain watcher and the BTCPay webhook
// call it. Order of checks: known key → already recorded? → OFAC screen of the sender → record + ledger credit, in one
// transaction. A sanctioned sender, or a screen that cannot run, is recorded as `held` and never credited.
// Idempotent on `ref`: the deposit row's primary key and the ledger's unique `ref` (`dep:<ref>`) both guard it.

import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { keys } from "../../db/schema.ts";
import { ensureAccount, post } from "../../ledger/ledger.ts";
import { log } from "../../lib/util.ts";
import type { ConfirmedDeposit, DepositSink, SanctionsScreen } from "../seams.ts";
import { anonymoDeposits } from "./schema.ts";

/** `holdReason` records the deposit as held for an operator instead of crediting it (e.g. a coin payment over the cap). */
export type DepositExtra = {
  token?: string; amountRaw?: bigint; holdReason?: string;
  /** Market-wide executable NYMO depth over one trailing pricing window. */
  nymoWindowLimit?: { seconds: number; maxRaw: bigint; maxPico: bigint };
};
export type AnonymoDepositSink = DepositSink & {
  /** Same as credit(), with the token and raw amount kept for the record. */
  creditWith(d: ConfirmedDeposit, extra: DepositExtra): Promise<{ credited: boolean; held?: string }>;
};

export const ledgerRefOf = (depositRef: string) => `dep:${depositRef}`;

/** Includes funds awaiting sanctions screening because they may later be released without another price decision. */
export async function nymoRemaining(db: Db | Tx, limit: NonNullable<DepositExtra["nymoWindowLimit"]>) {
  const d = anonymoDeposits;
  const [used] = await db.select({
    raw: sql<string>`coalesce(sum(${d.amountRaw}), 0)::text`,
    pico: sql<string>`coalesce(sum(${d.amountPico}), 0)::text`,
  }).from(d).where(and(eq(d.chain, "coin"), eq(d.token, "NYMO"),
    sql`${d.createdAt} > now() - ${limit.seconds} * interval '1 second'`,
    sql`(${d.status} = 'credited' or ${d.reason} = 'screening_unavailable')`));
  const raw = limit.maxRaw - BigInt(used.raw);
  const pico = limit.maxPico - BigInt(used.pico);
  return { maxRaw: raw > 0n ? raw : 0n, maxPico: pico > 0n ? pico : 0n };
}

export function createDepositSink(db: Db, screen: SanctionsScreen): AnonymoDepositSink {
  const creditWith = async (d: ConfirmedDeposit, extra: DepositExtra) => {
    if (d.amount <= 0n) throw new Error("deposit amount must be positive");
    if (!d.ref || !d.sourceAddr) throw new Error("deposit needs a ref and a source address");
    const [key] = await db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, d.keyHash));
    if (!key) throw new Error("deposit for an unknown key");
    const [seen] = await db.select({ status: anonymoDeposits.status }).from(anonymoDeposits).where(eq(anonymoDeposits.ref, d.ref));
    if (seen) return { credited: false };
    const row = { ref: d.ref, keyHash: d.keyHash, chain: d.chain, token: extra.token ?? "", amountRaw: extra.amountRaw?.toString() ?? null, amountPico: d.amount, sourceAddr: d.sourceAddr };
    let held: string | null = extra.holdReason ?? null;
    if (!held) try {
      if (await screen.isBlocked(d.chain, d.sourceAddr)) held = "sanctioned";
    } catch {
      held = "screening_unavailable";
    }
    return db.transaction(async tx => {
      const limit = extra.nymoWindowLimit;
      if (limit) {
        // Serialize every NYMO payer on this database. A deposit held for screening reserves
        // capacity at intake so the normal rescreen path can never release unbudgeted credit.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('anonymo:deposit:nymo-depth', 0))`);
        const [prior] = await tx.select({ ref: anonymoDeposits.ref }).from(anonymoDeposits).where(eq(anonymoDeposits.ref, d.ref));
        if (prior) return { credited: false };
        if (!held || held === "screening_unavailable") {
          const remaining = await nymoRemaining(tx, limit);
          if (!extra.amountRaw || extra.amountRaw > remaining.maxRaw || d.amount > remaining.maxPico)
            held = "market_depth";
        }
      }
      if (held) {
        const saved = await tx.insert(anonymoDeposits).values({ ...row, status: "held", reason: held }).onConflictDoNothing().returning({ ref: anonymoDeposits.ref });
        if (!saved.length) return { credited: false };
        log.warn("anonymo deposit held", { chain: d.chain, ref: d.ref, reason: held });
        return { credited: false, held };
      }
      const inserted = await tx.insert(anonymoDeposits).values({ ...row, status: "credited", creditedAt: new Date() }).onConflictDoNothing().returning({ ref: anonymoDeposits.ref });
      if (!inserted.length) return { credited: false };
      await ensureAccount(tx, key.accountId);
      return { credited: await post(tx, { accountId: key.accountId, keyHash: d.keyHash, amount: d.amount, kind: "deposit", ref: ledgerRefOf(d.ref), description: `Deposit on ${d.chain}` }) };
    });
  };
  return { credit: (d) => creditWith(d, {}), creditWith };
}

/**
 * Re-screen deposits held only because screening was unavailable, and credit those that now pass. Deposits held as
 * `sanctioned` stay held for an operator; nothing here releases them.
 */
export async function rescreenHeld(db: Db, screen: SanctionsScreen) {
  const rows = await db.select().from(anonymoDeposits).where(eq(anonymoDeposits.reason, "screening_unavailable"));
  let credited = 0;
  for (const r of rows) {
    let blocked: boolean;
    try {
      blocked = await screen.isBlocked(r.chain as ConfirmedDeposit["chain"], r.sourceAddr);
    } catch {
      continue;
    }
    if (blocked) {
      await db.update(anonymoDeposits).set({ reason: "sanctioned" }).where(eq(anonymoDeposits.ref, r.ref));
      continue;
    }
    const [key] = await db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, r.keyHash));
    if (!key) continue;
    const ok = await db.transaction(async (tx) => {
      const moved = await tx
        .update(anonymoDeposits)
        .set({ status: "credited", reason: null, creditedAt: new Date() })
        .where(and(eq(anonymoDeposits.ref, r.ref), eq(anonymoDeposits.status, "held"), eq(anonymoDeposits.reason, "screening_unavailable")))
        .returning({ ref: anonymoDeposits.ref });
      if (!moved.length) return false;
      await ensureAccount(tx, key.accountId);
      return post(tx, { accountId: key.accountId, keyHash: r.keyHash, amount: r.amountPico, kind: "deposit", ref: ledgerRefOf(r.ref), description: `Deposit on ${r.chain}` });
    });
    if (ok) credited++;
  }
  return { credited };
}

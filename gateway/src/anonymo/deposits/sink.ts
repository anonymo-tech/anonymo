// The one place a confirmed deposit becomes credit (seams.ts DepositSink). Every chain watcher and the BTCPay webhook
// call it. Order of checks: known key → already recorded? → OFAC screen of the sender → record + ledger credit, in one
// transaction. A sanctioned sender, or a screen that cannot run, is recorded as `held` and never credited.
// Idempotent on `ref`: the deposit row's primary key and the ledger's unique `ref` (`dep:<ref>`) both guard it.

import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { keys } from "../../db/schema.ts";
import { ensureAccount, post } from "../../ledger/ledger.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import { log } from "../../lib/util.ts";
import type { ConfirmedDeposit, DepositSink, SanctionsScreen } from "../seams.ts";
import { anonymoDeposits } from "./schema.ts";

/** `holdReason` records the deposit as held for an operator instead of crediting it (e.g. a coin payment over the cap). */
export type DepositExtra = {
  token?: string; amountRaw?: bigint; holdReason?: string;
  /** Market-wide executable NYMO depth over one trailing pricing window. */
  nymoWindowLimit?: { seconds: number; maxRaw: bigint; maxPico: bigint };
  /**
   * The most every deposit whose ref starts with `scope` may credit in total (a BTCPay invoice's amount). Checked under
   * a lock in the credit transaction: the part of this deposit over what is left is held as `<ref>:excess`
   * (`over_invoice`) for an operator, never credited.
   */
  cap?: { scope: string; maxPico: Pico };
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

/** An excess under a cent (BTCPay rounds the amount due up to whole satoshis) is not worth an operator's review. */
const CAP_DUST_PICO = usdToPico("0.01");

/** What a cap scope may still credit: its max less what is credited, or held only for screening (it may be released). */
async function capRoom(tx: Tx, cap: NonNullable<DepositExtra["cap"]>): Promise<Pico> {
  const d = anonymoDeposits;
  const [used] = await tx.select({ pico: sql<string>`coalesce(sum(${d.amountPico}), 0)::text` }).from(d).where(and(
    sql`left(${d.ref}, ${cap.scope.length}) = ${cap.scope}`,
    sql`(${d.status} = 'credited' or ${d.reason} = 'screening_unavailable')`));
  return cap.maxPico - BigInt(used.pico);
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
      let excess = 0n;
      if (extra.cap) {
        // Serialize the deposits of one cap scope, so concurrent deliveries cannot each see the same room left.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`anonymo:deposit:cap:${extra.cap.scope}`}, 0))`);
        const [prior] = await tx.select({ ref: anonymoDeposits.ref }).from(anonymoDeposits).where(eq(anonymoDeposits.ref, d.ref));
        if (prior) return { credited: false };
        if (!held || held === "screening_unavailable") {
          const room = await capRoom(tx, extra.cap);
          if (room <= 0n) held = "over_invoice";
          else if (row.amountPico > room) {
            excess = row.amountPico - room;
            row.amountPico = room;
          }
        }
      }
      if (excess >= CAP_DUST_PICO) {
        await tx.insert(anonymoDeposits).values({ ...row, ref: `${d.ref}:excess`, amountRaw: null, amountPico: excess, status: "held", reason: "over_invoice" }).onConflictDoNothing();
        log.warn("anonymo deposit held", { chain: d.chain, ref: `${d.ref}:excess`, reason: "over_invoice" });
      }
      const excessHeld = excess >= CAP_DUST_PICO ? { held: "over_invoice" } : {};
      if (held) {
        const saved = await tx.insert(anonymoDeposits).values({ ...row, status: "held", reason: held }).onConflictDoNothing().returning({ ref: anonymoDeposits.ref });
        if (!saved.length) return { credited: false };
        log.warn("anonymo deposit held", { chain: d.chain, ref: d.ref, reason: held });
        return { credited: false, held };
      }
      const inserted = await tx.insert(anonymoDeposits).values({ ...row, status: "credited", creditedAt: new Date() }).onConflictDoNothing().returning({ ref: anonymoDeposits.ref });
      if (!inserted.length) return { credited: false };
      await ensureAccount(tx, key.accountId);
      return { credited: await post(tx, { accountId: key.accountId, keyHash: d.keyHash, amount: row.amountPico, kind: "deposit", ref: ledgerRefOf(d.ref), description: `Deposit on ${d.chain}` }), ...excessHeld };
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

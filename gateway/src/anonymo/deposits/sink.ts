// The one place a confirmed deposit becomes credit (seams.ts DepositSink). Every chain watcher and the BTCPay webhook
// call it. Order of checks: known key → already recorded? → OFAC screen of the sender → record + ledger credit, in one
// transaction. A sanctioned sender, or a screen that cannot run, is recorded as `held` and never credited.
// Idempotent on `ref`: the deposit row's primary key and the ledger's unique `ref` (`dep:<ref>`) both guard it.

import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { keys } from "../../db/schema.ts";
import { ensureAccount, post } from "../../ledger/ledger.ts";
import { log } from "../../lib/util.ts";
import type { ConfirmedDeposit, DepositSink, SanctionsScreen } from "../seams.ts";
import { anonymoDeposits } from "./schema.ts";

export type DepositExtra = { token?: string; amountRaw?: bigint };
export type AnonymoDepositSink = DepositSink & {
  /** Same as credit(), with the token and raw amount kept for the record. */
  creditWith(d: ConfirmedDeposit, extra: DepositExtra): Promise<{ credited: boolean; held?: string }>;
};

export const ledgerRefOf = (depositRef: string) => `dep:${depositRef}`;

export function createDepositSink(db: Db, screen: SanctionsScreen): AnonymoDepositSink {
  const creditWith = async (d: ConfirmedDeposit, extra: DepositExtra) => {
    if (d.amount <= 0n) throw new Error("deposit amount must be positive");
    if (!d.ref || !d.sourceAddr) throw new Error("deposit needs a ref and a source address");
    const [key] = await db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, d.keyHash));
    if (!key) throw new Error("deposit for an unknown key");
    const [seen] = await db.select({ status: anonymoDeposits.status }).from(anonymoDeposits).where(eq(anonymoDeposits.ref, d.ref));
    if (seen) return { credited: false };
    const row = { ref: d.ref, keyHash: d.keyHash, chain: d.chain, token: extra.token ?? "", amountRaw: extra.amountRaw?.toString() ?? null, amountPico: d.amount, sourceAddr: d.sourceAddr };
    let held: string | null = null;
    try {
      if (await screen.isBlocked(d.chain, d.sourceAddr)) held = "sanctioned";
    } catch {
      held = "screening_unavailable";
    }
    if (held) {
      await db.insert(anonymoDeposits).values({ ...row, status: "held", reason: held }).onConflictDoNothing();
      log.warn("anonymo deposit held", { chain: d.chain, ref: d.ref, reason: held });
      return { credited: false, held };
    }
    const credited = await db.transaction(async (tx) => {
      const inserted = await tx.insert(anonymoDeposits).values({ ...row, status: "credited", creditedAt: new Date() }).onConflictDoNothing().returning({ ref: anonymoDeposits.ref });
      if (!inserted.length) return false;
      await ensureAccount(tx, key.accountId);
      return post(tx, { accountId: key.accountId, keyHash: d.keyHash, amount: d.amount, kind: "deposit", ref: ledgerRefOf(d.ref), description: `Deposit on ${d.chain}` });
    });
    return { credited };
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

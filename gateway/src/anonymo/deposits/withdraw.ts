// Withdrawals (spec: Backend §7, AGENTS.md product rules):
// - Only to a source address of the same key: an address a credited deposit came from, on the same chain, up to what
//   came from it less what already went back to it. A wallet-minted key may also withdraw to its SIWE wallet on any EVM
//   chain we pay out on (spec: "refunds go back there").
// - Never more than the key's available balance (balance − open holds), checked under the account row lock.
// - Never between keys: the only debit is this key's own account; there is no transfer endpoint.
// - Never paused: nothing here reads a pause flag, and a payout rail that is down leaves the withdrawal pending and
//   retried by the job, never refused or lost.
// - Idempotent per (key, idempotency key): a replay returns the first result; a replay with other terms is a 409.
// The ledger debit (`wd:<id>`) is posted in the same transaction that records the withdrawal. The payout itself goes
// through the Payout interface, keyed by the withdrawal id so a retry can never pay twice.

import { and, eq, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { accounts } from "../../db/schema.ts";
import { post } from "../../ledger/ledger.ts";
import { ApiError, fail } from "../../lib/errors.ts";
import { type Pico, picoToUsd, usdToPico } from "../../lib/money.ts";
import { log, uid } from "../../lib/util.ts";
import type { DepositChain } from "../seams.ts";
import { EVM_CHAINS } from "./config.ts";
import { anonymoDeposits, anonymoKeys, anonymoWithdrawals } from "./schema.ts";
import { normalizeAddress } from "./sanctions.ts";

export type PayoutChain = Exclude<DepositChain, "x402">;
export const PAYOUT_CHAINS: readonly PayoutChain[] = ["base", "arbitrum", "rhc", "solana", "tron", "btc", "ln"];
export const DEFAULT_TOKEN: Record<PayoutChain, string> = { base: "USDC", arbitrum: "USDC", rhc: "USDG", solana: "USDC", tron: "USDT", btc: "BTC", ln: "BTC" };
const TOKENS: Record<PayoutChain, readonly string[]> = { base: ["USDC", "USDT", "USDG"], arbitrum: ["USDC", "USDT", "USDG"], rhc: ["USDC", "USDT", "USDG"], solana: ["USDC", "USDT"], tron: ["USDT"], btc: ["BTC"], ln: ["BTC"] };

export type PayoutRequest = { id: string; chain: PayoutChain; token: string; to: string; amountPico: Pico };
/** Sends a withdrawal on-chain (or over BTCPay/Lightning). Must be idempotent on `id`. Real rails live outside this PR. */
export interface Payout {
  send(p: PayoutRequest): Promise<{ txRef: string }>;
}

/** No rail configured: the withdrawal is accepted and stays pending until one is. It is never refused. */
export const pendingPayout: Payout = {
  send: async () => {
    throw new Error("payout rail not configured");
  },
};

/** In-memory payout for tests and local runs. Idempotent on id; can be told to fail. */
export class MockPayout implements Payout {
  sent = new Map<string, PayoutRequest & { txRef: string }>();
  failing = false;
  async send(p: PayoutRequest) {
    const had = this.sent.get(p.id);
    if (had) return { txRef: had.txRef };
    if (this.failing) throw new Error("mock payout rail down");
    const txRef = `mock:${p.chain}:${this.sent.size + 1}`;
    this.sent.set(p.id, { ...p, txRef });
    return { txRef };
  }
}

const dest = (chain: string, address: string) => `${chain}|${address}`;

/** Where this key may withdraw to, with the most each destination may still receive (before the balance cap). */
export async function withdrawDestinations(db: Db | Tx, keyHash: string): Promise<Map<string, { chain: PayoutChain; address: string; remaining: Pico | null }>> {
  const credited = await db
    .select({ chain: anonymoDeposits.chain, address: anonymoDeposits.sourceAddr, total: sql<string>`sum(${anonymoDeposits.amountPico})` })
    .from(anonymoDeposits)
    .where(and(eq(anonymoDeposits.keyHash, keyHash), eq(anonymoDeposits.status, "credited")))
    .groupBy(anonymoDeposits.chain, anonymoDeposits.sourceAddr);
  const withdrawn = await db
    .select({ chain: anonymoWithdrawals.chain, address: anonymoWithdrawals.toAddr, total: sql<string>`sum(${anonymoWithdrawals.amountPico})` })
    .from(anonymoWithdrawals)
    .where(and(eq(anonymoWithdrawals.keyHash, keyHash), ne(anonymoWithdrawals.status, "reverted")))
    .groupBy(anonymoWithdrawals.chain, anonymoWithdrawals.toAddr);
  const out = new Map<string, { chain: PayoutChain; address: string; remaining: Pico | null }>();
  for (const c of credited) {
    if (!PAYOUT_CHAINS.includes(c.chain as PayoutChain)) continue;
    out.set(dest(c.chain, c.address), { chain: c.chain as PayoutChain, address: c.address, remaining: BigInt(c.total) });
  }
  const [k] = await db.select({ wallet: anonymoKeys.wallet }).from(anonymoKeys).where(eq(anonymoKeys.keyHash, keyHash));
  if (k?.wallet) for (const chain of EVM_CHAINS) out.set(dest(chain, k.wallet), { chain, address: k.wallet, remaining: null }); // the proven wallet: balance-capped only
  for (const w of withdrawn) {
    const d = out.get(dest(w.chain, w.address));
    if (d && d.remaining !== null) d.remaining -= BigInt(w.total);
  }
  for (const d of out.values()) if (d.remaining !== null && d.remaining < 0n) d.remaining = 0n;
  return out;
}

export type WithdrawInput = { keyHash: string; accountId: string; chain: string; to: string; token?: string; amountUsd?: string | "all"; idempotencyKey: string };
export type WithdrawalRow = typeof anonymoWithdrawals.$inferSelect;

export const withdrawalJson = (w: WithdrawalRow) => ({
  id: w.id,
  status: w.status,
  chain: w.chain,
  token: w.token,
  to: w.toAddr,
  amount_usd: picoToUsd(w.amountPico),
  tx: w.txRef,
  created_at: w.createdAt.toISOString(),
  sent_at: w.sentAt?.toISOString() ?? null,
});

/** Record a withdrawal and debit the ledger, atomically. Throws ApiError for anything the caller must fix. */
export async function requestWithdrawal(db: Db, o: { minPico: Pico }, w: WithdrawInput): Promise<{ row: WithdrawalRow; replay: boolean }> {
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(w.idempotencyKey)) fail(400, "Send an Idempotency-Key header (8–128 letters, digits or _.:-) so a retry never withdraws twice.", "idempotency_key_required");
  if (!PAYOUT_CHAINS.includes(w.chain as PayoutChain)) fail(400, `chain must be one of ${PAYOUT_CHAINS.join(", ")}.`, "invalid_chain");
  const chain = w.chain as PayoutChain;
  const token = (w.token ?? DEFAULT_TOKEN[chain]).toUpperCase();
  if (!TOKENS[chain].includes(token)) fail(400, `${chain} pays out ${TOKENS[chain].join(" or ")}.`, "invalid_token");
  const to = chain === "ln" ? w.to.trim().toLowerCase() : normalizeAddress(w.to)?.address ?? w.to.trim();
  let requested: Pico | "all";
  try {
    requested = w.amountUsd === undefined || w.amountUsd === "all" ? "all" : usdToPico(w.amountUsd, "floor");
  } catch {
    fail(400, "amount_usd must be a decimal USD amount or \"all\".", "invalid_amount");
  }
  if (requested !== "all" && requested <= 0n) fail(400, "amount_usd must be positive.", "invalid_amount");

  return db.transaction(async (tx) => {
    const [prior] = await tx.select().from(anonymoWithdrawals).where(and(eq(anonymoWithdrawals.keyHash, w.keyHash), eq(anonymoWithdrawals.idempotencyKey, w.idempotencyKey)));
    if (prior) {
      const same = prior.chain === chain && prior.toAddr === to && prior.token === token && (requested === "all" || prior.amountPico === requested);
      if (!same) fail(409, "This Idempotency-Key was already used for a different withdrawal.", "idempotency_conflict");
      return { row: prior, replay: true };
    }
    const [acct] = await tx.select().from(accounts).where(eq(accounts.id, w.accountId)).for("update");
    const available = acct ? acct.balance - acct.held : 0n;
    const dests = await withdrawDestinations(tx, w.keyHash);
    const d = dests.get(dest(chain, to));
    if (!d) fail(403, "Withdrawals go only to an address this key's deposits came from, on the same chain.", "not_source_address", { allowed: [...dests.values()].map((x) => ({ chain: x.chain, address: x.address })) });
    const sourceCap = d.remaining ?? available;
    const max = sourceCap < available ? sourceCap : available;
    const amount = requested === "all" ? max : requested;
    if (amount <= 0n) fail(402, "Nothing is available to withdraw to this address.", "nothing_to_withdraw", { available_usd: picoToUsd(available > 0n ? available : 0n) });
    if (amount > available) fail(402, `Only $${picoToUsd(available > 0n ? available : 0n)} is available (balance less open holds).`, "insufficient_balance", { available_usd: picoToUsd(available > 0n ? available : 0n) });
    if (amount > sourceCap) fail(403, `At most $${picoToUsd(sourceCap)} can go back to this address: that is what came from it.`, "exceeds_source", { max_usd: picoToUsd(sourceCap) });
    if (amount < o.minPico) fail(400, `The smallest withdrawal is $${picoToUsd(o.minPico)}.`, "below_minimum");
    const id = uid("wd_");
    const [row] = await tx
      .insert(anonymoWithdrawals)
      .values({ id, keyHash: w.keyHash, accountId: w.accountId, idempotencyKey: w.idempotencyKey, chain, token, toAddr: to, amountPico: amount })
      .returning();
    await post(tx, { accountId: w.accountId, keyHash: w.keyHash, amount: -amount, kind: "withdraw", ref: `wd:${id}`, description: `Withdrawal to ${chain}` });
    return { row, replay: false };
  });
}

/** Try to pay one pending withdrawal. A failure keeps it pending (retried by the job); it is never dropped. */
export async function attemptPayout(db: Db, payout: Payout, id: string): Promise<WithdrawalRow> {
  const [w] = await db.select().from(anonymoWithdrawals).where(eq(anonymoWithdrawals.id, id));
  if (!w) throw new ApiError(404, "Unknown withdrawal.", "not_found");
  if (w.status !== "pending") return w;
  try {
    const { txRef } = await payout.send({ id: w.id, chain: w.chain as PayoutChain, token: w.token, to: w.toAddr, amountPico: w.amountPico });
    const [done] = await db
      .update(anonymoWithdrawals)
      .set({ status: "sent", txRef, sentAt: new Date(), attempts: sql`${anonymoWithdrawals.attempts} + 1`, lastError: null })
      .where(and(eq(anonymoWithdrawals.id, id), eq(anonymoWithdrawals.status, "pending")))
      .returning();
    return done ?? w;
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
    log.warn("anonymo payout attempt failed; withdrawal stays pending", { id, chain: w.chain });
    const [still] = await db.update(anonymoWithdrawals).set({ attempts: sql`${anonymoWithdrawals.attempts} + 1`, lastError: reason }).where(eq(anonymoWithdrawals.id, id)).returning();
    return still ?? w;
  }
}

export async function processPendingWithdrawals(db: Db, payout: Payout, limit = 100) {
  const rows = await db.select({ id: anonymoWithdrawals.id }).from(anonymoWithdrawals).where(eq(anonymoWithdrawals.status, "pending")).orderBy(anonymoWithdrawals.createdAt).limit(limit);
  let sent = 0;
  for (const r of rows) if ((await attemptPayout(db, payout, r.id)).status === "sent") sent++;
  return { pending: rows.length, sent };
}

/** Operator only, for a payout that can never be delivered: return the amount to the key's balance. Not an API route. */
export async function revertWithdrawal(db: Db, id: string) {
  return db.transaction(async (tx) => {
    const [w] = await tx.update(anonymoWithdrawals).set({ status: "reverted" }).where(and(eq(anonymoWithdrawals.id, id), eq(anonymoWithdrawals.status, "pending"))).returning();
    if (!w) return false;
    return post(tx, { accountId: w.accountId, keyHash: w.keyHash, amount: w.amountPico, kind: "withdraw_revert", ref: `wd-revert:${id}`, description: "Withdrawal returned" });
  });
}

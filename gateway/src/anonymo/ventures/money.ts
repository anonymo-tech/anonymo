// WS11 · how a venture is paid for (Ventures Overview §6, Backend Law 6).
//
// Starting a run moves its fixed price from the owner's account to a crew key minted for that run alone. Every model
// call the crew makes is an ordinary gateway call billed to that crew key, so the floor gate, the refusal catch
// (refused attempts free), receipts and spend caps all apply unchanged. The crew key's lifetime cap is the price, so the
// run can never spend more than it was sold for. Sandbox minutes are charged to the same crew account.
//
// Before money moves, the owner key's own daily, monthly and lifetime caps are checked (keys/caps.ts), and the transfer
// itself is recorded against the owner key, so it counts toward those caps like any other spend. When the run ends the
// unused part of the price is kept (the price is all-in) and moved to the ventures house account.

import { eq, sql } from "drizzle-orm";
import type { Ctx } from "../../context.ts";
import { registerRootKey } from "../../api/auth.ts";
import { generateApiKey } from "../../chain/keys.ts";
import { accounts } from "../../db/schema.ts";
import { ensureAccount, post } from "../../ledger/ledger.ts";
import { fail } from "../../lib/errors.ts";
import type { Pico } from "../../lib/money.ts";
import { decrypt, encrypt } from "../../lib/util.ts";
import { capsVerdict, spentByKey } from "../keys/caps.ts";
import { crewBudgetOf, FUEL_POOL_BPS } from "./pricing.ts";
import { anonymoKeys } from "../deposits/schema.ts";

export const HOUSE_ACCOUNT = "ventures_house";
/** Build Fuel credits are paid out of this pool, which only finished runs fill (5% of their price). */
export const FUEL_POOL_ACCOUNT = "ventures_fuel_pool";

export type CrewWallet = { secret: string; keyHash: string; accountId: string; enc: string };

async function available(tx: Pick<Ctx["db"], "select">, accountId: string): Promise<Pico> {
  const [row] = await tx.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, accountId)).for("update");
  return row ? row.balance - row.held : 0n;
}

/** Throws 402/403 when the owner's own key caps (daily, monthly, lifetime) say no to spending `amount` now. */
export async function checkOwnerCaps(ctx: Ctx, ownerKeyHash: string, amount: Pico) {
  const [caps] = await ctx.db.select().from(anonymoKeys).where(eq(anonymoKeys.keyHash, ownerKeyHash));
  if (!caps) return;
  const spent = await spentByKey(ctx.db, ownerKeyHash);
  // The transfer is spend, so it must fit under every cap, not merely start under it.
  const after = { day: spent.day + amount - 1n, month: spent.month + amount - 1n, life: spent.life + amount - 1n };
  const refusal = capsVerdict({ ...caps, ipAllow: null, sealedOnly: false }, after, { ip: null, sealed: false });
  if (refusal) fail(refusal.status, refusal.message, refusal.code);
}

/**
 * Opens the run's crew wallet holding the whole price: `amount` from the owner's balance, `sponsored` from a Checkout
 * order paid on chain (sponsoredKind "checkout_order", recorded as house money) or from Build Fuel (sponsoredKind
 * "build_fuel", taken out of the fuel pool, which must hold it). The crew key's lifetime cap is 80% of the total
 * (crewBudgetOf), so the 20% margin can never be spent.
 */
export async function openCrewWallet(ctx: Ctx, o: { ventureId: string; ownerKeyHash: string; ownerAccountId: string; amount: Pico; sponsored?: Pico; sponsoredKind?: string }): Promise<CrewWallet> {
  const sponsored = o.sponsored ?? 0n;
  if (o.amount > 0n) await checkOwnerCaps(ctx, o.ownerKeyHash, o.amount);
  const secret = generateApiKey();
  const key = await registerRootKey(ctx, secret, `venture ${o.ventureId}`);
  await ctx.db.insert(anonymoKeys).values({ keyHash: key.keyHash, lifetimeCap: crewBudgetOf(o.amount + sponsored) }).onConflictDoNothing();
  await ctx.db.transaction(async (tx) => {
    if (o.amount > 0n) {
      const have = await available(tx, o.ownerAccountId);
      if (have < o.amount) fail(402, `This run costs $${Number(o.amount) / 1e12} and the key has $${Number(have) / 1e12} available.`, "insufficient_balance");
      await post(tx, { accountId: o.ownerAccountId, keyHash: o.ownerKeyHash, amount: -o.amount, kind: "venture_purchase", ref: `venture:${o.ventureId}:purchase`, description: "Anonymo Ventures run" });
      await post(tx, { accountId: key.accountId, keyHash: key.keyHash, amount: o.amount, kind: "venture_budget", ref: `venture:${o.ventureId}:budget`, description: "crew budget" });
    }
    if (sponsored > 0n) {
      if (o.sponsoredKind === "build_fuel") {
        // Fuel is backed: it comes out of the pool earlier runs filled, never out of thin air.
        await ensureAccount(tx, FUEL_POOL_ACCOUNT, "house");
        const pool = await available(tx, FUEL_POOL_ACCOUNT);
        if (pool < sponsored) fail(409, "The Build Fuel pool can't cover these credits right now; pay from the balance instead.", "fuel_pool_empty");
        await post(tx, { accountId: FUEL_POOL_ACCOUNT, amount: -sponsored, kind: "build_fuel", ref: `venture:${o.ventureId}:fuel`, description: "Build Fuel credits spent on a run" });
      }
      await post(tx, { accountId: key.accountId, keyHash: key.keyHash, amount: sponsored, kind: o.sponsoredKind ?? "venture_sponsored", ref: `venture:${o.ventureId}:sponsored`, description: "crew budget paid on chain or by Build Fuel" });
    }
  });
  return { secret, keyHash: key.keyHash, accountId: key.accountId, enc: encrypt(ctx.cfg.appSecret, secret) };
}

/** Adds to an existing crew wallet (Run Mode's daily top-up); the crew key's lifetime cap grows by the same amount. */
export async function topUpCrewWallet(ctx: Ctx, o: { ventureId: string; ref: string; ownerKeyHash: string; ownerAccountId: string; crewKeyHash: string; crewAccountId: string; amount: Pico; fee: Pico }): Promise<boolean> {
  await checkOwnerCaps(ctx, o.ownerKeyHash, o.amount);
  return ctx.db.transaction(async (tx) => {
    const have = await available(tx, o.ownerAccountId);
    if (have < o.amount) return false;
    const fresh = await post(tx, { accountId: o.ownerAccountId, keyHash: o.ownerKeyHash, amount: -o.amount, kind: "venture_run_mode", ref: `${o.ref}:debit`, description: "Run Mode day" });
    if (!fresh) return true;
    await ensureAccount(tx, HOUSE_ACCOUNT, "house");
    if (o.fee > 0n) await post(tx, { accountId: HOUSE_ACCOUNT, amount: o.fee, kind: "venture_fee", ref: `${o.ref}:fee` });
    await post(tx, { accountId: o.crewAccountId, keyHash: o.crewKeyHash, amount: o.amount - o.fee, kind: "venture_budget", ref: `${o.ref}:budget` });
    await tx
      .update(anonymoKeys)
      .set({ lifetimeCap: sql`coalesce(${anonymoKeys.lifetimeCap}, 0) + ${o.amount - o.fee}` })
      .where(eq(anonymoKeys.keyHash, o.crewKeyHash));
    return true;
  });
}

/** Charges sandbox minutes to the crew account. Returns false (charging nothing) when the budget can't cover it. */
export async function chargeCrew(ctx: Ctx, o: { accountId: string; keyHash: string; amount: Pico; ref: string; kind?: string }): Promise<boolean> {
  if (o.amount <= 0n) return true;
  return ctx.db.transaction(async (tx) => {
    const have = await available(tx, o.accountId);
    if (have < o.amount) return false;
    await post(tx, { accountId: o.accountId, keyHash: o.keyHash, amount: -o.amount, kind: o.kind ?? "venture_sandbox", ref: o.ref });
    return true;
  });
}

export async function crewAvailable(ctx: Ctx, accountId: string): Promise<Pico> {
  const [row] = await ctx.db.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, accountId));
  return row ? row.balance - row.held : 0n;
}

/**
 * At the end of a run, whatever the crew didn't use moves on.
 *  - A finished run keeps its all-in price: 5% of the price goes to the Build Fuel pool, the rest of the leftover to
 *    the house.
 *  - A run that failed, hit a floor block or was cancelled refunds the owner, but never more than the owner paid in
 *    cash from their balance (`refundCap`): credits and on-chain orders don't turn into withdrawable balance.
 */
export async function settleCrewWallet(ctx: Ctx, o: { ventureId: string; accountId: string; keyHash: string; price?: Pico; ref?: string; refundTo?: { accountId: string; keyHash: string }; refundCap?: Pico; costTracked?: Pico }): Promise<{ refunded: Pico; fuel: Pico; house: Pico }> {
  return ctx.db.transaction(async (tx) => {
    const left = await available(tx, o.accountId);
    const none = { refunded: 0n, fuel: 0n, house: 0n };
    if (left <= 0n) return none;
    const ref = o.ref ?? `venture:${o.ventureId}:settle`;
    const fresh = await post(tx, { accountId: o.accountId, keyHash: o.keyHash, amount: -left, kind: "venture_settle", ref });
    if (!fresh) return none;
    let rest = left;
    let refunded = 0n;
    let fuel = 0n;
    if (o.refundTo) {
      // Refused attempts cost the provider money but were never billed to the crew key: that part of the leftover
      // paid for them, so it is kept, not refunded.
      const billed = o.price !== undefined ? o.price - left : 0n;
      const unbilled = o.costTracked !== undefined && o.costTracked > billed ? o.costTracked - billed : 0n;
      const refundable = rest > unbilled ? rest - unbilled : 0n;
      refunded = o.refundCap === undefined ? refundable : refundable < o.refundCap ? refundable : o.refundCap;
      if (refunded > 0n) await post(tx, { accountId: o.refundTo.accountId, amount: refunded, kind: "venture_refund", ref: `${ref}:refund`, description: "unused budget of a run that did not finish" });
      rest -= refunded;
    } else if (o.price) {
      const share = (o.price * FUEL_POOL_BPS) / 10_000n;
      fuel = share < rest ? share : rest;
      if (fuel > 0n) {
        await ensureAccount(tx, FUEL_POOL_ACCOUNT, "house");
        await post(tx, { accountId: FUEL_POOL_ACCOUNT, amount: fuel, kind: "venture_fuel_pool", ref: `${ref}:fuel` });
      }
      rest -= fuel;
    }
    if (rest > 0n) {
      await ensureAccount(tx, HOUSE_ACCOUNT, "house");
      await post(tx, { accountId: HOUSE_ACCOUNT, amount: rest, kind: "venture_settle", ref: `${ref}:house` });
    }
    return { refunded, fuel, house: rest };
  });
}

export const crewSecret = (ctx: Ctx, enc: string) => decrypt(ctx.cfg.appSecret, enc);

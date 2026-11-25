import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { parseAbiItem, type Hex } from "viem";
import { type KeyRow } from "../../api/auth.ts";
import type { Ctx } from "../../context.ts";
import { accounts, keys, ledger } from "../../db/schema.ts";
import { post } from "../../ledger/ledger.ts";
import { fail } from "../../lib/errors.ts";
import { hmac } from "../../lib/util.ts";
import { FUNDING_KINDS } from "../freetier/policy.ts";
import { effectiveCut, firstCreatorFunding } from "./accrual.ts";
import { DAY_MS } from "./counters.ts";
import { creatorReferralLinks, creatorReferrals } from "./schema.ts";

const WINDOW = 90 * DAY_MS;
export const referralEnds = (fundedAt: Date) => new Date(fundedAt.getTime() + WINDOW);
export const REFERRAL_CREDIT = "referral_credit";

export async function referralLink(ctx: Ctx, key: KeyRow) {
  await ctx.db.insert(creatorReferralLinks).values({ inviterKeyHash: key.keyHash }).onConflictDoNothing();
  const [link] = await ctx.db.select({ code: creatorReferralLinks.code }).from(creatorReferralLinks).where(eq(creatorReferralLinks.inviterKeyHash, key.keyHash));
  return link!.code;
}

export async function acceptReferral(ctx: Ctx, key: KeyRow, code: string) {
  if (ctx.cfg.creators.referralBonus === 0n) fail(503, "Referral credits are unavailable.", "referrals_unavailable");
  await ctx.db.transaction(async (tx) => {
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, key.accountId)).for("update");
    const [existing] = await tx.select().from(creatorReferrals).where(eq(creatorReferrals.inviteeAccountId, key.accountId));
    if (existing?.inviteeKeyHash === key.keyHash && existing.code === code) return;
    const [inviter] = await tx.select({ accountId: keys.accountId }).from(creatorReferralLinks)
      .innerJoin(keys, eq(keys.keyHash, creatorReferralLinks.inviterKeyHash)).where(eq(creatorReferralLinks.code, code));
    const [earlier] = await tx.select({ id: ledger.id }).from(ledger)
      .where(and(eq(ledger.accountId, key.accountId), gt(ledger.amount, 0n), inArray(ledger.kind, FUNDING_KINDS))).limit(1);
    if (existing || !inviter || inviter.accountId === key.accountId || earlier)
      fail(409, "This invite needs a new, unfunded key.", "referral_ineligible");
    await tx.insert(creatorReferrals).values({ inviteeKeyHash: key.keyHash, inviteeAccountId: key.accountId, code });
  });
}

const Registered = parseAbiItem("event Registered(bytes32 indexed inviterHash)");
export async function creatorReferralTick(ctx: Ctx, now = Date.now()) {
  const { referralBonus, referralShareBps, referrals, startBlock } = ctx.cfg.creators;
  if (referralBonus === 0n) return;
  const pairs = await ctx.db.select({ invite: creatorReferrals, inviter: keys }).from(creatorReferrals)
    .innerJoin(creatorReferralLinks, eq(creatorReferralLinks.code, creatorReferrals.code))
    .innerJoin(keys, eq(keys.keyHash, creatorReferralLinks.inviterKeyHash))
    .where(or(isNull(creatorReferrals.fundedAt), gte(creatorReferrals.fundedAt, new Date(now - WINDOW - 7 * DAY_MS))))
    .orderBy(asc(creatorReferrals.acceptedAt));

  for (const { invite, inviter } of pairs) {
    await ctx.db.transaction(async (tx) => {
      const [row] = await tx.select().from(creatorReferrals).where(eq(creatorReferrals.inviteeKeyHash, invite.inviteeKeyHash)).for("update");
      if (!row) return;
      const fundedAt = row.fundedAt ?? await firstCreatorFunding(tx, { keyHash: invite.inviteeKeyHash, accountId: invite.inviteeAccountId });
      if (!fundedAt || fundedAt < row.acceptedAt) return;
      const ref = hmac(ctx.cfg.appSecret, `creator-referral:${invite.inviteeKeyHash}`);
      if (!row.fundedAt) {
        await post(tx, { accountId: inviter.accountId, keyHash: inviter.keyHash, amount: referralBonus, kind: REFERRAL_CREDIT, ref: `referral:inviter:${ref}`, description: "Referral credit" });
        await post(tx, { accountId: invite.inviteeAccountId, keyHash: invite.inviteeKeyHash, amount: referralBonus, kind: REFERRAL_CREDIT, ref: `referral:invitee:${ref}`, description: "Referral credit" });
      }
      // Share only paid usage. Deposit-funded spend is bounded by funding net of completed or pending withdrawals.
      const [totals] = await tx.select({
        spend: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.kind} = 'usage' and ${ledger.amount} < 0), 0)`,
        paid: sql<string>`coalesce(sum(${ledger.amount}) filter (where ${ledger.kind} in ('deposit', 'code', 'code_credit', 'stars_credit', 'withdraw', 'withdraw_revert')), 0)`,
      }).from(ledger).where(and(eq(ledger.accountId, invite.inviteeAccountId), eq(ledger.keyHash, invite.inviteeKeyHash),
        gte(ledger.createdAt, fundedAt), lt(ledger.createdAt, referralEnds(fundedAt))));
      const spend = BigInt(totals!.spend);
      const paid = BigInt(totals!.paid);
      const target = effectiveCut(spend < paid ? spend : paid, referralShareBps);
      if (target > row.spendCredit) await post(tx, {
        accountId: inviter.accountId, keyHash: inviter.keyHash, amount: target - row.spendCredit, kind: REFERRAL_CREDIT,
        ref: `referral:spend:${ref}:${target}`, description: "Referral usage credit",
      });
      await tx.update(creatorReferrals).set({ fundedAt, spendCredit: target > row.spendCredit ? target : row.spendCredit })
        .where(eq(creatorReferrals.inviteeKeyHash, invite.inviteeKeyHash));
    });
  }

  if (!referrals || startBlock === undefined || !ctx.chain.roleAddress("creatorPayouts")) return;
  // The event-only contract carries an inviter commitment, never the referred key. Reconcile prior sends by inviter.
  const pending = await ctx.db.select().from(creatorReferrals)
    .where(and(isNull(creatorReferrals.registeredTx), isNotNull(creatorReferrals.fundedAt))).orderBy(asc(creatorReferrals.fundedAt)).limit(25);
  for (const row of pending) {
    const inviterHash = `0x${hmac(ctx.cfg.appSecret, `referral-inviter:${row.code}`)}` as Hex;
    const [events, recorded] = await Promise.all([
      ctx.chain.client.getLogs({ address: referrals, event: Registered, args: { inviterHash }, fromBlock: startBlock, strict: true }),
      ctx.db.select({ tx: creatorReferrals.registeredTx }).from(creatorReferrals)
        .where(and(eq(creatorReferrals.code, row.code), isNotNull(creatorReferrals.registeredTx))),
    ]);
    const seen = new Set(recorded.map(({ tx }) => tx));
    const existing = events.find(({ transactionHash }) => transactionHash && !seen.has(transactionHash));
    const tx = existing?.transactionHash ?? await ctx.chain.registerCreatorReferral(referrals, inviterHash);
    await ctx.db.update(creatorReferrals).set({ registeredTx: tx }).where(eq(creatorReferrals.inviteeKeyHash, row.inviteeKeyHash));
  }
}

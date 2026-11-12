import { and, asc, desc, eq, isNull, lt, lte, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import { anchors, facilitatorSettlements, generations, receiptKeys } from "../db/schema.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { log } from "../lib/util.ts";
import { anonymoReceiptRoots, anonymoReceipts } from "../db/anonymo-receipts.ts";
import { HOUR_MS, hourOf, receiptRootsPoster } from "../receipts/roots.ts";

// Hourly: build a merkle tree over every receipt leaf (v1, plus v2 where issued, then facilitator settlement receipts) since the last anchor, store the proof
// positions, and post the root to ReceiptAnchor on Robinhood Chain (status "local" when no chain
// is configured, so proofs still work and can be anchored later).

export async function runAnchor(ctx: Ctx, upTo?: Date) {
  // Anonymo receipts (Backend §8) get their own hourly root, posted through the ReceiptRoots poster. It never blocks
  // the anchor below: a failure is logged and retried on the next run.
  const anonymo = await runAnonymoRoots(ctx).catch((e) => {
    log.error("anonymo receipt root failed; will retry", { error: (e as Error).message });
    return { rooted: 0, error: true };
  });
  return { ...(await runV1Anchor(ctx, upTo)), anonymo };
}

async function runV1Anchor(ctx: Ctx, upTo?: Date) {
  // Close only whole seconds, so the exclusive endpoint is never in the future.
  // Late-completing receipts join the next batch by identity, not by timestamp membership.
  const chainConfigured = ctx.chain.address("receiptAnchor") && ctx.chain.roleAddress("anchorer");
  const closedSecond = Math.floor(Date.now() / 1000);
  const toTs = new Date((chainConfigured ? Math.min(closedSecond, await ctx.chain.blockTimestamp()) : closedSecond) * 1000);
  const [last] = await ctx.db.select().from(anchors).orderBy(desc(anchors.index)).limit(1);
  if (last && last.toTs >= toTs) return { anchored: 0 };
  const pending = await ctx.db
    .select({ id: generations.id, leaf: generations.receiptLeaf, leafV2: generations.receiptLeafV2, ts: generations.ts })
    .from(generations)
    .where(and(isNull(generations.anchorIndex), lt(generations.ts, toTs), ...(upTo ? [lte(generations.ts, upTo)] : []), sql`${generations.receiptLeaf} IS NOT NULL`))
    .orderBy(asc(generations.ts), asc(generations.id))
    .limit(200_000);
  // v6 F: facilitator settlement receipts (kind facilitator.settle) join the same root, after the generations.
  const settled = await ctx.db
    .select({ id: facilitatorSettlements.id, leaf: facilitatorSettlements.receiptLeaf, ts: facilitatorSettlements.settledAt })
    .from(facilitatorSettlements)
    .where(and(isNull(facilitatorSettlements.anchorIndex), lt(facilitatorSettlements.settledAt, toTs), ...(upTo ? [lte(facilitatorSettlements.settledAt, upTo)] : []), sql`${facilitatorSettlements.receiptLeaf} IS NOT NULL`))
    .orderBy(asc(facilitatorSettlements.settledAt), asc(facilitatorSettlements.id))
    .limit(200_000);
  if (!pending.length && !settled.length) return { anchored: 0 };
  const index = last ? last.index + 1 : 0;
  // Leaves in receipt order; a receipt with a v2 encoding contributes its v1 leaf and then its v2 leaf.
  const leaves: Hex[] = [];
  const positions = pending.map((p) => {
    const v1 = leaves.push(p.leaf as Hex) - 1;
    const v2 = p.leafV2 ? leaves.push(p.leafV2 as Hex) - 1 : null;
    return { id: p.id, v1, v2 };
  });
  const settledPositions = settled.map((s) => ({ id: s.id, at: leaves.push(s.leaf as Hex) - 1 }));
  const tree = new MerkleTree(leaves);
  const first = Math.min(...[pending[0]?.ts, settled[0]?.ts].filter((d): d is Date => !!d).map((d) => d.getTime()));
  const fromTs = last ? last.toTs : new Date(Math.floor(first / 1000) * 1000);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(anchors).values({ index, root: tree.root, fromTs, toTs, count: leaves.length, status: "pending" });
    for (const pos of positions) await tx.update(generations).set({ anchorIndex: index, leafIndex: pos.v1, leafIndexV2: pos.v2 }).where(eq(generations.id, pos.id));
    for (const pos of settledPositions) await tx.update(facilitatorSettlements).set({ anchorIndex: index, leafIndex: pos.at }).where(eq(facilitatorSettlements.id, pos.id));
  });
  let status = "local";
  let txHash: string | null = null;
  if (ctx.chain.address("receiptAnchor") && ctx.chain.roleAddress("anchorer")) {
    try {
      const r = await ctx.chain.anchor(tree.root, Math.floor(fromTs.getTime() / 1000), Math.floor(toTs.getTime() / 1000), leaves.length);
      status = "confirmed";
      txHash = r.hash;
      if (r.index != null && Number(r.index) !== index) log.warn("on-chain anchor index differs from local index", { local: index, chain: String(r.index) });
    } catch (e) {
      status = "pending";
      log.error("anchor submission failed; will retry", { index, error: (e as Error).message });
    }
  }
  await ctx.db.update(anchors).set({ status, txHash }).where(eq(anchors.index, index));
  return { anchored: pending.length, settlements: settled.length, index, root: tree.root, status, tx: txHash };
}

/** Retry anchors that were built but not yet submitted (chain was down / not configured then). */
export async function retryAnchors(ctx: Ctx) {
  if (!ctx.chain.address("receiptAnchor") || !ctx.chain.roleAddress("anchorer")) return { retried: 0 };
  const rows = await ctx.db.select().from(anchors).where(eq(anchors.status, "pending")).orderBy(asc(anchors.index));
  let n = 0;
  for (const a of rows) {
    try {
      const r = await ctx.chain.anchor(a.root as Hex, Math.floor(a.fromTs.getTime() / 1000), Math.floor(a.toTs.getTime() / 1000), a.count);
      await ctx.db.update(anchors).set({ status: "confirmed", txHash: r.hash }).where(eq(anchors.index, a.index));
      n++;
    } catch (e) {
      log.warn("anchor retry failed", { index: a.index, error: (e as Error).message });
      break; // anchors must land in order
    }
  }
  return { retried: n };
}

/** Weekly signing-key rotation; publish every key's public half on-chain. */
export async function runKeyRotation(ctx: Ctx) {
  const r = await ctx.signer.rotateIfDue();
  let published = 0;
  if (ctx.chain.address("receiptAnchor") && ctx.chain.roleAddress("anchorer")) {
    const unpublished = await ctx.db.select().from(receiptKeys).where(isNull(receiptKeys.onchainTx));
    for (const k of unpublished) {
      try {
        const { hash } = await ctx.chain.registerSigningKey(k.id, k.publicKey, k.validFrom);
        await ctx.db.update(receiptKeys).set({ onchainTx: hash }).where(eq(receiptKeys.id, k.id));
        published++;
      } catch (e) {
        log.warn("signing key publication failed", { key: k.id, error: (e as Error).message });
      }
    }
  }
  return { rotated: r.rotated, key: r.key.id, published };
}

// ---- Anonymo receipt roots (Backend §8) ----------------------------------------------------------------------------
//
// Once an hour has closed, every Anonymo receipt issued before the end of that hour and not yet rooted becomes one leaf
// of that hour's Merkle tree, in (issued_at, id) order. A receipt that commits after its hour was rooted joins the next
// hour's root. Roots are posted through the ReceiptRoots poster (receipts/roots.ts) when one is set, oldest first;
// without one they stay "local" and are posted once a poster is configured. A failed post is retried on the next run.

export async function runAnonymoRoots(ctx: Ctx, now = Date.now()) {
  const hour = hourOf(now) - 1;
  const cutoff = new Date((hour + 1) * HOUR_MS);
  const poster = receiptRootsPoster(ctx);
  let rooted = 0;
  const [existing] = await ctx.db.select({ hour: anonymoReceiptRoots.hour }).from(anonymoReceiptRoots).where(eq(anonymoReceiptRoots.hour, hour));
  if (!existing) {
    const pending = await ctx.db
      .select({ id: anonymoReceipts.id, leaf: anonymoReceipts.leaf })
      .from(anonymoReceipts)
      .where(and(isNull(anonymoReceipts.rootHour), lt(anonymoReceipts.issuedAt, cutoff)))
      .orderBy(asc(anonymoReceipts.issuedAt), asc(anonymoReceipts.id))
      .limit(500_000);
    if (pending.length) {
      const tree = new MerkleTree(pending.map((p) => p.leaf as Hex));
      await ctx.db.transaction(async (tx) => {
        await tx.insert(anonymoReceiptRoots).values({ hour, root: tree.root, count: pending.length, status: poster ? "pending" : "local" });
        for (const [i, p] of pending.entries()) await tx.update(anonymoReceipts).set({ rootHour: hour, leafIndex: i }).where(eq(anonymoReceipts.id, p.id));
      });
      rooted = pending.length;
    }
  }
  let posted = 0;
  if (poster) {
    const unposted = await ctx.db.select().from(anonymoReceiptRoots).where(sql`${anonymoReceiptRoots.status} <> 'posted'`).orderBy(asc(anonymoReceiptRoots.hour));
    for (const r of unposted) {
      try {
        const { txHash } = await poster.post(BigInt(r.hour), r.root as Hex);
        await ctx.db.update(anonymoReceiptRoots).set({ status: "posted", txHash, postedAt: new Date() }).where(eq(anonymoReceiptRoots.hour, r.hour));
        posted++;
      } catch (e) {
        await ctx.db.update(anonymoReceiptRoots).set({ status: "failed" }).where(eq(anonymoReceiptRoots.hour, r.hour));
        log.warn("ReceiptRoots post failed; will retry", { hour: r.hour, error: (e as Error).message });
      }
    }
  }
  return { hour, rooted, posted };
}

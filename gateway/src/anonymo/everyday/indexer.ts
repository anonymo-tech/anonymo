import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { createPublicClient, getAbiItem, http, type Address, type Hex, type PublicClient } from "viem";
import { CheckoutAbi, StakeCreditsAbi } from "../../chain/abis.ts";
import type { Ctx } from "../../context.ts";
import type { Db, Tx } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { CHAIN_ID, PASS_DURATION_MS, skuBytes, type Sku, type TierRule } from "./policy.ts";
import { passes, passOrders, stakeCheckpoints } from "./schema.ts";

const checkoutPaid = getAbiItem({ abi: CheckoutAbi, name: "Paid" });
const stakeEvents = [
  getAbiItem({ abi: StakeCreditsAbi, name: "Staked" }),
  getAbiItem({ abi: StakeCreditsAbi, name: "Unstaked" }),
  getAbiItem({ abi: StakeCreditsAbi, name: "TierTableSet" }),
] as const;

export const everydayClient = (rpc: string): PublicClient => createPublicClient({ transport: http(rpc, { timeout: 15_000 }) });
export const stakeSlot = (address: Address) => `everyday:stake:${address}`;
const checkoutSlot = (address: Address) => `everyday:checkout:${address}`;
export type IndexState = { block: string; at: string; table?: { minTwab: string; dailyMicroUsd: string }[] };

export async function issuePass(tx: Db | Tx, event: { orderId: Hex; sku: Hex; quantity: bigint; timestamp: bigint }) {
  if (event.quantity !== 1n) return false;
  const where = eq(passOrders.orderId, event.orderId);
  const [order] = await tx.select().from(passOrders).where(where).for("update");
  if (!order || skuBytes(order.sku as Sku) !== event.sku) return false;
  // Serialize renewals for the same key, including across checkouts. A repeat log keeps the original dates.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pass:${order.keyHash}`}, 0))`);
  const paidAt = new Date(Number(event.timestamp) * 1000);
  const [last] = await tx.select({ ends: passes.ends }).from(passes).where(and(
    eq(passes.keyHash, order.keyHash), eq(passes.sku, order.sku), gt(passes.ends, paidAt),
  )).orderBy(desc(passes.ends)).limit(1);
  const starts = last?.ends ?? paidAt;
  const inserted = await tx.insert(passes).values({
    ...order, starts, ends: new Date(starts.getTime() + PASS_DURATION_MS),
  }).onConflictDoNothing().returning({ id: passes.orderId });
  return !!inserted.length;
}

export async function checkpoints(db: Db, contract: Address, wallet: string, from: bigint, through: bigint) {
  const scope = and(eq(stakeCheckpoints.contract, contract), eq(stakeCheckpoints.wallet, wallet));
  const [opening] = await db.select().from(stakeCheckpoints).where(and(scope, lte(stakeCheckpoints.at, from)))
    .orderBy(desc(stakeCheckpoints.at)).limit(1);
  const points = await db.select().from(stakeCheckpoints).where(and(scope, gt(stakeCheckpoints.at, from), lte(stakeCheckpoints.at, through)))
    .orderBy(stakeCheckpoints.at);
  return (opening ? [opening, ...points] : points).map((point) => ({ at: point.at, balance: BigInt(point.balance) }));
}

export function decodeTierTable(table: readonly TierRule[]): NonNullable<IndexState["table"]> {
  return table.map((rule) => ({ minTwab: String(rule.minTwab), dailyMicroUsd: String(rule.dailyMicroUsd) }));
}

export async function scanEveryday(db: Db, client: PublicClient, opts: {
  address: Address; start: bigint; confirmations: number; mode: "checkout" | "stake";
}) {
  if (await client.getChainId() !== CHAIN_ID) throw new Error("Everyday contracts need Robinhood Chain.");
  const head = await client.getBlockNumber({ cacheTime: 0 }) - BigInt(opts.confirmations - 1);
  const slot = opts.mode === "checkout" ? checkoutSlot(opts.address) : stakeSlot(opts.address);
  for (let page = 0; page < 10; page++) {
    const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, slot));
    const state = row?.value as IndexState | undefined;
    const fromBlock = state ? BigInt(state.block) + 1n : opts.start;
    if (fromBlock > head) return;
    const toBlock = fromBlock + 1999n < head ? fromBlock + 1999n : head;
    const range = { address: opts.address, fromBlock, toBlock, strict: true } as const;
    const [end, paid, stakes] = await Promise.all([
      client.getBlock({ blockNumber: toBlock }),
      opts.mode === "checkout" ? client.getLogs({ ...range, event: checkoutPaid }) : [],
      opts.mode === "stake" ? client.getLogs({ ...range, events: stakeEvents }) : [],
    ]);
    const timestamps = new Map<bigint, bigint>([[toBlock, end.timestamp]]);
    const blocks = new Set([...paid, ...stakes].filter((item) => !item.removed).map((item) => item.blockNumber));
    for (const height of blocks) {
      if (height != null && !timestamps.has(height)) timestamps.set(height, (await client.getBlock({ blockNumber: height })).timestamp);
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${slot}, 0))`);
      const [current] = await tx.select({ value: kv.value }).from(kv).where(eq(kv.key, slot));
      if ((current?.value as IndexState | undefined)?.block !== state?.block) return;
      let table = state?.table;
      const ordered = <T extends { removed: boolean; blockNumber: bigint | null; logIndex: number | null }>(logs: T[]) =>
        logs.filter((item) => !item.removed && item.blockNumber != null && item.logIndex != null)
          .sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1);
      for (const item of ordered(paid))
        await issuePass(tx, { ...item.args, timestamp: timestamps.get(item.blockNumber!)! });
      for (const item of ordered(stakes)) {
        if (item.eventName === "TierTableSet") {
          table = decodeTierTable(item.args.table);
          continue;
        }
        const balance = String(item.args.balance);
        await tx.insert(stakeCheckpoints).values({
          contract: opts.address, wallet: item.args.account.toLowerCase(), at: timestamps.get(item.blockNumber!)!, balance,
        }).onConflictDoUpdate({ target: [stakeCheckpoints.contract, stakeCheckpoints.wallet, stakeCheckpoints.at], set: { balance } });
      }
      const value = { block: String(toBlock), at: String(end.timestamp), ...(table ? { table } : {}) };
      await tx.insert(kv).values({ key: slot, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    });
  }
}

export function registerEverydayJobs(ctx: Ctx, client: PublicClient, config: NonNullable<Ctx["cfg"]["everyday"]>) {
  for (const [mode, address, start] of [
    ["checkout", config.checkout, config.checkoutStart],
    ["stake", config.stake, config.stakeStart],
  ] as const) {
    if (!address || start == null) continue;
    ctx.jobs.register(`everyday-${mode}`, 15_000, async () => {
      try { await scanEveryday(ctx.db, client, { address, start, mode, confirmations: config.confirmations }); }
      catch { throw new Error(`Everyday ${mode} indexing failed.`); }
    }, { atStart: true });
  }
}

import { and, asc, eq, gt, isNull, lte, lt, sql } from "drizzle-orm";
import { encodeAbiParameters, keccak256, parseAbiParameters, parseAbiItem, zeroHash, type Hex } from "viem";
import { CreatorPayoutsAbi } from "../../chain/abis.ts";
import { kv } from "../../db/schema.ts";
import type { Ctx } from "../../context.ts";
import { picoToUsdg, usdgToPico } from "../../lib/money.ts";
import { dayOf, DAY_MS, weekDate, weekOf } from "./counters.ts";
import { creatorAccruals, creatorCharacters, payoutRoots, type PayoutLeaf } from "./schema.ts";

type Node = { hash: Hex; sum: bigint };
const LEAF = parseAbiParameters("address, uint256");
const ROOT = parseAbiParameters("bytes32, uint256");
const PAIR = parseAbiParameters("bytes32, uint256, bytes32, uint256");
const rootHash = ({ hash, sum }: Node) => keccak256(encodeAbiParameters(ROOT, [hash, sum]));
export const EMPTY_ROOT = rootHash({ hash: zeroHash, sum: 0n });

export function payoutNode(wallet: Hex, amount: bigint): Node {
  return { hash: keccak256(keccak256(encodeAbiParameters(LEAF, [wallet, amount]))), sum: amount };
}

export function combinePayoutNodes(a: Node, b: Node): Node {
  if (a.hash > b.hash || (a.hash === b.hash && a.sum > b.sum)) [a, b] = [b, a];
  return { hash: keccak256(encodeAbiParameters(PAIR, [a.hash, a.sum, b.hash, b.sum])), sum: a.sum + b.sum };
}

export function payoutTree(wallets: Map<Hex, bigint>) {
  const amounts = [...wallets].filter(([, amount]) => amount > 0n).sort(([a], [b]) => a.localeCompare(b));
  let nodes = amounts.map(([wallet, amount], index) => ({ node: payoutNode(wallet, amount), indices: [index] }));
  const leaves: PayoutLeaf[] = amounts.map(([wallet, amount]) => ({ wallet, amount: String(amount), proof: [] }));
  while (nodes.length > 1) {
    const next: typeof nodes = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const [a, b] = [nodes[i]!, nodes[i + 1]];
      if (!b) {
        next.push(a);
        continue;
      }
      for (const index of a.indices) leaves[index]!.proof.push({ hash: b.node.hash, sum: String(b.node.sum) });
      for (const index of b.indices) leaves[index]!.proof.push({ hash: a.node.hash, sum: String(a.node.sum) });
      next.push({ node: combinePayoutNodes(a.node, b.node), indices: [...a.indices, ...b.indices] });
    }
    nodes = next;
  }
  const top = nodes[0]?.node;
  return { root: top ? rootHash(top) : EMPTY_ROOT, total: String(top?.sum ?? 0n), leaves };
}

export async function stagePayoutWeek(ctx: Pick<Ctx, "db">, week: number, now: number, includeEmpty: boolean) {
  if (week > weekOf(now) - 2) return;
  const weekKey = weekDate(week);
  await ctx.db.transaction(async (tx) => {
    const [prior] = await tx.select({ root: payoutRoots.root }).from(payoutRoots).where(eq(payoutRoots.week, weekKey));
    if (prior) return;
    const rows = await tx.select({
      id: creatorAccruals.characterId, day: creatorAccruals.day, wallet: creatorCharacters.creatorWallet, amount: creatorAccruals.amount, allocated: creatorAccruals.allocated,
    }).from(creatorAccruals).innerJoin(creatorCharacters, eq(creatorCharacters.id, creatorAccruals.characterId))
      .where(and(isNull(creatorAccruals.payoutWeek), eq(creatorAccruals.frozen, false), gt(creatorAccruals.amount, creatorAccruals.allocated),
        lt(creatorAccruals.day, weekDate(week + 1)), lte(creatorAccruals.heldUntil, new Date(now))))
      .orderBy(asc(creatorAccruals.characterId), asc(creatorAccruals.day)).for("update", { of: creatorAccruals });
    const totals = new Map<Hex, bigint>();
    for (const row of rows) {
      const wallet = row.wallet as Hex;
      totals.set(wallet, (totals.get(wallet) ?? 0n) + row.amount - row.allocated);
    }
    const units = new Map([...totals].map(([wallet, pico]) => [wallet, picoToUsdg(pico, "floor")]));
    const tree = payoutTree(units);
    if (!includeEmpty && tree.total === "0") return;
    const [inserted] = await tx.insert(payoutRoots).values({ week: weekKey, ...tree }).onConflictDoNothing().returning({ week: payoutRoots.week });
    if (!inserted) return;

    // Apply the paid pico amount to each wallet's oldest days. Sub-unit dust stays in the daily totals for the next root.
    const payable = new Map([...units].map(([wallet, amount]) => [wallet, usdgToPico(amount)]));
    for (const row of rows) {
      const wallet = row.wallet as Hex;
      const remaining = payable.get(wallet)!;
      const due = row.amount - row.allocated;
      const paid = remaining < due ? remaining : due;
      if (paid === 0n) continue;
      payable.set(wallet, remaining - paid);
      await tx.update(creatorAccruals).set({ allocated: row.allocated + paid, ...(paid === due ? { payoutWeek: weekKey } : {}) })
        .where(and(eq(creatorAccruals.characterId, row.id), eq(creatorAccruals.day, row.day)));
    }
  });
}

const RootPosted = parseAbiItem("event RootPosted(uint256 indexed week, bytes32 indexed root, uint256 total)");

export async function creatorPayoutTick(ctx: Ctx, now = Date.now()) {
  await ctx.db.delete(kv).where(and(sql`${kv.key} like 'creators-cap-day:%'`,
    lt(kv.key, `creators-cap-day:${dayOf(now - DAY_MS)}`)));
  const { payouts, startBlock } = ctx.cfg.creators;
  const latest = weekOf(now) - 2;
  // Each mature contract week gets a root, including weeks with only an escrowed tip.
  if (payouts && startBlock !== undefined) {
    const [first, last] = await Promise.all([
      ctx.chain.client.getBlock({ blockNumber: startBlock }),
      ctx.db.select({ week: payoutRoots.week }).from(payoutRoots).orderBy(asc(payoutRoots.week)),
    ]);
    const existing = new Set(last.map((row) => row.week));
    const firstWeek = weekOf(Number(first.timestamp) * 1_000);
    for (let week = firstWeek, staged = 0; week <= latest && staged < 12; week++) {
      if (existing.has(weekDate(week))) continue;
      await stagePayoutWeek(ctx, week, now, true);
      staged++;
    }
  } else {
    await stagePayoutWeek(ctx, latest, now, false);
  }
  if (!payouts || startBlock === undefined || !ctx.chain.roleAddress("creatorPayouts")) return;
  const pending = await ctx.db.select().from(payoutRoots).where(isNull(payoutRoots.tx)).orderBy(asc(payoutRoots.week));
  for (const row of pending) {
    const week = BigInt(weekOf(Date.parse(row.week)));
    const root = row.root as Hex;
    const call = { address: payouts, abi: CreatorPayoutsAbi, args: [week] as const };
    const onChain = await ctx.chain.client.readContract({ ...call, functionName: "rootOf" });
    if (onChain !== zeroHash && onChain !== root) throw new Error("The on-chain creator root differs from the staged root.");
    if (onChain === zeroHash) {
      const funded = await ctx.chain.client.readContract({ ...call, functionName: "funded" });
      if (funded !== BigInt(row.total)) continue;
      const tx = await ctx.chain.postCreatorRoot(payouts, week, root, funded);
      await ctx.db.update(payoutRoots).set({ tx }).where(eq(payoutRoots.week, row.week));
    } else {
      const logs = await ctx.chain.client.getLogs({ address: payouts, event: RootPosted, args: { week, root }, fromBlock: startBlock, strict: true });
      const tx = logs[0]?.transactionHash;
      if (tx) await ctx.db.update(payoutRoots).set({ tx }).where(eq(payoutRoots.week, row.week));
    }
  }
}

export async function walletClaims(ctx: Ctx, wallet: Hex) {
  const { payouts } = ctx.cfg.creators;
  const roots = await ctx.db.select().from(payoutRoots).orderBy(asc(payoutRoots.week));
  return (await Promise.all(roots.map(async (row) => {
    const leaf = row.leaves.find((entry) => entry.wallet === wallet);
    if (!payouts || !row.tx) return leaf ? { ...leaf, week: row.week, epoch: weekOf(Date.parse(row.week)), root: row.root, tx: null, tip: "0" } : null;
    const epoch = weekOf(Date.parse(row.week));
    const call = { address: payouts, abi: CreatorPayoutsAbi };
    const [tip, claimed] = await Promise.all([
      ctx.chain.client.readContract({ ...call, functionName: "tips", args: [BigInt(epoch), wallet] }).catch(() => 0n),
      leaf ? ctx.chain.client.readContract({ ...call, functionName: "claimed", args: [BigInt(epoch), payoutNode(wallet, BigInt(leaf.amount)).hash] }).catch(() => false) : false,
    ]);
    return (leaf && !claimed) || tip > 0n ? {
      week: row.week, epoch, root: row.root, tx: row.tx, wallet, tip: String(tip),
      amount: claimed ? "0" : leaf?.amount ?? "0", proof: claimed ? [] : leaf?.proof ?? [],
    } : null;
  }))).filter((row) => row !== null);
}

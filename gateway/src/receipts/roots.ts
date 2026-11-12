import { asc, eq } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import { MerkleTree } from "./merkle.ts";
import { anonymoReceiptRoots, anonymoReceipts } from "../db/anonymo-receipts.ts";

// Hourly receipt roots (Backend §8, §9). Posting goes through `ReceiptRootsPoster`, so the contract binding (WS08's
// ReceiptRoots: post(uint64 hour, bytes32 root), receipts signer only) can be plugged in without touching this code.
// With no poster set, roots are kept with status "local": proofs still work and can be posted later.

export interface ReceiptRootsPoster {
  /** Post one hour's root. Resolves with the transaction hash once it is mined; rejects on failure. */
  post(hour: bigint, root: Hex): Promise<{ txHash: string }>;
}

const posters = new WeakMap<object, ReceiptRootsPoster | null>();

/** Plug in (or remove, with null) the ReceiptRoots poster for one router. */
export function setReceiptRootsPoster(ctx: Pick<Ctx, "db">, poster: ReceiptRootsPoster | null) {
  posters.set(ctx.db as object, poster);
}
export const receiptRootsPoster = (ctx: Pick<Ctx, "db">): ReceiptRootsPoster | null => posters.get(ctx.db as object) ?? null;

/** IReceiptRoots.post, the only function the poster calls. */
export const RECEIPT_ROOTS_POST_ABI = [
  { type: "function", name: "post", stateMutability: "nonpayable", inputs: [{ name: "hour", type: "uint64" }, { name: "root", type: "bytes32" }], outputs: [] },
  { type: "function", name: "rootOf", stateMutability: "view", inputs: [{ name: "hour", type: "uint64" }], outputs: [{ name: "", type: "bytes32" }] },
] as const;

/**
 * A poster over viem clients: `wallet` is the receipts signer's wallet client, `address` the ReceiptRoots contract.
 * Typed loosely so this module does not depend on the chain config WS05/WS08 own.
 */
export function viemReceiptRootsPoster(o: {
  address: Hex;
  writeContract: (args: { address: Hex; abi: typeof RECEIPT_ROOTS_POST_ABI; functionName: "post"; args: readonly [bigint, Hex] }) => Promise<Hex>;
  waitForReceipt: (hash: Hex) => Promise<{ status: "success" | "reverted" }>;
}): ReceiptRootsPoster {
  return {
    async post(hour, root) {
      const hash = await o.writeContract({ address: o.address, abi: RECEIPT_ROOTS_POST_ABI, functionName: "post", args: [hour, root] as const });
      const r = await o.waitForReceipt(hash);
      if (r.status !== "success") throw new Error(`ReceiptRoots.post reverted (${hash})`);
      return { txHash: hash };
    },
  };
}

export const HOUR_MS = 3_600_000;
export const hourOf = (d: Date | number) => Math.floor((typeof d === "number" ? d : d.getTime()) / HOUR_MS);

/** The leaves of one rooted hour, in leaf order. */
export async function rootLeaves(ctx: Pick<Ctx, "db">, hour: number): Promise<Hex[]> {
  const rows = await ctx.db.select({ leaf: anonymoReceipts.leaf }).from(anonymoReceipts).where(eq(anonymoReceipts.rootHour, hour)).orderBy(asc(anonymoReceipts.leafIndex));
  return rows.map((r) => r.leaf as Hex);
}

export type InclusionProof = { hour: number; root: Hex; leaf: Hex; leaf_index: number; leaf_count: number; proof: Hex[]; status: string; tx_hash: string | null };

/** The Merkle path for a rooted receipt, or null while its hour has not been rooted. Rebuilt from the stored leaves. */
export async function inclusionProof(ctx: Pick<Ctx, "db">, row: { leaf: string; rootHour: number | null; leafIndex: number | null }): Promise<InclusionProof | null> {
  if (row.rootHour == null || row.leafIndex == null) return null;
  const [root] = await ctx.db.select().from(anonymoReceiptRoots).where(eq(anonymoReceiptRoots.hour, row.rootHour));
  if (!root) return null;
  const leaves = await rootLeaves(ctx, row.rootHour);
  const tree = new MerkleTree(leaves);
  if (tree.root.toLowerCase() !== root.root.toLowerCase()) throw new Error(`stored root for hour ${row.rootHour} does not match its leaves`);
  return { hour: row.rootHour, root: root.root as Hex, leaf: row.leaf as Hex, leaf_index: row.leafIndex, leaf_count: leaves.length, proof: tree.proof(row.leafIndex), status: root.status, tx_hash: root.txHash };
}

/** OpenZeppelin MerkleProof.verify-compatible check (sorted-pair keccak256). */
export const verifyInclusion = (leaf: Hex, proof: Hex[], root: Hex) => MerkleTree.verify(leaf, proof, root);

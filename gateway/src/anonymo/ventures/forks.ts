// WS11 · People's Forks and votes, gateway side (Ventures Overview §5, Backend PART 10 ForkFund and VoteRegistry).
//
// The money and the votes live on chain; the gateway reads them:
//  - VoteRegistry: the families that won the last finished CrewFamily epoch narrow the crew's pool
//    (crew/families.ts allowFamilies). No result yet: no restriction.
//  - ForkFund: a fund is opened on chain with targetCommit = keccak256(salt ‖ url). Whoever opened it registers the
//    url and salt here; the gateway checks them against the on-chain commitment and keeps the url encrypted. When the
//    fund triggers (fully funded), the gateway starts a house-funded Build Better run on that url. Once it is done,
//    fulfilPayload() prepares fulfil(fundId, repoHash, receipt) for the gateway's fulfiller key: repoHash is the
//    sha256 of the exported repo, the receipt's licence is MIT and its reportHash is the clean-room root.
// Reads go through a ChainReader, so tests and deployments before the contracts exist can supply their own.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { encodeFunctionData, keccak256, toBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
import type { Ctx } from "../../context.ts";
import { encrypt } from "../../lib/util.ts";
import { forkFundAbi, voteRegistryAbi } from "./chain/abis.ts";
import { allowFamilies } from "./crew/families.ts";
import { receiptBundle } from "./receipt.ts";
import { exportTarball } from "./repo.ts";
import { ventureForks, ventures } from "./store/schema.ts";

export type ForkEvent = { forkId: string; kind: "opened" | "triggered" | "fulfilled" | "refunded"; targetCommit?: string; chainId: number; /** Triggered only: USDG routed, base units. */ usdgRouted?: bigint };

export interface ChainReader {
  forkEvents(): Promise<ForkEvent[]>;
  /** Family names that won the last finished crew epoch, or null when there is no result yet. */
  crewFamilies(): Promise<string[] | null>;
}

const CURRENT_EPOCH_ABI = [{ type: "function", name: "currentEpoch", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }] as const;

/** bytes32 option ids hold short ascii names (right-padded with zeros). */
export const optionName = (x: Hex) => Buffer.from(toBytes(x)).toString("utf8").replace(/\0+$/, "").trim().toLowerCase();
export const optionId = (name: string) => toHex(toBytes(name.toLowerCase().slice(0, 32)), { size: 32 });

export function viemReader(client: PublicClient, o: { forkFund?: Address; voteRegistry?: Address; chainId: number; fromBlock?: bigint; seats?: number }): ChainReader {
  return {
    async forkEvents() {
      if (!o.forkFund) return [];
      const logs = (await client.getContractEvents({ address: o.forkFund, abi: forkFundAbi, fromBlock: o.fromBlock ?? 0n })) as unknown as { eventName: string; args: Record<string, unknown> }[];
      const kinds: Record<string, ForkEvent["kind"]> = { Opened: "opened", Triggered: "triggered", Fulfilled: "fulfilled", Refunded: "refunded" };
      return logs.flatMap((l) => (kinds[l.eventName] && l.args.fundId !== undefined ? [{ forkId: String(l.args.fundId), kind: kinds[l.eventName]!, targetCommit: typeof l.args.targetCommit === "string" ? l.args.targetCommit : undefined, chainId: o.chainId, ...(l.args.usdgRouted !== undefined ? { usdgRouted: BigInt(l.args.usdgRouted as bigint) } : {}) }] : []));
    },
    async crewFamilies() {
      if (!o.voteRegistry) return null;
      const epoch = (await client.readContract({ address: o.voteRegistry, abi: CURRENT_EPOCH_ABI, functionName: "currentEpoch" })) as bigint;
      if (epoch === 0n) return null;
      const [options, tallies] = (await client.readContract({ address: o.voteRegistry, abi: voteRegistryAbi, functionName: "results", args: [epoch - 1n, 0] })) as readonly [readonly Hex[], readonly bigint[]];
      return winners(options, tallies, o.seats ?? 8);
    },
  };
}

/** The top `seats` options with any votes, by tally. */
export function winners(options: readonly Hex[], tallies: readonly bigint[], seats: number): string[] | null {
  const ranked = options.map((id, i) => ({ id, t: tallies[i] ?? 0n })).filter((x) => x.t > 0n).sort((a, b) => (b.t > a.t ? 1 : b.t < a.t ? -1 : 0));
  const names = ranked.slice(0, seats).map((x) => optionName(x.id)).filter(Boolean);
  return names.length ? names : null;
}

/** Applies on-chain fork events to venture_forks. Returns the ids of forks that are newly triggered. */
export async function syncForks(ctx: Ctx, reader: ChainReader): Promise<string[]> {
  const order = { opened: 0, triggered: 1, underfunded: 2, building: 2, fulfilled: 3, refunded: 3 } as const;
  const newly: string[] = [];
  for (const e of await reader.forkEvents()) {
    const [cur] = await ctx.db.select().from(ventureForks).where(eq(ventureForks.forkId, e.forkId));
    if (!cur) {
      await ctx.db.insert(ventureForks).values({ forkId: e.forkId, chainId: e.chainId, targetCommit: e.targetCommit ?? "", status: e.kind, usdgRouted: e.usdgRouted ?? null });
      if (e.kind === "triggered") newly.push(e.forkId);
      continue;
    }
    if (e.targetCommit && !cur.targetCommit) await ctx.db.update(ventureForks).set({ targetCommit: e.targetCommit }).where(eq(ventureForks.forkId, e.forkId));
    if (order[e.kind] > order[cur.status as keyof typeof order]) {
      await ctx.db.update(ventureForks).set({ status: e.kind, updatedAt: new Date(), ...(e.usdgRouted !== undefined ? { usdgRouted: e.usdgRouted } : {}) }).where(eq(ventureForks.forkId, e.forkId));
      if (e.kind === "triggered") newly.push(e.forkId);
    }
  }
  return newly;
}

export const targetCommitOf = (salt: Hex, url: string) => keccak256(new Uint8Array([...toBytes(salt), ...toBytes(url)]));

/** Registers a fork's url: it must match the commitment the fund was opened with. */
export async function registerForkTarget(ctx: Ctx, forkId: string, url: string, salt: Hex): Promise<boolean> {
  const [f] = await ctx.db.select().from(ventureForks).where(eq(ventureForks.forkId, forkId));
  if (!f || !f.targetCommit) return false;
  if (targetCommitOf(salt, url).toLowerCase() !== f.targetCommit.toLowerCase()) return false;
  await ctx.db.update(ventureForks).set({ targetEnc: encrypt(ctx.cfg.appSecret, url), updatedAt: new Date() }).where(eq(ventureForks.forkId, forkId));
  return true;
}

/** Narrows the crew to the families holders voted in (no result: no restriction). */
export async function syncVotes(reader: ChainReader) {
  const fams = await reader.crewFamilies();
  allowFamilies(fams && fams.length ? fams : null);
  return fams;
}

/** The fulfil(fundId, repoHash, receipt) call for a built fork, for the gateway's fulfiller key to send. */
export async function fulfilPayload(ctx: Ctx, forkId: string, forkFund: Address, root?: string, now = new Date()) {
  const [f] = await ctx.db.select().from(ventureForks).where(eq(ventureForks.forkId, forkId));
  if (!f?.ventureId) return null;
  const [v] = await ctx.db.select().from(ventures).where(eq(ventures.id, f.ventureId));
  if (!v || v.status !== "DONE") return null;
  const tar = await exportTarball(root, v.id);
  if (!tar) return null;
  const repoHash = ("0x" + createHash("sha256").update(tar).digest("hex")) as Hex;
  const bundle = await receiptBundle(ctx, v.id);
  const reportHash = bundle!.clean_room.root;
  const receipt = { targetCommit: f.targetCommit as Hex, repoHash, licenceSpdxHash: keccak256(toBytes("MIT")), reportHash, issuedAt: BigInt(Math.floor(now.getTime() / 1000)) };
  await ctx.db.update(ventureForks).set({ repoHash, receiptRoot: reportHash, updatedAt: now }).where(eq(ventureForks.forkId, forkId));
  const data = encodeFunctionData({ abi: forkFundAbi, functionName: "fulfil", args: [BigInt(forkId), repoHash, receipt] });
  return { forkId, to: forkFund, repoHash, receipt: { ...receipt, issuedAt: Number(receipt.issuedAt) }, data };
}

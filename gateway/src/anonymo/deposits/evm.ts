// EVM deposit watcher: USDC, USDT and USDG on Base, Arbitrum and Robinhood Chain through DepositRouter (WS08).
// The router emits Deposited(bytes32 keyCommit, address token, uint256 amount) and forwards the tokens to the treasury Safe,
// so no per-key wallet ever holds funds. A log is credited once it is `confirmations` blocks deep, only for an allowlisted
// token, and only when its keyCommit belongs to a key. The source (refund) address is the transaction sender.
// Our own ABI fragment, matching contracts/src/anonymo/interfaces/IAnonymo.sol, so this does not depend on chain/abis.ts.

import { createPublicClient, http, parseAbiItem, type Hex } from "viem";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { log } from "../../lib/util.ts";
import { keyForDepositAddress } from "./addresses.ts";
import type { EvmChainConfig } from "./config.ts";
import type { AnonymoDepositSink } from "./sink.ts";
import { stableRawToPico } from "./units.ts";

export const DEPOSITED_EVENT = parseAbiItem("event Deposited(bytes32 indexed keyCommit, address indexed token, uint256 amount)");

export type DepositedLog = {
  args: { keyCommit?: Hex; token?: Hex; amount?: bigint };
  transactionHash: Hex | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  removed?: boolean;
};

/** The three RPC reads the watcher needs; tests pass a mock. */
export type EvmReader = {
  getBlockNumber(): Promise<bigint>;
  getDepositLogs(o: { address: Hex; fromBlock: bigint; toBlock: bigint }): Promise<DepositedLog[]>;
  getTransactionSender(hash: Hex): Promise<Hex>;
};

export function rpcEvmReader(rpcUrl: string): EvmReader {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
  return {
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    getDepositLogs: ({ address, fromBlock, toBlock }) => client.getLogs({ address, event: DEPOSITED_EVENT, fromBlock, toBlock, strict: false }) as Promise<DepositedLog[]>,
    getTransactionSender: async (hash) => (await client.getTransaction({ hash })).from,
  };
}

const cursorKey = (chain: string) => `anonymo:cursor:evm:${chain}`;

async function readCursor(db: Db, chain: string): Promise<bigint | null> {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, cursorKey(chain)));
  const v = (row?.value as { block?: string } | undefined)?.block;
  return v ? BigInt(v) : null;
}
async function writeCursor(db: Db, chain: string, block: bigint) {
  const value = { block: block.toString() };
  await db.insert(kv).values({ key: cursorKey(chain), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

export type EvmScanResult = { chain: string; from: string | null; to: string | null; credited: number; held: number; skipped: number };

/** Scan one chain from its cursor up to head - confirmations. Safe to re-run: credits are idempotent on the log's ref. */
export async function scanEvmChain(db: Db, cfg: EvmChainConfig, reader: EvmReader, sink: AnonymoDepositSink): Promise<EvmScanResult> {
  const out: EvmScanResult = { chain: cfg.chain, from: null, to: null, credited: 0, held: 0, skipped: 0 };
  const head = await reader.getBlockNumber();
  const safe = head - BigInt(cfg.confirmations);
  const cursor = await readCursor(db, cfg.chain);
  let from = cursor === null ? BigInt(cfg.startBlock) : cursor + 1n;
  if (safe < from) return out;
  out.from = from.toString();
  const tokens = new Map(cfg.tokens.map((t) => [t.address, t]));
  while (from <= safe) {
    const to = from + BigInt(cfg.maxRange) - 1n < safe ? from + BigInt(cfg.maxRange) - 1n : safe;
    const logs = await reader.getDepositLogs({ address: cfg.router, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const { keyCommit, token, amount } = l.args;
      if (l.removed || !l.transactionHash || l.logIndex == null || !keyCommit || !token || amount == null) {
        out.skipped++;
        continue;
      }
      const t = tokens.get(token.toLowerCase() as Hex);
      if (!t || amount <= 0n) {
        log.warn("anonymo evm deposit of a token outside the allowlist; not credited", { chain: cfg.chain, tx: l.transactionHash });
        out.skipped++;
        continue;
      }
      const keyHash = await keyForDepositAddress(db, "evm", keyCommit);
      if (!keyHash) {
        log.warn("anonymo evm deposit to an unknown key commitment; not credited", { chain: cfg.chain, tx: l.transactionHash });
        out.skipped++;
        continue;
      }
      const sender = (await reader.getTransactionSender(l.transactionHash)).toLowerCase();
      const amountPico = stableRawToPico(amount, t.decimals);
      if (amountPico <= 0n) {
        out.skipped++;
        continue;
      }
      const r = await sink.creditWith(
        { keyHash, chain: cfg.chain, amount: amountPico, ref: `${cfg.chain}:${l.transactionHash.toLowerCase()}:${l.logIndex}`, sourceAddr: sender },
        { token: t.symbol, amountRaw: amount },
      );
      if (r.credited) out.credited++;
      else if (r.held) out.held++;
    }
    await writeCursor(db, cfg.chain, to);
    out.to = to.toString();
    from = to + 1n;
  }
  return out;
}

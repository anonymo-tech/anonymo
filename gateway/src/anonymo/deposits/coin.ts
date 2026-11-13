// Paying with the coin (ANMO) through CoinPay on Robinhood Chain. CoinPay burns the coins and emits
// Paid(bytes32 keyCommit, address payer, uint256 amount). Usage is priced in USD, so a payment is credited at the coin's
// USD value when the watcher sees it confirmed:
//   price = min(spot, time-weighted average over `twapSeconds`) from the coin's Uniswap v3 pool against a USD stablecoin
// Taking the lower of the two means a short pump of the pool can never raise the credit. If the pool cannot give a price
// (no pool, too little liquidity, too little oracle history), the scan stops without moving its cursor and the payment
// is credited on a later run: the coins are already burned, so a payment is never dropped. A payment worth more than
// `maxUsdPerPayment` is recorded as held for an operator. Coin credit is usage only: withdraw.ts never pays it out.
// The key commitment is the same per-key EVM commitment the DepositRouter uses (addresses.ts).

import { createPublicClient, http, parseAbi, parseAbiItem, type Hex } from "viem";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import { log } from "../../lib/util.ts";
import { keyForDepositAddress } from "./addresses.ts";
import type { CoinConfig } from "./config.ts";
import type { AnonymoDepositSink } from "./sink.ts";

export const PAID_EVENT = parseAbiItem("event Paid(bytes32 indexed keyCommit, address indexed payer, uint256 amount)");

const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

export type PaidLog = {
  args: { keyCommit?: Hex; payer?: Hex; amount?: bigint };
  transactionHash: Hex | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  removed?: boolean;
};

/** What the pool says: its two tokens, in-range liquidity, the spot tick and the average tick over the window. */
export type PoolState = { token0: Hex; token1: Hex; liquidity: bigint; spotTick: number; twapTick: number };

export type CoinReader = {
  getBlockNumber(): Promise<bigint>;
  getPaidLogs(o: { address: Hex; fromBlock: bigint; toBlock: bigint }): Promise<PaidLog[]>;
  /** Null when the pool cannot answer (no pool, or not enough observation history for the window). */
  poolState(pool: Hex, twapSeconds: number): Promise<PoolState | null>;
};

export function rpcCoinReader(rpcUrl: string): CoinReader {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
  return {
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    getPaidLogs: ({ address, fromBlock, toBlock }) => client.getLogs({ address, event: PAID_EVENT, fromBlock, toBlock, strict: false }) as Promise<PaidLog[]>,
    poolState: async (pool, twapSeconds) => {
      try {
        const [token0, token1, liquidity, slot0, observed] = await Promise.all([
          client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: "observe", args: [[twapSeconds, 0]] }),
        ]);
        const [then, now] = observed[0];
        return { token0, token1, liquidity, spotTick: slot0[1], twapTick: twapTickOf(now - then, twapSeconds) };
      } catch (e) {
        log.warn("anonymo coin pool read failed", { pool, error: (e as Error).message.split("\n")[0].slice(0, 160) });
        return null;
      }
    },
  };
}

/** Uniswap's arithmetic-mean tick: the cumulative delta over the window, rounded toward negative infinity. */
export function twapTickOf(delta: bigint, seconds: number): number {
  const s = BigInt(seconds);
  let t = delta / s;
  if (delta < 0n && delta % s !== 0n) t -= 1n;
  return Number(t);
}

/**
 * Pico-USD per whole coin at `tick`, rounded down. A v3 tick prices token1 in token0 as 1.0001^tick (raw units); the
 * quote stablecoin counts as exactly $1.
 */
export function picoPerCoinAtTick(tick: number, coinIsToken0: boolean, coinDecimals: number, quoteDecimals: number): Pico {
  const rawQuotePerRawCoin = Math.pow(1.0001, coinIsToken0 ? tick : -tick);
  const usdPerCoin = rawQuotePerRawCoin * Math.pow(10, coinDecimals - quoteDecimals);
  const pico = Math.floor(usdPerCoin * 1e12);
  if (!Number.isFinite(pico) || pico < 0) return 0n;
  return BigInt(pico);
}

/** The price credits use: the lower of spot and the window average, or null when the pool cannot be trusted. */
export async function coinPicoPerCoin(cfg: CoinConfig, reader: CoinReader): Promise<Pico | null> {
  const s = await reader.poolState(cfg.pool, cfg.twapSeconds);
  if (!s) return null;
  const coin = cfg.token.address.toLowerCase();
  const quote = cfg.quote.address.toLowerCase();
  const t0 = s.token0.toLowerCase();
  const t1 = s.token1.toLowerCase();
  if (!((t0 === coin && t1 === quote) || (t0 === quote && t1 === coin))) {
    log.warn("anonymo coin pool does not pair the coin with the quote stablecoin", { pool: cfg.pool });
    return null;
  }
  if (s.liquidity < BigInt(cfg.minLiquidity)) return null;
  const isToken0 = t0 === coin;
  const spot = picoPerCoinAtTick(s.spotTick, isToken0, cfg.token.decimals, cfg.quote.decimals);
  const twap = picoPerCoinAtTick(s.twapTick, isToken0, cfg.token.decimals, cfg.quote.decimals);
  const p = spot < twap ? spot : twap;
  return p > 0n ? p : null;
}

/** USD value (pico) of `amountRaw` coins at `picoPerCoin`, rounded down. */
export const coinValuePico = (amountRaw: bigint, picoPerCoin: Pico, decimals: number): Pico => (amountRaw * picoPerCoin) / 10n ** BigInt(decimals);

const cursorKey = "anonymo:cursor:coin";
async function readCursor(db: Db): Promise<bigint | null> {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, cursorKey));
  const v = (row?.value as { block?: string } | undefined)?.block;
  return v ? BigInt(v) : null;
}
async function writeCursor(db: Db, block: bigint) {
  const value = { block: block.toString() };
  await db.insert(kv).values({ key: cursorKey, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

export type CoinScanResult = { from: string | null; to: string | null; credited: number; held: number; skipped: number; waiting: boolean; picoPerCoin: string | null };

/** Scan CoinPay from its cursor to head - confirmations. Safe to re-run: credits are idempotent on the log's ref. */
export async function scanCoinPayments(db: Db, cfg: CoinConfig, reader: CoinReader, sink: AnonymoDepositSink): Promise<CoinScanResult> {
  const out: CoinScanResult = { from: null, to: null, credited: 0, held: 0, skipped: 0, waiting: false, picoPerCoin: null };
  const head = await reader.getBlockNumber();
  const safe = head - BigInt(cfg.confirmations);
  const cursor = await readCursor(db);
  let from = cursor === null ? BigInt(cfg.startBlock) : cursor + 1n;
  if (safe < from) return out;
  out.from = from.toString();
  const maxPico = usdToPico(cfg.maxUsdPerPayment);
  let price: Pico | null | undefined; // read once, only if there is a payment to price
  while (from <= safe) {
    const to = from + BigInt(cfg.maxRange) - 1n < safe ? from + BigInt(cfg.maxRange) - 1n : safe;
    const logs = await reader.getPaidLogs({ address: cfg.coinPay, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const { keyCommit, payer, amount } = l.args;
      if (l.removed || !l.transactionHash || l.logIndex == null || !keyCommit || !payer || amount == null || amount <= 0n) {
        out.skipped++;
        continue;
      }
      const keyHash = await keyForDepositAddress(db, "evm", keyCommit);
      if (!keyHash) {
        log.warn("anonymo coin payment to an unknown key commitment; not credited", { tx: l.transactionHash });
        out.skipped++;
        continue;
      }
      if (price === undefined) price = await coinPicoPerCoin(cfg, reader);
      if (price === null) {
        // Leave the cursor before this range: the burned coins are credited once the pool gives a price again.
        out.waiting = true;
        log.warn("anonymo coin payment waiting for a pool price", { tx: l.transactionHash });
        return out;
      }
      out.picoPerCoin = price.toString();
      const value = coinValuePico(amount, price, cfg.token.decimals);
      if (value <= 0n) {
        out.skipped++;
        continue;
      }
      const r = await sink.creditWith(
        { keyHash, chain: "coin", amount: value, ref: `coin:${l.transactionHash.toLowerCase()}:${l.logIndex}`, sourceAddr: payer.toLowerCase() },
        { token: cfg.token.symbol, amountRaw: amount, holdReason: value > maxPico ? "over_cap" : undefined },
      );
      if (r.credited) out.credited++;
      else if (r.held) out.held++;
    }
    await writeCursor(db, to);
    out.to = to.toString();
    from = to + 1n;
  }
  return out;
}

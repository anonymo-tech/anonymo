// Paying with the coin (ANMO) through CoinPay on Robinhood Chain. CoinPay burns the coins and emits
// Paid(bytes32 keyCommit, address payer, uint256 amount). Usage is priced in USD, so a payment is credited at the coin's
// USD value when the watcher sees it confirmed:
//   price = min(spot, time-weighted average over `twapSeconds`) from the coin's pool against a USD stablecoin
// The coin launches on Pons, whose graduated pools are Uniswap v4: v4 keeps no price history, so each watcher run samples
// the pool's tick into the database and the average is taken over those samples. A Uniswap v3 pool (testnet) averages
// on-chain through `observe`.
// Taking the lower of the two means a short pump of the pool can never raise the credit. If the pool cannot give a price
// (no pool, too little liquidity, too little oracle history), the scan stops without moving its cursor and the payment
// is credited on a later run: the coins are already burned, so a payment is never dropped. A payment worth more than
// `maxUsdPerPayment` is recorded as held for an operator. Coin credit is usage only: withdraw.ts never pays it out.
// The key commitment is the same per-key EVM commitment the DepositRouter uses (addresses.ts).

import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem, type Hex } from "viem";
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

const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

/** A Uniswap v4 pool's spot state, or null before the pool exists (a Pons coin that has not graduated). */
export type V4Slot = { tick: number; liquidity: bigint };

/** The v4 pool id: keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)), currencies sorted. */
export function v4PoolId(a: Hex, b: Hex, fee: number, tickSpacing: number, hooks: Hex): Hex {
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [c0.toLowerCase() as Hex, c1.toLowerCase() as Hex, fee, tickSpacing, hooks.toLowerCase() as Hex],
    ),
  );
}

/** What the pool says: its two tokens, in-range liquidity, the spot tick and the average tick over the window. */
export type PoolState = { token0: Hex; token1: Hex; liquidity: bigint; spotTick: number; twapTick: number };

export type CoinReader = {
  getBlockNumber(): Promise<bigint>;
  getPaidLogs(o: { address: Hex; fromBlock: bigint; toBlock: bigint }): Promise<PaidLog[]>;
  /** v3: null when the pool cannot answer (no pool, or not enough observation history for the window). */
  poolState(pool: Hex, twapSeconds: number): Promise<PoolState | null>;
  /** v4: the pool's spot tick and liquidity through StateView, null when the pool is not initialized. */
  v4Slot(stateView: Hex, poolId: Hex): Promise<V4Slot | null>;
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
    v4Slot: async (stateView, poolId) => {
      const [slot, liquidity] = await Promise.all([
        client.readContract({ address: stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] }),
        client.readContract({ address: stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId] }),
      ]);
      if (slot[0] === 0n) return null; // not initialized: the coin has not graduated yet
      return { tick: slot[1], liquidity };
    },
  };
}

// ---- v4 price samples (v4 pools keep no history) -------------------------------------------------------------------
type Sample = { t: number; tick: number };
const samplesKey = "anonymo:coin:samples";

async function readSamples(db: Db): Promise<Sample[]> {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, samplesKey));
  return ((row?.value as { samples?: Sample[] } | undefined)?.samples ?? []).filter((s) => Number.isFinite(s.t) && Number.isInteger(s.tick));
}

/** Record the pool's current tick (one sample per run, at most every 5 s), keeping two windows of history. */
export async function sampleCoinPrice(db: Db, cfg: CoinConfig, reader: CoinReader, now = Date.now()): Promise<V4Slot | null> {
  if (cfg.pool) return null; // v3 averages on-chain
  const slot = await reader.v4Slot(cfg.v4.stateView, v4PoolId(cfg.token.address, cfg.quote.address, cfg.v4.fee, cfg.v4.tickSpacing, cfg.v4.hooks));
  if (!slot) return null;
  const keep = now - 2 * cfg.twapSeconds * 1000;
  const samples = (await readSamples(db)).filter((s) => s.t >= keep && s.t <= now);
  if (!samples.length || now - samples[samples.length - 1].t >= 5_000) samples.push({ t: now, tick: slot.tick });
  const value = { samples };
  await db.insert(kv).values({ key: samplesKey, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  return slot;
}

/**
 * The average tick over the window from the stored samples, time-weighted (each sample holds until the next one), or
 * null until the samples cover at least half the window with at least 5 of them.
 */
export function averageTick(samples: Sample[], windowSeconds: number, now: number): number | null {
  const from = now - windowSeconds * 1000;
  const inWindow = samples.filter((s) => s.t >= from && s.t <= now).sort((a, b) => a.t - b.t);
  if (inWindow.length < 5 || now - inWindow[0].t < (windowSeconds * 1000) / 2) return null;
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < inWindow.length; i++) {
    const until = i + 1 < inWindow.length ? inWindow[i + 1].t : now;
    const span = Math.max(until - inWindow[i].t, 1);
    weighted += inWindow[i].tick * span;
    total += span;
  }
  return Math.floor(weighted / total);
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
export async function coinPicoPerCoin(cfg: CoinConfig, reader: CoinReader, db?: Db, now = Date.now()): Promise<Pico | null> {
  if (!cfg.pool) return v4PicoPerCoin(cfg, reader, db, now);
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

async function v4PicoPerCoin(cfg: CoinConfig, reader: CoinReader, db: Db | undefined, now: number): Promise<Pico | null> {
  if (!db) return null;
  const poolId = v4PoolId(cfg.token.address, cfg.quote.address, cfg.v4.fee, cfg.v4.tickSpacing, cfg.v4.hooks);
  const slot = await reader.v4Slot(cfg.v4.stateView, poolId).catch(() => null);
  if (!slot || slot.liquidity < BigInt(cfg.minLiquidity)) return null;
  const avg = averageTick(await readSamples(db), cfg.twapSeconds, now);
  if (avg === null) return null; // still collecting samples
  const isToken0 = cfg.token.address.toLowerCase() < cfg.quote.address.toLowerCase();
  const spot = picoPerCoinAtTick(slot.tick, isToken0, cfg.token.decimals, cfg.quote.decimals);
  const twap = picoPerCoinAtTick(avg, isToken0, cfg.token.decimals, cfg.quote.decimals);
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
  await sampleCoinPrice(db, cfg, reader).catch((e) => log.warn("anonymo coin price sample failed", { error: (e as Error).message.split("\n")[0].slice(0, 160) }));
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
      if (price === undefined) price = await coinPicoPerCoin(cfg, reader, db);
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

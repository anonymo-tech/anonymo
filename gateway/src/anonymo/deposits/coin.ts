// Paying with the coin through CoinPay on Robinhood Chain. CoinPay burns the coins and emits
// Paid(bytes32 keyCommit, address payer, uint256 amount). Usage is priced in USD, so a payment is credited at the coin's
// USD value when the watcher sees it confirmed:
//   A direct stablecoin pool uses the lower of spot and TWAP. The canonical NYMO launch uses confirmed Pons curve
//   or pool prices with sell-depth checks, a full same-phase history and the verified RHC Chainlink ETH/USD round.
// The coin launches on Pons, whose graduated pools are Uniswap v4: v4 keeps no price history, so each watcher run samples
// the pool's tick into the database and the average is taken over those samples. A Uniswap v3 pool (testnet) averages
// on-chain through `observe`.
// Taking the lower of the two means a short pump of the pool can never raise the credit. If the pool cannot give a price
// (no pool, too little liquidity, too little oracle history), the scan stops without moving its cursor and the payment
// is credited on a later run: the coins are already burned, so a payment is never dropped. A payment worth more than
// `maxUsdPerPayment` is recorded as held for an operator. Coin credit is usage only: withdraw.ts never pays it out.
// The key commitment is the same per-key EVM commitment the DepositRouter uses (addresses.ts).

import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem, zeroAddress, type PublicClient, type Hex } from "viem";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import { log } from "../../lib/util.ts";
import { keyForDepositAddress } from "./addresses.ts";
import { NYMO_CURVE_MARKET, readNymoCurveSnapshot, nymoCurveQuote, type NymoCurveSnapshot } from "./nymo-curve.ts";
import { NYMO_TOKEN, PONS_V4, type CoinConfig } from "./config.ts";
import { nymoRemaining, type AnonymoDepositSink } from "./sink.ts";

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

const PAYMENT_ABI = parseAbi([
  "function coin() view returns (address)",
  "function DEAD() view returns (address)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export type CoinReader = {
  paymentBinding(coinPay: Hex, token: Hex): Promise<{ chainId: number; coin: Hex; dead: Hex; symbol: string; decimals: number }>;
  /** All NYMO pool, depth, graduation and Chainlink reads use the same confirmed mainnet block. */
  nymoObservation?(cfg: CoinConfig): Promise<NymoObservation | null>;
  nymoPhaseAt?(block: bigint): Promise<"curve" | "pool" | "transition">;
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
    paymentBinding: async (coinPay, token) => {
      const [chainId, coin, dead, symbol, decimals] = await Promise.all([
        client.getChainId(),
        client.readContract({ address: coinPay, abi: PAYMENT_ABI, functionName: "coin" }),
        client.readContract({ address: coinPay, abi: PAYMENT_ABI, functionName: "DEAD" }),
        client.readContract({ address: token, abi: PAYMENT_ABI, functionName: "symbol" }),
        client.readContract({ address: token, abi: PAYMENT_ABI, functionName: "decimals" }),
      ]);
      return { chainId, coin, dead, symbol, decimals };
    },
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    nymoObservation: (cfg) => readNymoMarket(client, cfg),
    nymoPhaseAt: async blockNumber => {
      const opts = { address: NYMO_MARKET.curve, abi: NYMO_ABI, blockNumber };
      const [prev, graduated, ready] = await Promise.all([
        client.readContract({ ...opts, blockNumber: blockNumber - 1n, functionName: "graduated" }),
        client.readContract({ ...opts, functionName: "graduated" }),
        client.readContract({ ...opts, functionName: "readyToGraduate" }),
      ]);
      if (prev !== graduated || (!graduated && ready)) return "transition";
      return graduated ? "pool" : "curve";
    },
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

const POOL_KEY = { currency0: zeroAddress, currency1: NYMO_TOKEN, fee: PONS_V4.fee, tickSpacing: PONS_V4.tickSpacing, hooks: PONS_V4.hooks } as const;
export const NYMO_MARKET = {
  token: NYMO_TOKEN, native: zeroAddress, curve: NYMO_CURVE_MARKET.curve,
  ethUsdFeed: "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  poolId: v4PoolId(zeroAddress, NYMO_TOKEN, PONS_V4.fee, PONS_V4.tickSpacing, PONS_V4.hooks),
} as const;

const NYMO_ABI = parseAbi([
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function latestRoundData() view returns (uint80 round, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)",
]);
const MAX_GAP_SECONDS = 60;
const PRICE_SCALE = 10n ** 64n;
const Q192 = 1n << 192n;
type NymoObservation = { t: number; updated: number } & (
  | { phase: "pool"; tick: number; liquidity: bigint; ethUsdPico: bigint; executablePico: bigint; depthRaw: bigint }
  | { phase: "curve"; snapshot: NymoCurveSnapshot }
);

/** Both NYMO and native ETH have 18 decimals. Work in their raw-unit ratio until the final rounding to pico-USD.
 * Fixed-point exponentiation rounds down at every multiplication, including the reciprocal for negative ticks. */
export function nativeTickValue(tick: number, ethUsdPico: bigint): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887273 || ethUsdPico <= 0n) return 0n;
  let power = tick < 0 ? PRICE_SCALE * 10_000n / 10_001n : PRICE_SCALE * 10_001n / 10_000n;
  let ratio = PRICE_SCALE;
  for (let n = Math.abs(tick); n; n = Math.floor(n / 2)) {
    if (n % 2) ratio = ratio * power / PRICE_SCALE;
    power = power * power / PRICE_SCALE;
  }
  return ratio * ethUsdPico / PRICE_SCALE;
}

export function ethUsdRoundPico(decimals: number, data: readonly [bigint, bigint, bigint, bigint, bigint], timestamp: bigint): bigint | null {
  const [round, answer, start, updated, answeredIn] = data;
  if (decimals !== 8 || round <= 0n || answer <= 0n || answeredIn < round || start <= 0n ||
      updated < start || updated > timestamp || timestamp - updated > 86_400n) return null;
  return answer * 10_000n;
}

/** All calls, including the sell-depth simulation, read one confirmed block. No transaction is submitted. */
async function readNymoMarket(client: PublicClient, cfg: CoinConfig): Promise<NymoObservation | null> {
  const [chainId, head] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })]);
  const blockNumber = head - BigInt(cfg.confirmations);
  if (chainId !== 4663 || blockNumber < 0n) return null;
  const [block, graduated, decimals, round, bound, dead] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.readContract({ blockNumber, address: NYMO_MARKET.curve, abi: NYMO_ABI, functionName: "graduated" }),
    client.readContract({ blockNumber, address: NYMO_MARKET.ethUsdFeed, abi: PAYMENT_ABI, functionName: "decimals" }),
    client.readContract({ blockNumber, address: NYMO_MARKET.ethUsdFeed, abi: NYMO_ABI, functionName: "latestRoundData" }),
    client.readContract({ blockNumber, address: cfg.coinPay, abi: PAYMENT_ABI, functionName: "coin" }),
    client.readContract({ blockNumber, address: cfg.coinPay, abi: PAYMENT_ABI, functionName: "DEAD" }),
  ]);
  const usd = ethUsdRoundPico(decimals, round, block.timestamp);
  if (!usd || bound.toLowerCase() !== NYMO_TOKEN || dead.toLowerCase() !== "0x000000000000000000000000000000000000dead") return null;

  const time = { t: Number(block.timestamp), updated: Number(round[3]) };
  if (!graduated) {
    const snapshot = await readNymoCurveSnapshot(client, blockNumber, usd);
    return snapshot ? { ...time, phase: "curve", snapshot } : null;
  }
  const [slot, liquidity] = await Promise.all([
    client.readContract({ blockNumber, address: PONS_V4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [NYMO_MARKET.poolId] }),
    client.readContract({ blockNumber, address: PONS_V4.stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [NYMO_MARKET.poolId] }),
  ]);
  const [sqrt, tick] = slot;
  if (sqrt <= 0n || liquidity <= 0n || liquidity < BigInt(cfg.minLiquidity)) return null;

  // Prove executable sell depth at least as large as the largest allowed payment or $100, whichever is greater.
  // Native is currency0. sqrt² / Q192 converts native units to NYMO units, the inverse of the credit direction.
  const cap = usdToPico(cfg.maxUsdPerPayment);
  const probeUsd = cap > 100_000_000_000_000n ? cap : 100_000_000_000_000n;
  const tokens = (probeUsd * (10n ** 18n) * sqrt * sqrt + usd * Q192 - 1n) / (usd * Q192);
  if (tokens <= 0n || tokens >= 1n << 128n) return null;
  const { result: [native] } = await client.simulateContract({
    blockNumber, address: NYMO_MARKET.quoter, abi: NYMO_ABI, functionName: "quoteExactInputSingle",
    args: [{ poolKey: POOL_KEY, zeroForOne: false, exactAmount: tokens, hookData: "0x" }],
  });
  if (native <= 0n || native * sqrt * sqrt * 100n < tokens * Q192 * 95n) return null;
  return { ...time, phase: "pool", tick, liquidity, ethUsdPico: usd, executablePico: native * usd / tokens, depthRaw: tokens };
}

async function freshNymoObservation(cfg: CoinConfig, reader: CoinReader, now?: number) {
  const obs = await reader.nymoObservation?.(cfg).catch(() => null);
  const seconds = Math.floor((now ?? Date.now()) / 1000);
  if (!obs || !Number.isInteger(obs.t) || obs.t > seconds || seconds - obs.t > MAX_GAP_SECONDS ||
      obs.updated <= 0 || obs.updated > obs.t || seconds - obs.updated > 86_400) return null;
  if (obs.phase === "curve") return obs;
  return Number.isInteger(obs.tick) && Math.abs(obs.tick) <= 887272 && obs.liquidity > 0n && obs.liquidity >= BigInt(cfg.minLiquidity) &&
    obs.ethUsdPico > 0n && obs.executablePico > 0n && obs.depthRaw > 0n ? obs : null;
}

type NymoSample = { t: number } & (
  | { phase: "pool"; tick: number; depthRaw: string; executablePico: string }
  | { phase: "curve"; snapshot: NymoCurveSnapshot }
);
type NymoHistory = { policy: string; samples: NymoSample[] };
const historyKey = "anonymo:coin:nymo-native-chainlink:v1";
const policyFor = (cfg: CoinConfig) => [cfg.coinPay.toLowerCase(), cfg.confirmations, cfg.minLiquidity, cfg.maxUsdPerPayment, cfg.twapSeconds].join(":");
const storedObservation = (o: NymoObservation): NymoSample => o.phase === "curve"
  ? { t: o.t, phase: "curve", snapshot: o.snapshot }
  : { t: o.t, phase: "pool", tick: o.tick, depthRaw: String(o.depthRaw), executablePico: String(o.executablePico) };

async function storeNymoObservation(db: Db, cfg: CoinConfig, obs: NymoObservation | null, now: number) {
  const policy = policyFor(cfg);
  await db.transaction(async tx => {
    await tx.insert(kv).values({ key: historyKey, value: { policy, samples: [] } }).onConflictDoNothing();
    const [row] = await tx.select({ value: kv.value }).from(kv).where(eq(kv.key, historyKey)).for("update");
    const history = row.value as NymoHistory;
    const samples = history.policy === policy && obs ? history.samples.filter(s => s.t >= obs.t - cfg.twapSeconds - MAX_GAP_SECONDS) : [];
    // Say why a window restarts (no prices or amounts are logged), so a price that never appears can be traced.
    const restart = (reason: string) => history.samples.length && log.info("anonymo nymo price window restarted", { reason, dropped: history.samples.length });
    if (history.policy !== policy) restart("settings changed");
    else if (!obs) restart("no valid market read");
    if (obs) {
      const previous = samples.at(-1);
      if (previous && obs.t < previous.t) return; // a slower overlapping read finished after a newer one
      if (previous && (previous.phase !== obs.phase || obs.t - previous.t > MAX_GAP_SECONDS)) {
        restart(previous.phase !== obs.phase ? "market phase changed" : `samples ${obs.t - previous.t}s apart`);
        samples.length = 0;
      }
      if (samples.length && previous && obs.t - previous.t < 5) return;
      samples.push(storedObservation(obs));
    }
    await tx.update(kv).set({ value: { policy, samples }, updatedAt: new Date(now) }).where(eq(kv.key, historyKey));
  });
}

const smallest = (a: bigint, b: bigint) => a < b ? a : b;
const WHOLE_NYMO = 10n ** 18n;
type AmountQuote = { valuePico: bigint; withinLimit: boolean };
type PreparedQuote = {
  phase: "pool" | "curve"; unitPico: bigint; maxRaw: bigint; maxPico: bigint;
  valueForRaw: (amount: bigint) => AmountQuote | null;
};

/** Require a complete window of confirmed observations of the same phase, and independently re-read the market.
 * An interrupted history or graduation always needs a fresh window. Prepare once for all amount calculations. */
async function marketWindow(db: Db, cfg: CoinConfig, reader: CoinReader, now?: number): Promise<PreparedQuote | null> {
  if (!cfg.market) return null;
  const obs = await freshNymoObservation(cfg, reader, now);
  if (!obs) return null;
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, historyKey));
  const history = row?.value as NymoHistory | undefined;
  if (!history || history.policy !== policyFor(cfg)) return null;
  const start = obs.t - cfg.twapSeconds;
  const anchor = history.samples.findLastIndex(s => s.t <= start);
  if (anchor < 0) return null;
  const samples = [...history.samples.slice(anchor), storedObservation(obs)];
  const curves: NymoCurveSnapshot[] = [];
  let weightedTick = 0;
  const cap = usdToPico(cfg.maxUsdPerPayment);
  let maxRaw = (1n << 128n) - 1n;
  let maxPico = cap;
  let unitPico = (1n << 256n) - 1n;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const until = samples[i + 1]?.t ?? obs.t;
    if (s.phase !== obs.phase || until < s.t || until - s.t > MAX_GAP_SECONDS) return null;
    if (s.phase === "pool") {
      // Native ETH is currency0, so -(tick+1) rounds the inverse NYMO price down.
      weightedTick += -(s.tick + 1) * (until - Math.max(start, s.t));
      maxRaw = smallest(maxRaw, BigInt(s.depthRaw));
      unitPico = smallest(unitPico, BigInt(s.executablePico));
    } else {
      const limits = nymoCurveQuote(s.snapshot, WHOLE_NYMO, cap);
      if (!limits || limits.maxAmountRaw <= 0n) return null;
      const depth = nymoCurveQuote(s.snapshot, limits.maxAmountRaw, cap);
      if (!depth || depth.valuePico <= 0n) return null;
      // The rate at maximum permitted size bounds the sum of credits from smaller burns.
      unitPico = smallest(unitPico, depth.valuePico * WHOLE_NYMO / limits.maxAmountRaw);
      maxPico = smallest(maxPico, limits.depthBudgetPico);
      maxRaw = smallest(maxRaw, limits.maxAmountRaw);
      curves.push(s.snapshot);
    }
  }
  if (obs.phase === "pool") {
    const tick = Math.min(-(obs.tick + 1), Math.floor(weightedTick / cfg.twapSeconds));
    unitPico = smallest(unitPico, nativeTickValue(tick, obs.ethUsdPico));
  }
  if (unitPico <= 0n) return null;
  maxRaw = smallest(maxRaw, maxPico * WHOLE_NYMO / unitPico);
  maxPico = smallest(maxPico, maxRaw * unitPico / WHOLE_NYMO);
  const valueForRaw = (amount: bigint): AmountQuote | null => {
    const clock = Math.floor((now ?? Date.now()) / 1000);
    if (amount <= 0n || clock - obs.t > MAX_GAP_SECONDS || clock - obs.updated > 86_400) return null;
    let valuePico = amount * unitPico / WHOLE_NYMO;
    let withinLimit = amount <= maxRaw && valuePico <= maxPico;
    for (const curve of curves) {
      const exact = nymoCurveQuote(curve, amount, cap);
      if (!exact) return null;
      valuePico = smallest(valuePico, exact.valuePico);
      withinLimit &&= exact.withinLimit;
    }
    // Held deposits retain the actual raw amount and a value bounded to depth proven for this window.
    return { valuePico: smallest(valuePico, maxPico), withinLimit };
  };
  return { phase: obs.phase, unitPico, maxPico, maxRaw, valueForRaw };
}

/** Public quotes include the shared capacity still available. The sink enforces it again under a database lock. */
export async function prepareNymoQuote(db: Db, cfg: CoinConfig, reader: CoinReader, now?: number): Promise<PreparedQuote | null> {
  const q = await marketWindow(db, cfg, reader, now);
  if (!q) return null;
  const room = await nymoRemaining(db, { seconds: cfg.twapSeconds, maxRaw: q.maxRaw, maxPico: q.maxPico });
  const maxRaw = smallest(room.maxRaw, room.maxPico * WHOLE_NYMO / q.unitPico);
  const maxPico = smallest(room.maxPico, maxRaw * q.unitPico / WHOLE_NYMO);
  return { ...q, maxRaw, maxPico, valueForRaw(amount) {
    const result = q.valueForRaw(amount);
    return result && { valuePico: result.valuePico, withinLimit: result.withinLimit && amount <= maxRaw && result.valuePico <= maxPico };
  } };
}

export async function nymoPaymentQuote(db: Db, cfg: CoinConfig, reader: CoinReader, amount: bigint, now?: number) {
  const q = await marketWindow(db, cfg, reader, now);
  const amountQuote = q?.valueForRaw(amount);
  return q && amountQuote ? { ...q, ...amountQuote } : null;
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
  if (cfg.market) {
    const obs = await freshNymoObservation(cfg, reader, now);
    await storeNymoObservation(db, cfg, obs, now);
    return obs?.phase === "pool" ? { tick: obs.tick, liquidity: obs.liquidity } : null;
  }
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
  if (cfg.market) return db ? (await prepareNymoQuote(db, cfg, reader, now))?.unitPico ?? null : null;
  if (cfg.chainId === 4663 && cfg.token.address.toLowerCase() === NYMO_TOKEN) return null;
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
  if (s.liquidity === 0n || s.liquidity < BigInt(cfg.minLiquidity)) return null;
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
  if (!slot || slot.liquidity === 0n || slot.liquidity < BigInt(cfg.minLiquidity)) return null;
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
      const market = cfg.market ? await nymoPaymentQuote(db, cfg, reader, amount) : null;
      if (cfg.market) price = market?.unitPico ?? null;
      else if (price === undefined) price = await coinPicoPerCoin(cfg, reader, db);
      if (price === null) {
        // Leave the cursor before this range: the burned coins are credited once the pool gives a price again.
        out.waiting = true;
        log.warn("anonymo coin payment waiting for a pool price", { tx: l.transactionHash });
        return out;
      }
      out.picoPerCoin = price.toString();
      const value = market?.valuePico ?? coinValuePico(amount, price, cfg.token.decimals);
      if (value <= 0n) {
        out.skipped++;
        continue;
      }
      let holdReason = value > maxPico || (market && !market.withinLimit) ? "over_cap" : undefined;
      if (market) {
        const phase = l.blockNumber && await reader.nymoPhaseAt?.(l.blockNumber).catch(() => null);
        if (!phase) { out.waiting = true; return out; }
        if (phase !== market.phase) holdReason = "market_transition";
      }
      const r = await sink.creditWith(
        { keyHash, chain: "coin", amount: value, ref: `coin:${l.transactionHash.toLowerCase()}:${l.logIndex}`, sourceAddr: payer.toLowerCase() },
        { token: cfg.token.symbol, amountRaw: amount, holdReason,
          ...(market ? { nymoWindowLimit: { seconds: cfg.twapSeconds, maxRaw: market.maxRaw, maxPico: market.maxPico } } : {}) },
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

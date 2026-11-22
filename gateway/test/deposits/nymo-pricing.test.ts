import { afterAll, beforeAll, expect, test } from "bun:test";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { eq, sql } from "drizzle-orm";
import { ethUsdRoundPico, nativeTickValue, NYMO_MARKET, nymoPaymentQuote, prepareNymoQuote, rpcCoinReader, sampleCoinPrice, scanCoinPayments, type CoinReader } from "../../src/anonymo/deposits/coin.ts";
import { loadDepositsConfig, RHC_USDG } from "../../src/anonymo/deposits/config.ts";
import { ensureDepositAddress } from "../../src/anonymo/deposits/addresses.ts";
import { anonymoDeposits } from "../../src/anonymo/deposits/schema.ts";
import { createDepositSink, nymoRemaining, rescreenHeld } from "../../src/anonymo/deposits/sink.ts";
import { moneyHarness, type MoneyHarness } from "./harness.ts";
import { kv } from "../../src/db/schema.ts";

const E = 10n ** 18n;
const USD = 10n ** 12n;
const coin = { market: "nymo-native-chainlink", rpcUrl: "http://localhost:10001", coinPay: "0x" + "12".repeat(20),
  token: { address: NYMO_MARKET.token, symbol: "NYMO", decimals: 18 }, quote: { address: RHC_USDG, symbol: "USDG", decimals: 6 } };
const config = (fields: object = {}) => loadDepositsConfig({ ANONYMO_COIN: JSON.stringify({ ...coin, ...fields }) }).coin!;
const cfg = config();
const t0 = Math.floor(Date.now() / 1000) - cfg.twapSeconds;
let h: MoneyHarness;
beforeAll(async () => { h = await moneyHarness(); });
afterAll(async () => h?.close());

test("NYMO pricing is explicitly scoped to the verified mainnet contracts; the old rails retain their config", () => {
  expect(cfg.market).toBe("nymo-native-chainlink");
  expect(NYMO_MARKET.poolId).toBe("0x050246a0bd54dd6af3d9fef4043d12f634884c38a9e46591cebb941fde311a60");
  for (const override of [{ pool: coin.coinPay }, { chainId: 46630 }, { token: { ...coin.token, decimals: 6 } },
    { quote: { ...coin.quote, address: coin.coinPay } }, { confirmations: 0 }, { twapSeconds: 60 }]) expect(() => config(override)).toThrow();
  expect(config({ market: undefined, pool: coin.coinPay, twapSeconds: 60 }).pool).toBe(coin.coinPay);
});

test("confirmed Chainlink rounds have eight decimals, complete positive data, and update within the heartbeat", () => {
  const round = [7n, 165845814630n, 1000n, 1001n, 7n] as const;
  expect(ethUsdRoundPico(8, round, 1002n)).toBe(1658458146300000n);
  expect(ethUsdRoundPico(18, round, 1002n)).toBeNull();
  expect(ethUsdRoundPico(8, round, 1000n)).toBeNull();
  expect(ethUsdRoundPico(8, round, 87402n)).toBeNull();
  for (const invalid of [[0n, 10n, 1n, 2n, 0n], [7n, 0n, 1n, 2n, 7n], [7n, 1n, 0n, 2n, 7n],
    [7n, 1n, 3n, 2n, 7n], [7n, 1n, 1n, 2n, 6n]] as const) expect(ethUsdRoundPico(8, invalid, 1002n)).toBeNull();
});

test("tick valuation uses exact integer direction and decimal units, rounded conservatively", () => {
  const eth = 1660n * USD;
  for (const tick of [-99, -7, -1, 0, 1, 7, 99]) {
    const a = tick < 0 ? 10000n : 10001n;
    const b = tick < 0 ? 10001n : 10000n;
    const exact = eth * a ** BigInt(Math.abs(tick)) / b ** BigInt(Math.abs(tick));
    const got = nativeTickValue(tick, eth);
    expect(got <= exact && got >= exact - 1n).toBe(true);
  }
  expect(nativeTickValue(0, eth)).toBe(1660n * USD); // 1 native ETH never counts as 1 USD
});

type Observation = NonNullable<Awaited<ReturnType<NonNullable<CoinReader["nymoObservation"]>>>>;
const poolObs = (t: number): Observation => ({ t, updated: t, phase: "pool", tick: 0, liquidity: 100n,
  ethUsdPico: 2n * USD, executablePico: 2n * USD, depthRaw: 500n * E });
const curveObs = (t: number): Observation => ({ t, updated: t, phase: "curve", snapshot: {
  quoteReserve: String(20n * E), tokenReserve: String(1_000_000n * E), realQuoteReserve: String(10n * E),
  ethUsdPico: String(1660n * USD), feeBps: 100, creatorTaxBps: 150 } });
const db = () => h.h.ctx.db;
const reset = () => db().delete(kv).where(eq(kv.key, "anonymo:coin:nymo-native-chainlink:v1"));

test("pool or curve quotes require a full, gap-bounded window of the same phase and newly verified depth and feed", async () => {
  await reset();
  let obs: Observation | null = null;
  const reader = { nymoObservation: async () => obs } as CoinReader;
  const quote = (t: number, amount = E) => nymoPaymentQuote(db(), cfg, reader, amount, t * 1000);
  async function take(s: Observation) { obs = s; await sampleCoinPrice(db(), cfg, reader, s.t * 1000); }
  for (let t = t0; t <= t0 + 1800; t += 60) {
    await take(poolObs(t));
    if (t < t0 + 1800) expect(await quote(t)).toBeNull();
  }
  const now = t0 + 1800;
  expect((await quote(now))?.unitPico).toBe(nativeTickValue(-1, 2n * USD));
  expect((await quote(now, 200n * E))?.withinLimit).toBe(false);
  obs = { ...poolObs(now), tick: -100 } as Observation;
  expect((await quote(now))?.unitPico).toBe(nativeTickValue(-1, 2n * USD));
  obs = { ...poolObs(now), tick: 150 } as Observation;
  expect((await quote(now))?.unitPico).toBe(nativeTickValue(-151, 2n * USD));
  for (const bad of [null, poolObs(now - 61), { ...poolObs(now), updated: now - 86401 }, { ...poolObs(now), liquidity: 0n }] as (Observation|null)[]) {
    obs = bad; expect(await quote(now)).toBeNull();
  }
  obs = curveObs(now);
  expect(await quote(now)).toBeNull();
  for (let t = now; t <= now + 1800; t += 60) await take(curveObs(t));
  const curve = await quote(now + 1800);
  expect(curve?.phase).toBe("curve");
  expect(curve!.unitPico).toBeGreaterThan(0n);
  expect(curve!.unitPico).toBeLessThan(USD);
  const over = await quote(now + 1800, curve!.maxRaw + E);
  expect(over?.withinLimit).toBe(false);
  expect(over!.valuePico).toBeGreaterThan(0n);
  let reads = 0;
  const prepared = await prepareNymoQuote(db(), cfg, { ...reader, nymoObservation: async () => { reads++; return obs; } }, (now + 1800) * 1000);
  expect(prepared?.phase).toBe("curve");
  const units = (10n * USD * E + prepared!.unitPico - 1n) / prepared!.unitPico;
  expect(prepared?.valueForRaw(units)).toEqual({ valuePico: 10n * USD, withinLimit: true });
  expect(prepared?.valueForRaw(prepared.maxRaw + 1n)?.withinLimit).toBe(false);
  expect(reads).toBe(1);
  await take(curveObs(now + 1861));
  expect(await quote(now + 1861)).toBeNull();
});

test("global trailing NYMO depth applies across keys and concurrent retry, including screening-held funds", async () => {
  const keys = await Promise.all([h.newKey(), h.newKey()]);
  const limit = { seconds: 1800, maxRaw: 100n * E, maxPico: 100n * USD };
  let down = true;
  const screen = { isBlocked: async () => { if (down) throw Error("offline"); return false; } };
  const sink = createDepositSink(db(), screen);
  const send = (key: number, n: bigint, ref: string) => sink.creditWith({
    keyHash: keys[key].keyHash, chain: "coin", ref, amount: n * USD, sourceAddr: "0x" + "23".repeat(20),
  }, { token: "NYMO", amountRaw: n * E, nymoWindowLimit: limit });
  expect((await send(0, 60n, "coin:nymo-sample-a")).held).toBe("screening_unavailable");
  down = false;
  const calls = await Promise.all([send(0, 30n, "coin:nymo-sample-b"), send(1, 30n, "coin:nymo-sample-c"), send(0, 30n, "coin:nymo-sample-b")]);
  expect(calls.filter(c => c.credited)).toHaveLength(1);
  expect(calls.filter(c => c.held === "market_depth")).toHaveLength(1);
  expect(await nymoRemaining(db(), limit)).toEqual({ maxRaw: 10n * E, maxPico: 10n * USD });
  expect((await rescreenHeld(db(), screen)).credited).toBe(1);
  expect(await nymoRemaining(db(), limit)).toEqual({ maxRaw: 10n * E, maxPico: 10n * USD });
  await db().update(anonymoDeposits).set({ createdAt: sql`now() - interval '1801 seconds'` }).where(eq(anonymoDeposits.ref, "coin:nymo-sample-a"));
  expect(await nymoRemaining(db(), limit)).toEqual({ maxRaw: 70n * E, maxPico: 70n * USD });
});

test("actual confirmed NYMO logs wait for a price, post the quoted amount once, and retain an oversized burn for review", async () => {
  await reset();
  const key = await h.newKey();
  const commit = await ensureDepositAddress(db(), key.keyHash, "evm");
  const target = "0x" + "42".repeat(20);
  const txId = (v: number) => "0x" + String(v).padStart(64, "0");
  const now = Math.floor(Date.now() / 1000);
  const warmed = now - 1800;
  let stamp = warmed;
  const logs = [1_000n * E, 1_000_000_000n * E, E, 1n].map((amount, i) => ({
    transactionHash: txId(i + 1), logIndex: i, blockNumber: [16n, 17n, 18n, 18n][i], args: { amount, keyCommit: commit, payer: target },
  }));
  const reader = { nymoObservation: async () => curveObs(stamp), nymoPhaseAt: async (b: bigint) => b === 18n ? "transition" : "curve", getBlockNumber: async () => 30n,
    getPaidLogs: async () => logs } as unknown as CoinReader;
  stamp = now;
  await db().delete(kv).where(eq(kv.key, "anonymo:cursor:coin"));
  expect((await scanCoinPayments(db(), cfg, reader, h.deps.sink)).waiting).toBe(true);
  await reset();
  for (stamp = warmed; stamp <= now; stamp += 60) await sampleCoinPrice(db(), cfg, reader, stamp * 1000);
  stamp = now;
  const first = await prepareNymoQuote(db(), cfg, reader);
  expect(first?.phase).toBe("curve");
  const quoted = first!.valueForRaw(logs[0].args.amount)!;
  const scanned = await scanCoinPayments(db(), cfg, reader, h.deps.sink);
  expect(scanned.credited).toBe(1);
  expect(scanned.held).toBe(2);
  expect(scanned.skipped).toBe(1); // sub-pico dust cannot become a ledger entry
  const rows = await db().select().from(anonymoDeposits).where(eq(anonymoDeposits.keyHash, key.keyHash));
  expect(rows.find(r => r.status === "credited")?.amountPico).toBe(quoted.valuePico);
  expect(rows.find(r => r.reason === "market_transition")?.amountRaw).toBe(String(E));
  expect(rows.find(r => r.reason === "over_cap")).toMatchObject({ reason: "over_cap", amountRaw: String(logs[1].args.amount) });
  const after = await prepareNymoQuote(db(), cfg, reader);
  expect(after!.maxRaw < first!.maxRaw).toBe(true);
  await db().delete(kv).where(eq(kv.key, "anonymo:cursor:coin"));
  expect((await scanCoinPayments(db(), cfg, reader, h.deps.sink)).credited).toBe(0);
});

test("on-chain pool reads and the sell-depth simulation use one confirmed block and fail closed on shallow liquidity or a stale feed", async () => {
  const stamp = Math.floor(Date.now() / 1000);
  let fillPercent = 98n, age = 20n, chain = 4663, liquidity = 500n;
  const calls: string[] = [];
  const encode = (types: string[], values: unknown[]) => encodeAbiParameters(types.map(type => ({ type })) as never, values as never);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const { id, method, params } = await req.json();
    let result: unknown;
    if (method === "eth_chainId") result = "0x" + chain.toString(16);
    if (method === "eth_blockNumber") result = "0x30";
    if (method === "eth_getBlockByNumber") {
      expect(params[0]).toBe("0x24");
      result = { number: "0x24", timestamp: "0x" + stamp.toString(16), transactions: [] };
    }
    if (method === "eth_call") {
      expect(params[1]).toBe("0x24");
      const selector = params[0].data.slice(0, 10);
      const responses = [
        ["graduated()", encode(["bool"], [true])],
        ["getSlot0(bytes32)", encode(["uint160","int24","uint24","uint24"], [1n << 96n,0,0,0])],
        ["getLiquidity(bytes32)", encode(["uint128"], [liquidity])],
        ["decimals()", encode(["uint8"], [8])],
        ["latestRoundData()", encode(["uint80","int256","uint256","uint256","uint80"], [2n,1660n*10n**8n,BigInt(stamp)-age,BigInt(stamp)-age,2n])],
        ["coin()", encode(["address"], [NYMO_MARKET.token])],
        ["DEAD()", encode(["address"], ["0x000000000000000000000000000000000000dead"])],
      ];
      const entry = responses.find(([sig]) => toFunctionSelector(sig) === selector);
      if (entry) { calls.push(entry[0]); result = entry[1]; }
      else {
        const sig = "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))";
        expect(selector).toBe(toFunctionSelector(sig));
        expect(params[0].to.toLowerCase()).toBe(NYMO_MARKET.quoter);
        calls.push("depth");
        const expected = (250n * E + 1659n) / 1660n;
        result = encode(["uint256","uint256"], [expected * fillPercent / 100n, 1n]);
      }
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  } });
  try {
    const reader = rpcCoinReader(server.url.href);
    const run = () => reader.nymoObservation!(cfg);
    expect((await run())?.phase).toBe("pool");
    expect(calls).toContain("depth");
    fillPercent = 94n; expect(await run()).toBeNull();
    fillPercent = 98n; age = 86401n; expect(await run()).toBeNull();
    age = 20n; liquidity = 0n; expect(await run()).toBeNull();
    chain = 1; expect(await run()).toBeNull();
  } finally { server.stop(true); }
});

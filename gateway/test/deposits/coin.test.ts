// Paying with the coin: CoinPay burns ANMO and the watcher credits its USD value at min(spot, 30-minute average) from
// the coin's v3 pool. The credit is usage only: it never leaves through /withdraw.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { usdToPico } from "../../src/lib/money.ts";
import { anonymoDeposits } from "../../src/anonymo/deposits/schema.ts";
import { ensureDepositAddress } from "../../src/anonymo/deposits/addresses.ts";
import { coinPicoPerCoin, coinValuePico, picoPerCoinAtTick, scanCoinPayments, twapTickOf, type CoinReader, type PaidLog, type PoolState } from "../../src/anonymo/deposits/coin.ts";
import { loadDepositsConfig, type CoinConfig } from "../../src/anonymo/deposits/config.ts";
import { moneyHarness, type MoneyHarness } from "./harness.ts";

const COIN = "0x00000000000000000000000000000000000c0100" as Hex;
const USDG = "0x00000000000000000000000000000000000c0200" as Hex; // sorts after COIN: the coin is token0
const POOL = "0x00000000000000000000000000000000000c0300" as Hex;
const PAY = "0x00000000000000000000000000000000000c0400" as Hex;
const PAYER = "0x00000000000000000000000000000000000000a7" as Hex;

// tick for $0.10 per coin with coin = token0 (18 decimals) and USDG = token1 (6): 1.0001^t * 1e12 = 0.1 → t ≈ -299339
const TICK_10C = Math.round(Math.log(0.1 / 1e12) / Math.log(1.0001));

const chain = { head: 100n, logs: [] as (PaidLog & { blockNumber: bigint })[], pool: null as PoolState | null };
const reader: CoinReader = {
  getBlockNumber: async () => chain.head,
  getPaidLogs: async ({ fromBlock, toBlock }) => chain.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
  poolState: async () => chain.pool,
};
let tx = 0;
const pay = (block: bigint, keyCommit: Hex, amount: bigint) =>
  chain.logs.push({ args: { keyCommit, payer: PAYER, amount }, transactionHash: `0x${(++tx).toString(16).padStart(64, "c")}` as Hex, logIndex: 0, blockNumber: block });

const env = { ANONYMO_COIN: JSON.stringify({ rpcUrl: "http://127.0.0.1:9", coinPay: PAY, token: { address: COIN }, pool: POOL, quote: { address: USDG }, confirmations: 2, startBlock: 100, maxUsdPerPayment: "50" }) };
const cfg = loadDepositsConfig(env).coin as CoinConfig;
let m: MoneyHarness;
beforeAll(async () => {
  m = await moneyHarness({ env, deps: {} });
  m.deps.readers.coin = reader;
});
afterAll(async () => m?.close());

describe("coin pricing", () => {
  test("a tick prices the coin in USD whichever side of the pool it is on", () => {
    const p = picoPerCoinAtTick(TICK_10C, true, 18, 6);
    expect(Number(p) / 1e12).toBeCloseTo(0.1, 4);
    expect(Number(picoPerCoinAtTick(-TICK_10C, false, 18, 6)) / 1e12).toBeCloseTo(0.1, 4);
    expect(coinValuePico(25n * 10n ** 18n, usdToPico("0.1"), 18)).toBe(usdToPico("2.5"));
  });

  test("the average tick rounds toward negative infinity, like Uniswap", () => {
    expect(twapTickOf(-7n, 2)).toBe(-4);
    expect(twapTickOf(7n, 2)).toBe(3);
  });

  test("credit uses the lower of spot and average, and refuses a pool it cannot trust", async () => {
    const pumped = { token0: COIN, token1: USDG, liquidity: 10n ** 20n, spotTick: TICK_10C + 20_000, twapTick: TICK_10C };
    chain.pool = pumped;
    expect(Number(await coinPicoPerCoin(cfg, reader)) / 1e12).toBeCloseTo(0.1, 4); // spot pumped ~7x: average wins
    chain.pool = { ...pumped, spotTick: TICK_10C - 7_000 }; // spot dumped: spot wins
    expect(Number(await coinPicoPerCoin(cfg, reader)) / 1e12).toBeCloseTo(0.1 * Math.pow(1.0001, -7_000), 4);
    chain.pool = { ...pumped, token1: "0x00000000000000000000000000000000000000ff" }; // wrong pair
    expect(await coinPicoPerCoin(cfg, reader)).toBeNull();
    expect(await coinPicoPerCoin({ ...cfg, minLiquidity: (10n ** 21n).toString() }, reader)).toBeNull();
    chain.pool = null;
    expect(await coinPicoPerCoin(cfg, reader)).toBeNull();
  });
});

describe("coin payments", () => {
  test("credited at the pool price, idempotently; over the cap is held; no price means wait, never drop", async () => {
    const k = await m.newKey();
    const commit = (await ensureDepositAddress(m.h.ctx.db, k.keyHash, "evm")) as Hex;
    chain.pool = { token0: COIN, token1: USDG, liquidity: 10n ** 20n, spotTick: TICK_10C, twapTick: TICK_10C };
    pay(101n, commit, 100n * 10n ** 18n); // ~$10
    pay(102n, commit, 1_000n * 10n ** 18n); // ~$100: over the $50 cap
    chain.head = 110n;
    const r = await scanCoinPayments(m.h.ctx.db, cfg, reader, m.deps.sink);
    expect(r.credited).toBe(1);
    expect(r.held).toBe(1);
    const rows = await m.h.ctx.db.select().from(anonymoDeposits).where(eq(anonymoDeposits.keyHash, k.keyHash));
    const credited = rows.find((x) => x.status === "credited")!;
    expect(credited.chain).toBe("coin");
    expect(credited.token).toBe("ANMO");
    expect(credited.sourceAddr).toBe(PAYER);
    expect(Number(credited.amountPico) / 1e12).toBeCloseTo(10, 2);
    expect(rows.find((x) => x.status === "held")!.reason).toBe("over_cap");
    // Re-scan from scratch: nothing twice.
    await m.h.ctx.db.execute(`delete from kv where key = 'anonymo:cursor:coin'` as never);
    expect((await scanCoinPayments(m.h.ctx.db, cfg, reader, m.deps.sink)).credited).toBe(0);

    // The pool goes away: the next payment waits (cursor stays), then is credited once a price is back.
    pay(111n, commit, 50n * 10n ** 18n);
    chain.head = 120n;
    chain.pool = null;
    const waiting = await scanCoinPayments(m.h.ctx.db, cfg, reader, m.deps.sink);
    expect(waiting.waiting).toBe(true);
    expect(waiting.credited).toBe(0);
    chain.pool = { token0: COIN, token1: USDG, liquidity: 10n ** 20n, spotTick: TICK_10C, twapTick: TICK_10C };
    expect((await scanCoinPayments(m.h.ctx.db, cfg, reader, m.deps.sink)).credited).toBe(1);
  });

  test("coin credit is usage only: /balance shows it and /withdraw never pays it out", async () => {
    const k = await m.newKey();
    const commit = (await ensureDepositAddress(m.h.ctx.db, k.keyHash, "evm")) as Hex;
    const A = "0x00000000000000000000000000000000000000a1";
    await m.deposit(k.keyHash, "5", A); // $5 of stablecoin from A
    chain.pool = { token0: COIN, token1: USDG, liquidity: 10n ** 20n, spotTick: TICK_10C, twapTick: TICK_10C };
    pay(chain.head + 1n, commit, 200n * 10n ** 18n); // ~$20 in coin, from PAYER
    chain.head += 10n;
    expect((await scanCoinPayments(m.h.ctx.db, cfg, reader, m.deps.sink)).credited).toBe(1);
    const bal = await (await m.req("/balance", { headers: k.auth })).json();
    expect(bal.available_usd).toBeCloseTo(25, 1);
    expect(bal.usage_only_usd).toBeCloseTo(20, 1);
    expect(bal.withdraw_to).toEqual([{ chain: "base", address: A, max_usd: expect.closeTo(5, 1) }]); // the payer is no destination
    const w = (body: Record<string, unknown>, idem: string) => m.req("/withdraw", { headers: { ...k.auth, "idempotency-key": idem }, json: body });
    expect((await w({ chain: "base", to: A, amount_usd: "6" }, "coin-test-0001")).status).toBe(402);
    expect((await w({ chain: "rhc", to: PAYER }, "coin-test-0002")).status).toBe(403);
    const all = await (await w({ chain: "base", to: A, amount_usd: "all" }, "coin-test-0003")).json();
    expect(Number(all.withdrawal.amount_usd)).toBeCloseTo(5, 1);
  });

  test("deposit instructions offer the coin with its live price", async () => {
    const k = await m.newKey();
    chain.pool = { token0: COIN, token1: USDG, liquidity: 10n ** 20n, spotTick: TICK_10C, twapTick: TICK_10C };
    const d = (await (await m.req("/deposits", { headers: k.auth })).json()).instructions;
    expect(d.coin.coin_pay).toBe(PAY);
    expect(d.coin.token.symbol).toBe("ANMO");
    expect(Number(d.coin.price_usd)).toBeCloseTo(0.1, 3);
    expect(d.coin.max_usd_per_payment).toBe("50");
    expect(d.coin.key_commit).toMatch(/^0x[0-9a-f]{64}$/);
    chain.pool = null;
    expect((await (await m.req("/deposits", { headers: k.auth })).json()).instructions.coin.price_usd).toBeNull();
  });
});

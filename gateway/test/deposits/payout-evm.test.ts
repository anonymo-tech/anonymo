// Automatic withdrawals from the hot wallet: the right token amount, the per-withdrawal and daily limits, and never two
// transactions for one withdrawal (a retry re-sends the stored signed bytes).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { usdToPico } from "../../src/lib/money.ts";
import { evmHotWalletPayout, type PayoutChainClient } from "../../src/anonymo/deposits/payout-evm.ts";
import type { EvmChainConfig } from "../../src/anonymo/deposits/config.ts";
import { loadConfig } from "../../src/config.ts";
import { moneyHarness, type MoneyHarness } from "./harness.ts";

const USDG = "0x00000000000000000000000000000000000c0200" as Hex;
const TO = "0x00000000000000000000000000000000000000b2";
const chains: EvmChainConfig[] = [{ chain: "rhc", rpcUrl: "http://127.0.0.1:9", router: "0x00000000000000000000000000000000000000d1", confirmations: 1, startBlock: 0, maxRange: 10, tokens: [{ symbol: "USDG", address: USDG, decimals: 6 }] }];

const mock = () => {
  const c = { signed: [] as { token: Hex; to: Hex; amount: bigint }[], sent: [] as Hex[], mined: "success" as "success" | "reverted" | null };
  const client: PayoutChainClient = {
    address: "0x00000000000000000000000000000000000000ee",
    signTransfer: async (token, to, amount) => {
      c.signed.push({ token, to, amount });
      const n = c.signed.length.toString(16).padStart(2, "0");
      return { raw: `0x${n}${"aa".repeat(10)}` as Hex, hash: `0x${n.repeat(32)}` as Hex };
    },
    broadcast: async (raw) => void c.sent.push(raw),
    waitFor: async () => c.mined,
  };
  return { c, client };
};

let m: MoneyHarness;
beforeAll(async () => {
  m = await moneyHarness();
});
afterAll(async () => m?.close());

describe("hot wallet payouts", () => {
  test("pays the token amount, and a retry re-sends the same signed transaction instead of a new one", async () => {
    const { c, client } = mock();
    const payout = evmHotWalletPayout({ db: m.h.ctx.db, chains, clients: new Map([["rhc", client]]), maxPico: usdToPico("500"), dailyMaxPico: usdToPico("2000") });
    c.mined = null; // the first attempt is not mined in time (or the worker crashes)
    const req = { id: "wd_retry", chain: "rhc" as const, token: "USDG", to: TO, amountPico: usdToPico("12.345678") };
    await expect(payout.send(req)).rejects.toThrow("not mined yet");
    c.mined = "success";
    const r = await payout.send(req);
    expect(c.signed).toEqual([{ token: USDG, to: TO as Hex, amount: 12_345_678n }]); // signed once
    expect(c.sent.length).toBe(2); // broadcast twice, the same bytes
    expect(c.sent[0]).toBe(c.sent[1]);
    expect(r.txRef).toBe(`0x${"01".repeat(32)}`);
  });

  test("over the per-withdrawal limit, over the daily limit, or an unknown chain/token: nothing is signed", async () => {
    const { c, client } = mock();
    const payout = evmHotWalletPayout({ db: m.h.ctx.db, chains, clients: new Map([["rhc", client]]), maxPico: usdToPico("100"), dailyMaxPico: usdToPico("150") });
    await expect(payout.send({ id: "wd_big", chain: "rhc", token: "USDG", to: TO, amountPico: usdToPico("101") })).rejects.toThrow("over the automatic payout limit");
    await expect(payout.send({ id: "wd_base", chain: "base", token: "USDC", to: TO, amountPico: usdToPico("1") })).rejects.toThrow("no automatic payout rail");
    await expect(payout.send({ id: "wd_tok", chain: "rhc", token: "USDT", to: TO, amountPico: usdToPico("1") })).rejects.toThrow("no USDT");
    // Daily: record $100 already sent today, then ask for $60 more.
    await m.h.ctx.db.execute(`INSERT INTO anonymo_withdrawals (id, key_hash, account_id, idempotency_key, chain, token, to_addr, amount_pico, status, sent_at) VALUES ('wd_today', 'kh', 'acct', 'i-today', 'rhc', 'USDG', '${TO}', ${usdToPico("100")}, 'sent', now())` as never);
    await expect(payout.send({ id: "wd_day", chain: "rhc", token: "USDG", to: TO, amountPico: usdToPico("60") })).rejects.toThrow("daily automatic payout limit");
    expect(c.signed.length).toBe(0);
  });

  test("the hot wallet key is refused on the public API in production", () => {
    const base = { ANONYMO_ENV: "production", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", ANONYMO_PAYOUT_PRIVATE_KEY: "0x" + "4".repeat(64) };
    expect(() => loadConfig({ ...base, RUNTIME_ROLE: "api" })).toThrow("hot wallet");
    expect(loadConfig({ ...base, RUNTIME_ROLE: "worker", WORKER_JOBS: "anonymo-deposits" }).runtimeRole).toBe("worker");
  });
});

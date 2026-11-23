// The NYMO price window needs samples at most 60 s apart, so the worker samples the market on its own clock instead
// of only inside the deposit job (whose chain scans and withdrawals can run long).
import { expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { loadDepositsConfig } from "../../src/anonymo/deposits/config.ts";
import { NYMO_CURVE_MARKET } from "../../src/anonymo/deposits/nymo-curve.ts";
import { COIN_PRICE_EVERY_MS, moneyDeps, registerMoneyJobs } from "../../src/anonymo/deposits/services.ts";
import type { Ctx } from "../../src/context.ts";

const coin = (market: boolean) => JSON.stringify({
  ...(market ? { market: "nymo-native-chainlink" } : {}),
  rpcUrl: "http://127.0.0.1:9", coinPay: "0x00000000000000000000000000000000000000a5",
  token: { symbol: "NYMO", address: NYMO_CURVE_MARKET.token }, quote: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" },
  confirmations: 12,
});

function registered(env: Record<string, unknown>) {
  const jobs: { name: string; every: number }[] = [];
  const ctx = { db: {} as never, cfg: { production: false }, jobs: { register: (name: string, every: number) => jobs.push({ name, every }) } } as unknown as Ctx;
  registerMoneyJobs(ctx, moneyDeps(ctx, loadDepositsConfig(env)));
  return jobs;
}

test("a NYMO market gets its own price job, sampling well inside the 60 s gap limit", () => {
  const jobs = registered({ ANONYMO_COIN: coin(true) });
  expect(jobs.map((j) => j.name)).toContain("anonymo-deposits");
  const price = jobs.find((j) => j.name === "anonymo-coin-price");
  expect(price?.every).toBe(COIN_PRICE_EVERY_MS);
  expect(COIN_PRICE_EVERY_MS).toBeLessThanOrEqual(15_000);
});

test("no NYMO market, no price job", () => {
  expect(registered({}).map((j) => j.name)).not.toContain("anonymo-coin-price");
  expect(registered({ ANONYMO_COIN: coin(false) }).map((j) => j.name)).not.toContain("anonymo-coin-price");
});

test("a worker may list the price job", () => {
  const base = { ANONYMO_ENV: "production", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379" };
  expect(loadConfig({ ...base, RUNTIME_ROLE: "worker", WORKER_JOBS: "anonymo-deposits,anonymo-coin-price" }).workerJobs).toContain("anonymo-coin-price");
});

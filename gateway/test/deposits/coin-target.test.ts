import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { coinAmountForTarget, coinTargetRoute } from "../../src/anonymo/deposits/coin-target.ts";
import { nymoPaymentQuote, rpcCoinReader, sampleCoinPrice } from "../../src/anonymo/deposits/coin.ts";
import { nymoCurveQuote, NYMO_CURVE_MARKET, type NymoCurveSnapshot } from "../../src/anonymo/deposits/nymo-curve.ts";
import { anonymoDepositAddresses } from "../../src/anonymo/deposits/schema.ts";
import { usdToPico } from "../../src/lib/money.ts";
import { moneyHarness, type MoneyHarness } from "./harness.ts";

const DOLLAR = 10n ** 12n;
const UNIT = 10n ** 18n;
const CAP = 250n * DOLLAR;
const pay = "0x00000000000000000000000000000000000000a5";
const usd = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const dead = "0x000000000000000000000000000000000000dead";
const snapshot: NymoCurveSnapshot = {
  quoteReserve: String(4n * UNIT), tokenReserve: String(480_000_000n * UNIT), realQuoteReserve: String(2n * UNIT),
  ethUsdPico: String(1_600n * DOLLAR), feeBps: 100, creatorTaxBps: 150,
};
const valueForRaw = (raw: bigint) => nymoCurveQuote(snapshot, raw, CAP);
const maxRaw = valueForRaw(UNIT)!.maxAmountRaw;
const window = { maxRaw, maxPico: valueForRaw(maxRaw)!.valuePico, valueForRaw };

test("inversion finds the first raw amount attaining each target and observes the executable cap", () => {
  for (const target of [1n, DOLLAR / 100n, ...Array.from({ length: 243 }, (_, i) => BigInt(i + 1) * DOLLAR), window.maxPico]) {
    const q = coinAmountForTarget(window, target, 18);
    if (typeof q === "string") throw new Error(q);
    expect(valueForRaw(q.amountRaw)!.valuePico).toBe(q.valuePico);
    expect(q.valuePico).toBeGreaterThanOrEqual(target);
    if (q.amountRaw > 1n) expect(valueForRaw(q.amountRaw - 1n)!.valuePico).toBeLessThan(target);
    expect(q.effectiveUnitPico).toBe(q.valuePico * UNIT / q.amountRaw);
  }
  expect(coinAmountForTarget(window, window.maxPico + 1n, 18)).toBe("limit");
  expect(coinAmountForTarget({ ...window, maxRaw: 0n }, 1n, 18)).toBe("limit");
  expect(coinAmountForTarget({ ...window, valueForRaw: () => null }, DOLLAR, 18)).toBe("unavailable");
});

let h: MoneyHarness;
beforeAll(async () => {
  h = await moneyHarness({ env: { ANONYMO_COIN: JSON.stringify({
    market: "nymo-native-chainlink", rpcUrl: "http://127.0.0.1:9", coinPay: pay, token: { symbol: "NYMO", address: NYMO_CURVE_MARKET.token },
    quote: { address: usd }, maxUsdPerPayment: "250", confirmations: 12,
  }) } });
  h.deps.readers.coin = { ...rpcCoinReader("http://127.0.0.1:9"), paymentBinding: async () => ({
    chainId: 4663, coin: NYMO_CURVE_MARKET.token, dead, symbol: "NYMO", decimals: 18,
  }) };
});
afterAll(async () => h?.close());

const request = (app: Hono, query: string) => app.request("/deposits/coin/quote" + query);
function route(prepare = async (): Promise<typeof window | null> => window) {
  const app = new Hono();
  coinTargetRoute(app, h.h.ctx, h.deps, prepare);
  return app;
}

test("GET target quote is keyless, exact, uncached and allocates no deposit address", async () => {
  const rows = () => h.h.ctx.db.select().from(anonymoDepositAddresses);
  const before = await rows();
  const r = await request(route(), "?amount_usd=125.000125");
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const body = await r.json();
  expect(Object.keys(body).sort()).toEqual(["amount_raw", "estimated_credit_usd", "price_usd", "token", "coin_pay", "chain_id", "confirmations"].sort());
  expect(body).toMatchObject({ token: { address: NYMO_CURVE_MARKET.token, symbol: "NYMO", decimals: 18 }, coin_pay: pay, chain_id: 4663, confirmations: 12 });
  const raw = BigInt(body.amount_raw), target = usdToPico("125.000125");
  expect(usdToPico(body.estimated_credit_usd)).toBe(valueForRaw(raw)!.valuePico);
  expect(usdToPico(body.estimated_credit_usd)).toBeGreaterThanOrEqual(target);
  expect(valueForRaw(raw - 1n)!.valuePico).toBeLessThan(target);
  expect(usdToPico(body.price_usd)).toBe(valueForRaw(raw)!.valuePico * UNIT / raw);
  expect(await rows()).toEqual(before);
});

test("invalid, paused, mismatched, unavailable and over-limit responses expose no signing fields", async () => {
  for (const query of ["", "?amount_usd=0", "?amount_usd=-4", "?amount_usd=1e5", "?amount_usd=1.0123456789012", "?amount_usd=1&amount_usd=2"]) {
    const invalid = await request(route(), query);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.type).toBe("invalid_amount_usd");
  }
  const unavailable = route(async () => null);
  const check = async (app: Hono, query: string, status: number) => {
    const r = await request(app, query);
    expect(r.status).toBe(status);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.type).toBe(status === 422 ? "coin_quote_limit" : "coin_quote_unavailable");
  };
  await check(route(), "?amount_usd=250", 422);
  await check(unavailable, "?amount_usd=2", 503);
  h.deps.config.depositsPaused = true;
  try { await check(route(), "?amount_usd=2", 503); } finally { h.deps.config.depositsPaused = false; }
  const reader = h.deps.readers.coin!;
  h.deps.readers.coin = { ...reader, paymentBinding: async () => ({ ...await reader.paymentBinding(pay, NYMO_CURVE_MARKET.token), coin: pay }) };
  try { await check(route(), "?amount_usd=2", 503); } finally { h.deps.readers.coin = reader; }
});

test("different targets share only the in-flight window and an expired window cannot sign", async () => {
  const ready = Promise.withResolvers<typeof window>();
  let reads = 0;
  const endpoint = route(async () => { reads++; return ready.promise; });
  const first = request(endpoint, "?amount_usd=1");
  const second = request(endpoint, "?amount_usd=2");
  ready.resolve(window);
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(reads).toBe(1);
  expect((await request(endpoint, "?amount_usd=2")).status).toBe(200);
  expect(reads).toBe(2);
  const expired = route(async () => ({ ...window, valueForRaw: () => null }));
  expect((await request(expired, "?amount_usd=2")).status).toBe(503);
});

test("the ordinary gateway route inverts the same confirmed curve history that values wallet burns", async () => {
  const end = Math.floor(Date.now() / 1000);
  const cfg = h.deps.config.coin!;
  const previous = h.deps.readers.coin!;
  let observed = end - cfg.twapSeconds;
  const reader = { ...previous, nymoObservation: async () => ({ phase: "curve" as const, t: observed, updated: observed, snapshot }) };
  h.deps.readers.coin = reader;
  try {
    expect((await h.req("/deposits/coin/quote?amount_usd=1")).status).toBe(503);
    for (; observed <= end; observed += 30) await sampleCoinPrice(h.h.ctx.db, cfg, reader, observed * 1_000);
    observed = end;
    const target = usdToPico("73.19");
    const r = await h.req("/deposits/coin/quote?amount_usd=73.19");
    expect(r.status).toBe(200);
    const body = await r.json();
    const amount = BigInt(body.amount_raw);
    const actual = await nymoPaymentQuote(h.h.ctx.db, cfg, reader, amount);
    expect(actual?.withinLimit).toBe(true);
    expect(actual?.valuePico).toBe(usdToPico(body.estimated_credit_usd));
    expect(actual!.valuePico).toBeGreaterThanOrEqual(target);
    expect((await nymoPaymentQuote(h.h.ctx.db, cfg, reader, amount - 1n))!.valuePico).toBeLessThan(target);
  } finally {
    h.deps.readers.coin = previous;
  }
});

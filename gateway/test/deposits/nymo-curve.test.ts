import { expect, test } from "bun:test";
import { zeroAddress, type PublicClient } from "viem";
import { NYMO_CURVE_MARKET, nymoCurveQuote, readNymoCurveSnapshot, type NymoCurveSnapshot } from "../../src/anonymo/deposits/nymo-curve.ts";

const { token, curve, factory } = NYMO_CURVE_MARKET;
const unit = 10n ** 18n;
const dollar = 10n ** 12n;
const block = 1234n;
const ethUsd = 1_600n * dollar;
const cap = 250n * dollar;
const real = 2n * unit;
const phantom = 168n * unit / 100n;
const tokens = 480_000_000n * unit;

function market(overrides: Record<string, unknown> = {}, nativeBalance = real) {
  const values: Record<string, unknown> = {
    curve, token, factory, decimals: 18, symbol: "NYMO", pairToken: zeroAddress, isNativeQuote: true,
    readyToGraduate: false, graduated: false, getReserves: [real + phantom, tokens], realQuoteReserve: real,
    phantomQuote: phantom, feeBps: 100n, creatorTaxBps: 150n, balanceOf: tokens, ...overrides,
  };
  const calls: { address: string; functionName: string; blockNumber: bigint; args?: string[] }[] = [];
  const api = {
    readContract: async (call: typeof calls[number]) => {
      calls.push(call);
      const value = values[call.functionName];
      if (value instanceof Error) throw value;
      return value;
    },
    getBalance: async (call: { address: string; blockNumber: bigint }) => {
      calls.push({ ...call, functionName: "nativeBalance" });
      return nativeBalance;
    },
  } as unknown as Pick<PublicClient, "readContract" | "getBalance">;
  return { api, calls };
}

const sample: NymoCurveSnapshot = {
  quoteReserve: String(real + phantom), tokenReserve: String(tokens), realQuoteReserve: String(real),
  ethUsdPico: String(ethUsd), feeBps: 100, creatorTaxBps: 150,
};

test("reads both immutable bindings, actual balances and market state at the caller's confirmed price block", async () => {
  const { api, calls } = market();
  expect(await readNymoCurveSnapshot(api, block, ethUsd)).toEqual(sample);
  expect(calls.every((call) => call.blockNumber === block)).toBe(true);
  for (const call of calls) {
    expect(call.address).toBe(["curve", "symbol", "decimals", "balanceOf"].includes(call.functionName) ? token : curve);
    if (call.functionName === "balanceOf") expect(call.args).toEqual([curve]);
  }
  expect(calls).toHaveLength(16);
});

test("fails closed on a transition, another launch or currency, broken fees, RPC errors and insufficient backing", async () => {
  for (const invalid of [
    { curve: factory }, { token: factory }, { factory: token }, { decimals: 6 }, { symbol: "ANMO" }, { pairToken: token },
    { isNativeQuote: false }, { readyToGraduate: true }, { graduated: true }, { phantomQuote: 0n }, { realQuoteReserve: 0n },
    { feeBps: 0n }, { creatorTaxBps: 0n }, { balanceOf: tokens - 1n }, { getReserves: [real, tokens] },
    { getReserves: [real + phantom, 0n] }, { getReserves: new Error("unavailable") },
  ]) {
    expect(await readNymoCurveSnapshot(market(invalid).api, block, ethUsd)).toBeNull();
  }
  expect(await readNymoCurveSnapshot(market({}, real - 1n).api, block, ethUsd)).toBeNull();
  expect(await readNymoCurveSnapshot(market().api, block, 0n)).toBeNull();
});

test("prices the actual sale after both independently rounded fees and slippage", () => {
  const q1 = nymoCurveQuote(sample, unit, cap)!;
  const payment = 10_000_000n * unit;
  const q = nymoCurveQuote(sample, payment, cap)!;
  const gross = payment * (real + phantom) / (tokens + payment);
  const expected = (gross - gross / 100n - gross * 15n / 1_000n) * ethUsd / unit;
  expect(q.valuePico).toBe(expected);
  expect(q.withinLimit).toBe(true);
  expect(q.valuePico).toBeLessThan(q1.valuePico * (payment / unit));
  expect(q.depthBudgetPico).toBe(320n * dollar);
});

test("a $250 ceiling holds for any configured maximum and all automatically quoted sizes are backed", () => {
  for (const capDollars of [1n, 10n, 99n, 250n, 500n]) {
    const configured = capDollars * dollar;
    const ceiling = configured < cap ? configured : cap;
    const { maxAmountRaw, depthBudgetPico } = nymoCurveQuote(sample, unit, configured)!;
    for (let part = 1n; part <= 101n; part++) {
      const amount = maxAmountRaw * part / 100n;
      const q = nymoCurveQuote(sample, amount, configured)!;
      expect(q.valuePico).toBeLessThanOrEqual(ceiling);
      expect(q.valuePico).toBeLessThanOrEqual(depthBudgetPico);
      expect(q.withinLimit).toBe(amount <= maxAmountRaw);
      if (q.withinLimit) {
        const gross = amount * (real + phantom) / (tokens + amount);
        expect(gross).toBeLessThanOrEqual(real / 10n);
        expect(gross * ethUsd / unit).toBeLessThanOrEqual(ceiling);
      }
    }
    const largest = nymoCurveQuote(sample, maxAmountRaw, configured)!;
    const oversized = nymoCurveQuote(sample, 10n ** 60n, configured)!;
    expect(oversized.withinLimit).toBe(false);
    expect(oversized.valuePico).toBe(largest.valuePico);
    expect(oversized.valuePico).toBeGreaterThan(0n);
  }
});

test("a thin market and malformed stored observations cannot generate any quote", () => {
  const unsupported: NymoCurveSnapshot[] = [
    { ...sample, realQuoteReserve: String(unit) }, { ...sample, realQuoteReserve: sample.quoteReserve },
    { ...sample, ethUsdPico: "-1" }, { ...sample, tokenReserve: "0" }, { ...sample, quoteReserve: "1".repeat(90) },
    { ...sample, feeBps: 500 }, { ...sample, creatorTaxBps: 0 },
  ];
  for (const invalid of unsupported) expect(nymoCurveQuote(invalid, unit, cap)).toBeNull();
  expect(nymoCurveQuote(sample, 0n, cap)).toBeNull();
  expect(nymoCurveQuote(sample, unit, 0n)).toBeNull();
  expect(nymoCurveQuote(sample, 2n ** 256n, cap)).toBeNull();
});

test("conservative credit stays monotone when both independently rounded sell fees rise on the same wei", () => {
  // gross = floor(amount * 1,000,000 / (1,000,000 + amount)); this visits every gross wei in this small range.
  // Use 1,000,000 USD/ETH so a single ETH wei is observable as a whole pico-USD.
  const mock = { ...sample, quoteReserve: "1000000", tokenReserve: "1000000", realQuoteReserve: "999999", ethUsdPico: String(unit) };
  let prior = 0n;
  for (let amount = 1n; amount <= 810n; amount++) {
    const q = nymoCurveQuote(mock, amount, 1000n)!;
    const gross = amount * 1_000_000n / (1_000_000n + amount);
    const exact = gross - gross / 100n - gross * 15n / 1000n;
    expect(q.withinLimit).toBe(true);
    expect(q.valuePico).toBeGreaterThanOrEqual(prior);
    expect(q.valuePico).toBeLessThanOrEqual(exact);
    expect(q.valuePico).toBeGreaterThanOrEqual(exact - 1n);
    prior = q.valuePico;
  }
});

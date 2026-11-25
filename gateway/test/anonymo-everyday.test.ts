import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { keccak256, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anonymoDeposits } from "../src/anonymo/deposits/schema.ts";
import { entitlements, everydayCoverage, issueTodaysCredits } from "../src/anonymo/everyday/entitlements.ts";
import { scanEveryday } from "../src/anonymo/everyday/indexer.ts";
import { CHAIN_ID, DAY, orderIdFor, PASS_CHAT_LIMIT, PASS_DURATION_MS, skuBytes, stakeAverage, stakeTier, tierLimits, utcDay, WINDOW } from "../src/anonymo/everyday/policy.ts";
import { dailyMoCredits, passes, passOrders, stakeLinks } from "../src/anonymo/everyday/schema.ts";
import { loadConfig } from "../src/config.ts";
import { keys } from "../src/db/schema.ts";
import { balanceOf, post, release, reserve, settle, usageInBucket } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";
import { deployedInventory } from "../src/privacy/inventory.ts";
import { startRouter, type Harness } from "./helpers.ts";

const checkout = "0xabababababababababababababababababababab"; // gitleaks:allow
const staking = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"; // gitleaks:allow
const wallet = privateKeyToAccount(keccak256(stringToHex("sample-staking-wallet"))); // gitleaks:allow
const other = privateKeyToAccount(keccak256(stringToHex("sample-other-wallet"))); // gitleaks:allow
const table = [10_000n, 50_000n, 250_000n].map((level, i) => ({ minTwab: level * 10n ** 18n, dailyMicroUsd: BigInt(i + 1) * 1_000_000n }));
const base = "/v1/everyday";

let h: Harness;
beforeAll(async () => {
  h = await startRouter({
    providers: [{ id: "sample-pass-provider", name: "Sample pass provider", models: [
      { id: "sample-model", slug: "anonymo-1", prompt: "0.000001", completion: "0.000001", ctx: 32768 },
    ], reply: () => "A short sample answer." }],
    env: { ANONYMO_FEATURE_FREE_TIER: "true",
    ANONYMO_FEATURE_PASSES: "true", ANONYMO_FEATURE_STAKE: "true",
    ANONYMO_EVERYDAY_RPC_URL: "https://rpc.example.invalid",
    ANONYMO_STAKE_CREDITS_ADDRESS: staking, ANONYMO_STAKE_CREDITS_START_BLOCK: "1",
  } });
});
afterAll(async () => h?.close());

function chain(events: Record<string, unknown>[], times: Map<bigint, bigint>, head: bigint) {
  return {
    getChainId: async () => CHAIN_ID,
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: times.get(blockNumber) }),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      events.filter((event) => (event.blockNumber as bigint) >= fromBlock && (event.blockNumber as bigint) <= toBlock),
  } as unknown as PublicClient;
}

test("the switches default off and the exit discovery route does not need a key or a working RPC", async () => {
  expect(loadConfig({}).features).toMatchObject({ passes: false, stake: false });
  const inventory = JSON.stringify(deployedInventory({ ventures: false }));
  expect(inventory).not.toContain("pass_orders");
  expect(inventory).not.toContain("stake_links");
  expect(inventory).not.toContain("memory-sync:capacity:");
  expect(inventory).not.toContain("everyday:checkout:");
  expect(await (await h.request(base + "/stake/contract")).json()).toEqual({ chainId: CHAIN_ID, address: staking });
  expect((await h.request(base + "/stake")).status).toBe(401);
  const off = await startRouter({ providers: [] });
  try {
    for (const route of ["/passes", "/stake", "/stake/contract", "/access"])
      expect((await off.request(base + route)).status).toBe(404);
  } finally { await off.close(); }
});

test("a confirmed Paid event issues exactly one pass, irrespective of replay or an unrelated payer", async () => {
  const key = await h.newKey();
  const stamp = BigInt(Math.floor(Date.now() / 1000));
  const times = new Map([[1n, stamp - 5n], [2n, stamp - 4n]]);
  const ref = keccak256(stringToHex("sample-checkout-reference"));
  const orderId = orderIdFor(checkout, wallet.address, ref);
  const unknown = orderIdFor(checkout, other.address, ref);
  await h.ctx.db.insert(passOrders).values({ orderId, keyHash: key.hash, sku: "PASS30" });
  const paid = {
    blockNumber: 1n, logIndex: 2, removed: false,
    args: { orderId, sku: skuBytes("PASS30"), quantity: 1n, payer: wallet.address, orderRef: ref },
  };
  const events = [
    { ...paid, logIndex: 0, args: { ...paid.args, orderId: unknown } },
    { ...paid, logIndex: 1, args: { ...paid.args, quantity: 2n } },
    { ...paid, logIndex: 1, args: { ...paid.args, sku: skuBytes("PASS30_PLUS") } },
    paid,
    { ...paid, logIndex: 3 },
  ];
  const options = { address: checkout, start: 1n, confirmations: 2, mode: "checkout" as const };
  await scanEveryday(h.ctx.db, chain(events, times, 1n), options);
  expect(await h.ctx.db.select().from(passes)).toHaveLength(0);
  await scanEveryday(h.ctx.db, chain(events, times, 2n), options);
  await scanEveryday(h.ctx.db, chain(events, times, 2n), options);
  const [pass, ...rest] = await h.ctx.db.select().from(passes);
  expect(rest).toHaveLength(0);
  expect(pass).toMatchObject({ orderId, keyHash: key.hash, sku: "PASS30", starts: new Date(Number(stamp - 5n) * 1000) });
  expect(pass.ends.getTime() - pass.starts.getTime()).toBe(PASS_DURATION_MS);

  const paidAgain = orderIdFor(checkout, wallet.address, keccak256(stringToHex("sample-second-order")));
  await h.ctx.db.insert(passOrders).values({ orderId: paidAgain, keyHash: key.hash, sku: "PASS30" });
  await scanEveryday(h.ctx.db, chain([{ ...paid, blockNumber: 2n, args: { ...paid.args, orderId: paidAgain } }], times, 3n), options);
  const [queued] = await h.ctx.db.select().from(passes).where(eq(passes.orderId, paidAgain));
  expect(queued.starts).toEqual(pass.ends);

  const [account] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  const rights = await entitlements(h.ctx, key.hash);
  const amount = usdToPico("1");
  const chatBucket = `chat:${rights.day}`;
  const covered = (id: string, units = 1) => reserve(h.ctx.db, {
    id, accountId: account.accountId, keyHash: key.hash, amount,
    cover: everydayCoverage(key.hash, rights, "chat", amount, units),
  });
  expect(await covered("pass-refusal-fixture", PASS_CHAT_LIMIT)).toBe(0n);
  expect(await settle(h.ctx.db, "pass-refusal-fixture", 0n, { consumeCoverage: false })).toMatchObject({ charged: 0n });
  expect((await usageInBucket(h.ctx.db, key.hash, chatBucket)).units).toBe(0);
  expect(await covered("pass-served-fixture", PASS_CHAT_LIMIT)).toBe(0n);
  expect(await settle(h.ctx.db, "pass-served-fixture", amount)).toMatchObject({ charged: 0n });
  await expect(covered("pass-over-limit-fixture")).rejects.toMatchObject({ type: "pass_fair_use" });
});

test("seven-day stake averages include unstaked time and select both sides of each timelocked boundary", () => {
  const now = 10n * DAY;
  for (const [i, { minTwab, dailyMicroUsd }] of table.entries()) {
    const expected = (["Plus", "Pro", "Black"] as const)[i];
    const { twab } = stakeAverage([{ at: now - WINDOW / 2n, balance: minTwab * 2n }], now);
    expect(twab).toBe(minTwab);
    expect(stakeTier(twab, table)).toEqual({ tier: expected, dailyMicroUsd });
    expect(stakeTier(twab - 1n, table).tier).toBe((["Free", "Plus", "Pro"] as const)[i]);
    expect(stakeTier(twab + 1n, table).tier).toBe(expected);
    expect(stakeAverage([{ at: now - 2n * WINDOW, balance: minTwab }, { at: now, balance: 0n }], now))
      .toEqual({ twab: minTwab, balance: 0n });
  }
  expect(tierLimits("Plus")).toMatchObject({ dailyVoiceSeconds: 7200, partyPlayers: 4, council: false, priority: false });
  expect(tierLimits("Pro")).toMatchObject({ dailyVoiceSeconds: 21600, partyPlayers: 6, council: true, priority: true });
  expect(tierLimits("Black").memoryItems).toBeNull();
  expect(tierLimits("Free", "PASS30_PLUS")).toMatchObject({ memoryItems: 2048, partyPlayers: 6, council: true });
});

test("signed wallet links are key-bound and confirmed stake only yields one key-scoped grant with no cash value", async () => {
  const key = await h.newKey();
  const unrelated = await h.newKey();
  const link = (auth: typeof key.auth, json: object) => h.request(base + "/stake/link", { method: "POST", headers: auth, json });
  const address = wallet.address.toLowerCase() as Address;
  const challenge = await (await link(key.auth, { wallet: address })).json() as { message: string; expires: number };
  expect(challenge.message).not.toContain(key.hash);
  const signature = await wallet.signMessage({ message: challenge.message });
  expect((await link(unrelated.auth, { wallet: address, signature, expires: challenge.expires })).status).toBe(401);
  expect((await link(key.auth, { wallet: address, signature, expires: challenge.expires - 301 })).status).toBe(401);
  expect((await link(key.auth, { wallet: address, signature, expires: challenge.expires })).status).toBe(200);
  expect((await link(key.auth, { wallet: address, signature, expires: challenge.expires })).status).toBe(200);
  expect(await h.ctx.db.select().from(stakeLinks)).toEqual([{ wallet: address, keyHash: key.hash }]);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const time = new Map([[1n, now - WINDOW], [2n, now], [3n, now]]);
  const options = { address: staking, start: 1n, confirmations: 1, mode: "stake" as const };
  const events = [
    { eventName: "TierTableSet", blockNumber: 1n, logIndex: 0, removed: false, args: { table } },
    { eventName: "Staked", blockNumber: 1n, logIndex: 1, removed: false, args: { account: wallet.address, balance: table[1].minTwab } },
  ];
  await scanEveryday(h.ctx.db, chain(events, time, 2n), options);
  await issueTodaysCredits(h.ctx);
  await issueTodaysCredits(h.ctx);
  expect(await h.ctx.db.select().from(dailyMoCredits)).toHaveLength(1);
  const rights = await entitlements(h.ctx, key.hash);
  expect(rights).toMatchObject({ tier: "Pro", daily: usdToPico("2"), twab: table[1].minTwab });
  expect(await (await h.request(base + "/stake", { headers: key.auth })).json()).toMatchObject({ tier: "Pro", dailyCreditsUsd: 2 });
  expect(await h.ctx.db.select().from(dailyMoCredits)).toHaveLength(1);
  expect((await entitlements(h.ctx, unrelated.hash)).daily).toBe(0n);

  const [account] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  const amount = usdToPico("1.25");
  const hold = (id: string) => reserve(h.ctx.db, { id, accountId: account.accountId, keyHash: key.hash, amount,
    cover: everydayCoverage(key.hash, rights, "credits", amount),
  });
  expect(await hold("daily-dropped-fixture")).toBe(0n);
  await expect(hold("daily-overrun-fixture")).rejects.toMatchObject({ type: "insufficient_credits" });
  await release(h.ctx.db, "daily-dropped-fixture");
  expect(await hold("daily-served-fixture")).toBe(0n);
  expect(await settle(h.ctx.db, "daily-served-fixture", amount)).toMatchObject({ charged: 0n, creditCovered: amount });
  expect(await balanceOf(h.ctx.db, account.accountId)).toEqual({ balance: 0n, available: 0n, held: 0n });

  const funds = usdToPico("1");
  await post(h.ctx.db, { accountId: account.accountId, keyHash: key.hash, amount: funds, kind: "deposit", ref: "fixture-deposit-cash" });
  await h.ctx.db.insert(anonymoDeposits).values({ ref: "rhc:fixture", keyHash: key.hash, chain: "rhc", token: "USDG",
    amountPico: funds, sourceAddr: address, status: "credited" });
  const balance = await (await h.request("/balance", { headers: key.auth })).json();
  expect(balance).toMatchObject({ available_usd: 1, withdraw_to: [{ address, max_usd: 1 }] });
  const response = await h.request("/withdraw", { method: "POST", headers: { ...key.auth, "idempotency-key": "fixture-withdraw-credit" },
    json: { chain: "rhc", to: address, amount_usd: "1.25" } });
  expect(response.status).toBe(402);

  await scanEveryday(h.ctx.db, chain([
    { eventName: "Unstaked", blockNumber: 3n, logIndex: 0, removed: false, args: { account: wallet.address, balance: 0n } },
  ], time, 3n), options);
  const nextDay = new Date(Date.now() + Number(DAY) * 1000);
  expect((await entitlements(h.ctx, key.hash, nextDay)).daily).toBe(0n);
  expect((await h.ctx.db.select().from(dailyMoCredits))[0].day).toBe(utcDay());
});

test("voice quota counts verified output seconds and concurrent holds cannot overspend it", async () => {
  const key = await h.newKey();
  const [account] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  const rights = { ...await entitlements(h.ctx, key.hash), limits: tierLimits("Plus") };
  const amount = usdToPico("1");
  for (const id of ["voice-fixture-one", "voice-fixture-two"])
    expect(await reserve(h.ctx.db, { id, accountId: account.accountId, keyHash: key.hash, amount,
      cover: everydayCoverage(key.hash, rights, "voice", amount),
    })).toBe(0n);
  expect(await settle(h.ctx.db, "voice-fixture-one", amount, { coverageUnits: 7199 })).toMatchObject({ charged: 0n });
  await expect(settle(h.ctx.db, "voice-fixture-two", amount, { coverageUnits: 2 })).rejects.toMatchObject({ type: "included_voice_limit" });
  await release(h.ctx.db, "voice-fixture-two");
  expect(await usageInBucket(h.ctx.db, key.hash, `voice:${rights.day}`)).toMatchObject({ units: 7199 });
});

test("a Pass funds the normal chat entry point without cash and never bypasses the floor", async () => {
  const key = await h.newKey();
  const orderId = keccak256(stringToHex("sample-chat-pass"));
  const now = new Date();
  await h.ctx.db.insert(passOrders).values({ orderId, keyHash: key.hash, sku: "PASS30" });
  await h.ctx.db.insert(passes).values({ orderId, keyHash: key.hash, sku: "PASS30", starts: now, ends: new Date(now.getTime() + PASS_DURATION_MS) });
  const chat = (extra: object = {}) => h.request("/v1/chat/completions", {
    method: "POST", headers: key.auth, json: {
      model: "anonymo-1", messages: [{ role: "user", content: "A brief sample question." }], max_tokens: 64, ...extra,
    },
  });
  const provider = h.mocks["sample-pass-provider"];
  const before = provider.stats.requests;
  const floor = h.ctx.anonymo.floor;
  h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "cbrn" }) };
  try {
    expect((await chat()).status).toBe(451);
    expect(provider.stats.requests).toBe(before);
    expect((await usageInBucket(h.ctx.db, key.hash, `chat:${utcDay()}`)).units).toBe(0);
  } finally { h.ctx.anonymo.floor = floor; }
  const result = await chat();
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ usage: { cost: 0 } });
  expect((await usageInBucket(h.ctx.db, key.hash, `chat:${utcDay()}`)).units).toBe(1);
  const multiple = await chat({ n: 2 });
  expect(multiple.status).toBe(402);
  expect(provider.stats.requests).toBe(before + 1);
});

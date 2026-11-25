import { afterAll, beforeAll, expect, test, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.ts";
import { insertRootKey, resolveKey } from "../src/api/auth.ts";
import { accrueCreator } from "../src/anonymo/creators/accrual.ts";
import { DAILY_CAP, DAY_MS, RedisCreatorCounters, dayOf, overlapRate, weekDate, weekOf, WEEK_MS, type CreatorCounters } from "../src/anonymo/creators/counters.ts";
import { payoutTree, payoutNode, combinePayoutNodes, stagePayoutWeek, walletClaims, EMPTY_ROOT, creatorPayoutTick } from "../src/anonymo/creators/payouts.ts";
import { acceptReferral, creatorReferralTick, referralLink, REFERRAL_CREDIT } from "../src/anonymo/creators/referrals.ts";
import { creatorAccruals, creatorCharacters, payoutRoots, creatorReferrals } from "../src/anonymo/creators/schema.ts";
import { createDepositSink } from "../src/anonymo/deposits/sink.ts";
import { codeCreditPico } from "../src/anonymo/deposits/withdraw.ts";
import { cardHash, normalizeCard } from "../src/characters/card.ts";
import { generateApiKey } from "../src/chain/keys.ts";
import { generations, ledger, holds } from "../src/db/schema.ts";
import { post } from "../src/ledger/ledger.ts";
import { parseSubmission } from "../src/services/batches.ts";
import { log, sha256 } from "../src/lib/util.ts";
import { deployedInventory } from "../src/privacy/inventory.ts";
import { MODELS, startRouter } from "./helpers.ts";

const env = { ANONYMO_ENV: "test", DATABASE_URL: "pglite://memory", REDIS_URL: "", ANONYMO_FEATURE_CREATORS: true, LOG_LEVEL: "error" };
const api = "/api/v1/creators";
const USD = 1_000_000_000_000n;
const newWallet = () => privateKeyToAccount(generatePrivateKey());
const publisher = newWallet();
const creatorWallet = publisher.address.toLowerCase() as Hex;
const ringNow = Date.UTC(2026, 10, 26);
const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const fingerprint = sha256("fixture-day-salt");

function fixtureCounters(epoch = fingerprint): CreatorCounters {
  const counters = new Map<string, bigint>();
  const audience = new Map<string, Set<string>>();
  return {
    async cap(now, key, wallet, spend) {
      const id = `${dayOf(now)}:${key}:${wallet}`;
      const used = counters.get(id) ?? 0n;
      const allowed = spend < DAILY_CAP - used ? spend : DAILY_CAP - used;
      counters.set(id, used + allowed);
      return { allowed, epoch };
    },
    async visit(now, key, character, newlyFunded) {
      const id = `${dayOf(now)}:${character}`;
      const all = audience.get(id) ?? new Set();
      const fresh = audience.get(id + ":new") ?? new Set();
      all.add(key);
      if (newlyFunded) fresh.add(key);
      audience.set(id, all);
      audience.set(id + ":new", fresh);
      return { funded: all.size, newKeys: fresh.size };
    },
    async audience() { return { unique: 0, week2: null }; },
  };
}

const active = () => createApp({ env, startJobs: false });
type Setup = Awaited<ReturnType<typeof active>>;
let setup: Setup;
beforeAll(async () => { setup = await active(); });
afterAll(async () => { await setup?.close(); });
async function key(ctx: Setup["ctx"], funding?: bigint, source = newWallet().address) {
  const secret = generateApiKey();
  const created = await ctx.db.transaction((tx) => insertRootKey(tx, ctx.cfg, secret));
  if (funding) await createDepositSink(ctx.db, { isBlocked: async () => false }).credit({
    chain: "rhc", ref: `fixture:${crypto.randomUUID()}`, amount: funding, keyHash: created.keyHash, sourceAddr: source,
  });
  return { secret, row: (await resolveKey(ctx, secret))! };
}
const profile = {
  name: "Beacon Runner", description: "A keeper at a remote lighthouse.", personality: "Curious and patient.",
  scenario: "A ferry arrives at dawn.", tags: ["mystery"],
};
async function signedPublication(secret: string, fields = profile, shareBps = 1500, adult = false, nonceOffset = 0) {
  const body = { ...fields, cardHash: await cardHash(normalizeCard(fields)), creatorWallet, shareBps, adult };
  const at = Math.floor(Date.now() / 1000) - nonceOffset;
  const signature = await publisher.signMessage({ message: `anonymo:${at}:${sha256(JSON.stringify(body))}` });
  return json(body, { ...auth(secret), "x-wallet-auth": `${creatorWallet}:${at}:${signature}` });
}

test("feature defaults off, including its inventory and routes", async () => {
  const router = await createApp({ env: { ...env, ANONYMO_FEATURE_CREATORS: false }, startJobs: false });
  try {
    expect((await router.app.request(`${api}/discover`)).status).toBe(404);
    expect((await router.app.request(`${api}/claims?wallet=${creatorWallet}`)).status).toBe(404);
    expect(JSON.stringify(deployedInventory(router.ctx.cfg.features))).not.toContain("creator_accruals");
    expect(JSON.stringify(deployedInventory(router.ctx.cfg.features))).not.toContain("creators:cap:");
    expect(router.ctx.jobs.status().some((job) => job.name.startsWith("creator-"))).toBeFalse();
  } finally {
    await router.close();
  }
});

test("wallet-signed publication validates the cut, floor-checks metadata and gates adult listings on age and funding", async () => {
  const { app, ctx } = setup;
  const author = await key(ctx, USD);
  const unfunded = await key(ctx);
  const adult = { ...profile, name: "After Dusk", tags: ["noir"] };
  expect((await app.request(`${api}/publish`, json({ ...profile }, auth(author.secret)))).status).toBe(400);
  expect((await app.request(`${api}/publish`, await signedPublication(author.secret, profile, 1501))).status).toBe(400);
  expect((await app.request(`${api}/publish`, await signedPublication(author.secret))).status).toBe(201);
  const blocked = { ...profile, name: "Floor fixture" };
  const previous = ctx.anonymo.floor;
  ctx.anonymo.floor = { async check({ text }) { return text.includes(blocked.name) ? { ok: false, category: "cbrn" } : { ok: true }; } };
  try {
    const denied = await app.request(`${api}/publish`, await signedPublication(author.secret, blocked, 1000));
    expect(denied.status).toBe(451);
    expect(await denied.text()).not.toContain(blocked.name);
  } finally {
    ctx.anonymo.floor = previous;
  }
  const publisher2 = await key(ctx);
  expect((await app.request(`${api}/publish`, await signedPublication(publisher2.secret, adult, 500, true))).status).toBe(201);
  const discover = async (params: string, headers: Record<string, string> = {}) => {
    const response = await app.request(`${api}/discover?${params}`, { headers });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()) as { data: { name: string }[]; mature: boolean };
  };
  expect((await discover("adult=1")).data.map((card) => card.name)).toEqual([profile.name]);
  expect((await discover("adult=1", auth(unfunded.secret))).data.map((card) => card.name)).toEqual([profile.name]);
  expect((await discover("adult=0", auth(author.secret))).data.map((card) => card.name)).toEqual([profile.name]);
  expect((await discover("adult=1&tag=noir", auth(author.secret))).data.map((card) => card.name)).toEqual([adult.name]);
  expect((await discover("adult=1&q=BEACON", auth(author.secret))).data.map((card) => card.name)).toEqual([profile.name]);
  const [row] = await ctx.db.select().from(creatorCharacters).where(eq(creatorCharacters.name, adult.name));
  expect(row!.floorVerdict).toEqual({ allowed: true });
  expect((await app.request(`/api/v1/characters/${row!.id}`)).status).toBe(404);
  const batched = { requests: [{ custom_id: "fixture-line", url: "/v1/chat/completions",
    body: { model: "anonymo-1", characterId: row!.id, messages: [{ role: "user", content: "Hello." }] },
  }] };
  expect(() => parseSubmission(ctx, batched)).toThrow("nothing was queued");
});

test("paid chat attribution aggregates 50 keys, applies one $5 cap across a creator’s cards, and excludes their deposit wallet", async () => {
  const { ctx } = setup;
  const [a, b] = await ctx.db.insert(creatorCharacters).values(["First", "Second"].map((name) => ({
    ...profile, name, adult: false, cardHash: sha256(name), creatorWallet, shareBps: 1500, floorVerdict: { allowed: true },
  }))).returning();
  const counters = fixtureCounters();
  const keys = await Promise.all(Array.from({ length: 50 }, () => key(ctx, 5n * USD)));
  const party = await key(ctx, 5n * USD);
  const own = await key(ctx, 5n * USD, creatorWallet);
  const unfunded = await key(ctx);
  const now = Date.now() + 2 * DAY_MS;
  const accrue = (character: typeof a, payer: typeof keys[number], spend: bigint, at = now, store = counters) =>
    ctx.db.transaction((tx) => accrueCreator(tx, store, character!, payer.row, spend, at));

  for (const viewer of keys) await accrue(a, viewer, USD / 10n);
  const [fifty] = await ctx.db.select().from(creatorAccruals).where(eq(creatorAccruals.characterId, a!.id));
  expect(fifty).toMatchObject({ fundedKeys: 50, chats: 50, amount: 750_000_000_000n, frozen: false });
  for (let attempt = 0; attempt < 500; attempt++) await accrue(attempt % 2 === 0 ? a : b, party, USD / 10n);
  await accrue(a, own, USD);
  await accrue(b, unfunded, USD);
  await accrue(b, party, USD, now, fixtureCounters(sha256("reset")));
  const rows = (await ctx.db.select().from(creatorAccruals)).filter((row) => row.characterId === a!.id || row.characterId === b!.id);
  expect(rows.reduce((sum, row) => sum + row.amount, 0n)).toBe(1_500_000_000_000n);
  expect(rows.reduce((sum, row) => sum + row.chats, 0)).toBe(550);
  const stored = JSON.stringify(rows, (_, value) => typeof value === "bigint" ? value.toString() : value);
  for (const viewer of [...keys, own, party, unfunded]) {
    expect(stored).not.toContain(viewer.row.keyHash);
    expect(stored).not.toContain(viewer.secret);
  }
}, 20_000);

test("new-key rings freeze only aggregate rows and an approved release remains held until eligible", async () => {
  const { ctx } = setup;
  const [row] = await ctx.db.insert(creatorCharacters).values({
    ...profile, name: "Ring", adult: false, cardHash: sha256("ring"), creatorWallet, shareBps: 1000, floorVerdict: { allowed: true },
  }).returning();
  const visitors = await Promise.all(Array.from({ length: 20 }, () => key(ctx, USD)));
  const counters = fixtureCounters();
  const now = Date.now();
  for (const visitor of visitors) await ctx.db.transaction((tx) => accrueCreator(tx, counters, row!, visitor.row, USD / 10n, now));
  const [daily] = await ctx.db.select().from(creatorAccruals).where(eq(creatorAccruals.characterId, row!.id));
  expect(daily).toMatchObject({ fundedKeys: 20, frozen: true });
  expect(daily!.heldUntil.getTime() - now).toBeGreaterThanOrEqual(7 * DAY_MS);
});

test("Merkle-sum payout proofs follow the contract, including odd branches and an empty tip root", () => {
  const rootParams = parseAbiParameters("bytes32, uint256");
  expect(payoutTree(new Map())).toEqual({ root: EMPTY_ROOT, total: "0", leaves: [] });
  for (const size of [1, 2, 3, 9, 50]) {
    const wallets = new Map(Array.from({ length: size }, (_, i) => [newWallet().address, BigInt(i * 31 + 1)]));
    const tree = payoutTree(wallets);
    expect(tree).toEqual(payoutTree(new Map([...wallets].reverse())));
    for (const leaf of tree.leaves) {
      const node = leaf.proof.reduce((acc, { hash, sum }) => combinePayoutNodes(acc, { hash, sum: BigInt(sum) }), payoutNode(leaf.wallet, BigInt(leaf.amount)));
      expect(node.sum).toBe(BigInt(tree.total));
      expect(keccak256(encodeAbiParameters(rootParams, [node.hash, node.sum]))).toBe(tree.root);
    }
  }
});

test("only mature unfrozen amounts enter a weekly root and sub-USDG-unit dust carries forward", async () => {
  const { ctx } = setup;
  // Isolate this payout fixture from live-day accruals in this file.
  const week = weekOf(ringNow) - 60;
  const held = new Date((week + 2) * WEEK_MS);
  const wallet = newWallet().address.toLowerCase() as Hex;
  const [card] = await ctx.db.insert(creatorCharacters).values({
    ...profile, cardHash: sha256("payout"), creatorWallet: wallet, shareBps: 1500, adult: false, floorVerdict: { allowed: true },
  }).returning();
  await ctx.db.insert(creatorAccruals).values([
    { characterId: card!.id, day: weekDate(week), amount: 1_500_000n, heldUntil: held, chats: 1, fundedKeys: 1 },
    { characterId: card!.id, day: dayOf(Date.parse(weekDate(week)) + DAY_MS), amount: 99n * USD, heldUntil: held, chats: 1, fundedKeys: 1, frozen: true },
  ]);
  await stagePayoutWeek(ctx, week, held.getTime() - 1, false);
  expect(await walletClaims(ctx, wallet)).toEqual([]);
  await stagePayoutWeek(ctx, week, held.getTime(), false);
  await stagePayoutWeek(ctx, week, held.getTime(), false);
  expect(await walletClaims(ctx, wallet)).toMatchObject([{ tx: null, amount: "1", tip: "0" }]);
  expect((await ctx.db.select().from(creatorAccruals).where(eq(creatorAccruals.characterId, card!.id)))
    .find((row) => row.day === weekDate(week))).toMatchObject({ amount: 1_500_000n, allocated: 1_000_000n });
  const [root] = await ctx.db.select().from(payoutRoots).where(eq(payoutRoots.week, weekDate(week)));
  expect(root).toMatchObject({ total: "1" });
});

test("referrals activate once after first funding, credit both sides, and only share the first 90 days of paid usage", async () => {
  const { ctx } = setup;
  const inviter = await key(ctx, USD);
  const invitee = await key(ctx);
  ctx.cfg.creators.referralBonus = USD / 2n;
  ctx.cfg.creators.referralShareBps = 500;
  const code = await referralLink(ctx, inviter.row);
  expect(await referralLink(ctx, inviter.row)).toBe(code);
  await expect(acceptReferral(ctx, inviter.row, code)).rejects.toMatchObject({ status: 409 });
  await acceptReferral(ctx, invitee.row, code);
  await acceptReferral(ctx, invitee.row, code);
  await creatorReferralTick(ctx);
  expect(await ctx.db.select().from(ledger).where(eq(ledger.kind, REFERRAL_CREDIT))).toEqual([]);
  await post(ctx.db, { accountId: invitee.row.accountId, keyHash: invitee.row.keyHash, amount: 4n * USD, ref: "fixture-funding", kind: "code" });
  await post(ctx.db, { accountId: invitee.row.accountId, keyHash: invitee.row.keyHash, amount: -2n * USD, ref: "fixture-spend", kind: "usage" });
  await creatorReferralTick(ctx);
  await creatorReferralTick(ctx);
  const [referral] = await ctx.db.select().from(creatorReferrals).where(eq(creatorReferrals.inviteeKeyHash, invitee.row.keyHash));
  expect(referral?.spendCredit).toBe(USD / 10n);
  await post(ctx.db, { accountId: invitee.row.accountId, keyHash: invitee.row.keyHash, amount: -USD, ref: "fixture-late-spend", kind: "usage" });
  // Ledger is append-only; shift the referral window instead of retroactively editing settled transactions.
  await ctx.db.update(creatorReferrals).set({ fundedAt: new Date(Date.now() - 91 * DAY_MS), acceptedAt: new Date(Date.now() - 92 * DAY_MS) })
    .where(eq(creatorReferrals.inviteeKeyHash, invitee.row.keyHash));
  await creatorReferralTick(ctx);
  expect(await codeCreditPico(ctx.db, inviter.row.accountId)).toBe(600_000_000_000n);
  expect((await ctx.db.select().from(ledger).where(eq(ledger.kind, REFERRAL_CREDIT))).filter((row) => row.accountId === invitee.row.accountId).map((row) => row.amount))
    .toEqual([USD / 2n]);
});

test("registered creator chat passes the ordinary floor, accrues only after settlement, and keeps the publication out of keyed rows", async () => {
  const router = await startRouter({ env: { ANONYMO_FEATURE_CREATORS: "true" } });
  const logger = spyOn(log, "error");
  try {
    router.ctx.creatorCounters = fixtureCounters();
    const payer = await router.fundedKey();
    const [card] = await router.ctx.db.insert(creatorCharacters).values({
      ...profile, creatorWallet, adult: true, cardHash: sha256("integration"), shareBps: 1500, floorVerdict: { allowed: true },
    }).returning();
    const prompt = "fixture-request-text-keep-out";
    const call = (adult: boolean) => router.request("/v1/chat/completions", {
      method: "POST", headers: payer.auth, json: { model: MODELS.llama.slug, characterId: card!.id, creatorAdult: adult, messages: [{ role: "user", content: prompt }], cache: { mode: "exact" } },
    });
    expect((await call(false)).status).toBe(404);
    let calls = 0;
    router.ctx.anonymo.floor = { check: async ({ text }) => { calls++; expect(text).toContain(profile.name); return { ok: false, category: "cbrn" }; } };
    const requests = router.mocks.alpha!.stats.requests;
    expect((await call(true)).status).toBe(451);
    expect(router.mocks.alpha!.stats.requests).toBe(requests);
    expect(calls).toBe(1);
    router.ctx.anonymo.floor = { check: async () => ({ ok: true }) };
    const classifier = router.ctx.anonymo.refusal;
    router.ctx.anonymo.refusal = { isRefusal: async () => true };
    const refusal = await call(true);
    expect(refusal.status).toBe(200);
    expect((await refusal.json() as { usage: { cost: number } }).usage.cost).toBe(0);
    expect(await router.ctx.db.select().from(creatorAccruals)).toEqual([]);
    router.ctx.anonymo.refusal = classifier;
    const res = await call(true);
    expect(res.status).toBe(200);
    const usage = (await res.json() as { usage: { cost: number } }).usage;
    const [totals] = await router.ctx.db.select().from(creatorAccruals);
    expect(usage.cost).toBeGreaterThan(0);
    expect(totals).toMatchObject({ characterId: card!.id, fundedKeys: 1, chats: 1 });
    expect(router.ctx.cache.size()).toBe(0);
    for (const table of [generations, ledger, holds] as const) {
      const rows = await router.ctx.db.select().from(table);
      const stored = JSON.stringify(rows, (_, value) => typeof value === "bigint" ? value.toString() : value);
      expect(stored).not.toContain(card!.id);
      expect(stored).not.toContain(prompt);
    }
    expect(JSON.stringify(logger.mock.calls)).not.toContain(card!.id);
  } finally {
    logger.mockRestore();
    await router.close();
  }
}, 20_000);

test.skipIf(!process.env.TEST_CREATOR_REDIS_SOCKET)("Redis Lua caps concurrent spends and HLL estimates cohorts without a stored visitor list", async () => {
  const redis = new Redis(process.env.TEST_CREATOR_REDIS_SOCKET!);
  try {
    const counters = new RedisCreatorCounters(redis);
    const viewer = sha256("viewer");
    const creator = newWallet().address;
    const card = crypto.randomUUID();
    const now = Date.now();
    const spend = await Promise.all(Array.from({ length: 500 }, () => counters.cap(now, viewer, creator, USD / 10n)));
    expect(spend.reduce((total, result) => total + result.allowed, 0n)).toBe(DAILY_CAP);
    expect(new Set(spend.map((v) => v.epoch)).size).toBe(1);
    const capKeys = await redis.keys("creators:cap:*");
    expect(capKeys).toHaveLength(1);
    expect(capKeys[0]).not.toContain(creator);
    expect(capKeys[0]).not.toContain(viewer);
    expect(await redis.ttl(capKeys[0]!)).toBeGreaterThan(86_390);
    const first = (weekOf(now) - 2) * WEEK_MS;
    for (let i = 0; i < 50; i++) await counters.visit(first, sha256(String(i)), card, true);
    for (let i = 0; i < 20; i++) await counters.visit(first + WEEK_MS, sha256(String(i)), card, false);
    const { week2 } = await counters.audience(now, card);
    expect(week2).toBeGreaterThanOrEqual(38);
    expect(week2).toBeLessThanOrEqual(42);
    expect(await redis.keys(`*${viewer}*`)).toEqual([]);
  } finally {
    redis.disconnect();
  }
});

test("a week-2 estimate clamps sketch error and leaves empty cohorts blank", () => {
  expect(overlapRate(0, 100, 100)).toBeNull();
  expect(overlapRate(50, 25, 65)).toBe(20);
  expect(overlapRate(10, 20, 5)).toBe(100);
  expect(overlapRate(10, 20, 60)).toBe(0);
});

test("claim proofs and contract coordinates are reachable from a blocked region", async () => {
  for (const compliance of [false, true]) {
    const router = await createApp({ env: { ...env, ANONYMO_FEATURE_COMPLIANCE: compliance, ANONYMO_REGION_BLOCKED: "GB" }, startJobs: false });
    try {
      const headers = { "cf-ipcountry": "GB" };
      expect((await router.app.request(`${api}/discover`, { headers })).status).toBe(451);
      expect((await router.app.request(`${api}/claims?wallet=${creatorWallet}`, { headers })).status).toBe(200);
      expect((await router.app.request(`${api}/contracts`, { headers })).status).toBe(200);
    } finally {
      await router.close();
    }
  }
}, 20_000);

test("payout processing checks exact workers funding and can post a mature tip-only root", async () => {
  const { ctx } = setup;
  const saved = { ...ctx.cfg.creators };
  const deployWeek = weekOf(ringNow) - 55;
  const now = (deployWeek + 2) * WEEK_MS;
  const contract = newWallet().address;
  const result = `0x${sha256("posted-root")}` as Hex;
  const onChain = new Map<bigint, Hex>();
  let tipOnlyFunding = 1n;
  ctx.cfg.creators.payouts = contract;
  ctx.cfg.creators.startBlock = 10n;
  const hasSigner = spyOn(ctx.chain, "roleAddress").mockReturnValue(creatorWallet);
  const block = spyOn(ctx.chain.client, "getBlock").mockResolvedValue({ timestamp: BigInt(deployWeek * WEEK_MS / 1000) } as never);
  const rpc = spyOn(ctx.chain.client, "readContract").mockImplementation(async (call) => {
    const week = (call.args as readonly [bigint])[0];
    return (call.functionName === "rootOf" ? onChain.get(week) ?? `0x${"0".repeat(64)}`
      : week === BigInt(deployWeek) ? tipOnlyFunding : 0n) as never;
  });
  const postRoot = spyOn(ctx.chain, "postCreatorRoot").mockImplementation(async (_address, week, root) => {
    onChain.set(week, root);
    return result;
  });
  try {
    await creatorPayoutTick(ctx, now);
    expect(postRoot).not.toHaveBeenCalled();
    const [pending] = await ctx.db.select().from(payoutRoots).where(eq(payoutRoots.week, weekDate(deployWeek)));
    expect(pending).toMatchObject({ root: EMPTY_ROOT, total: "0", tx: null });
    tipOnlyFunding = 0n;
    await creatorPayoutTick(ctx, now);
    expect(postRoot).toHaveBeenCalledTimes(1);
    expect(postRoot.mock.calls[0]).toEqual([contract, BigInt(deployWeek), EMPTY_ROOT, 0n]);
    const [posted] = await ctx.db.select().from(payoutRoots).where(eq(payoutRoots.week, weekDate(deployWeek)));
    expect(posted?.tx).toBe(result);
  } finally {
    postRoot.mockRestore();
    rpc.mockRestore();
    block.mockRestore();
    hasSigner.mockRestore();
    Object.assign(ctx.cfg.creators, saved);
  }
});

test("Discover uses on-chain boosts for order only and Votes reads the current contract epoch", async () => {
  const boosts = newWallet().address;
  const votes = newWallet().address;
  const boostedWallet = newWallet().address.toLowerCase() as Hex;
  const router = await createApp({ env: { ...env, ANONYMO_CREATOR_BOOSTS: boosts, ANONYMO_CREATOR_VOTES: votes, ANONYMO_CREATOR_CONTRACT_START_BLOCK: "2" }, startJobs: false });
  const option = stringToHex("Stock voice", { size: 32 });
  const epoch = 3000n;
  const read = spyOn(router.ctx.chain.client, "readContract").mockImplementation(async (call) => {
    if (call.functionName === "currentEpoch") return epoch as never;
    if (call.functionName === "tally") return 1000n as never;
    const args = call.args as readonly [Hex];
    return (args[0].endsWith(boostedWallet.slice(2)) ? 7n : 0n) as never;
  });
  const logs = spyOn(router.ctx.chain.client, "getLogs").mockImplementation(async () => [{ args: { ballot: 0, option } }] as never);
  try {
    await router.ctx.db.insert(creatorCharacters).values([
      { ...profile, name: "Base card", adult: false, creatorWallet, shareBps: 1500, cardHash: sha256("base"), floorVerdict: { allowed: true }, publishedAt: new Date(Date.now()) },
      { ...profile, name: "Boosted card", adult: false, creatorWallet: boostedWallet, shareBps: 1000, cardHash: sha256("boosted"), floorVerdict: { allowed: true }, publishedAt: new Date(Date.now() - DAY_MS) },
      { ...profile, name: "Hidden card", adult: true, creatorWallet: boostedWallet, shareBps: 1000, cardHash: sha256("hidden"), floorVerdict: { allowed: true }, publishedAt: new Date(Date.now() - DAY_MS) },
    ]);
    const listings = await router.app.request(`${api}/discover`);
    expect((await listings.json() as { data: { name: string; shareBps: number }[] }).data.map(({ name, shareBps }) => [name, shareBps]))
      .toEqual([["Boosted card", 1000], ["Base card", 1500]]);
    expect(await router.ctx.db.select().from(creatorAccruals)).toEqual([]);
    const ballot = await router.app.request(`${api}/votes`);
    expect(await ballot.json()).toMatchObject({ epoch: Number(epoch), options: [{ ballot: 0, option, label: "Stock voice", tally: "1000" }] });
  } finally {
    read.mockRestore();
    logs.mockRestore();
    await router.close();
  }
}, 20_000);

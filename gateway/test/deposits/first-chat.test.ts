import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { kv, keys, ledger } from "../../src/db/schema.ts";
import { FIRST_CHAT_DAILY_LIMIT, finishFirstChat, firstChatAvailable, freshStartSlot, issueFirstChat, reserveFirstChat, startFirstChat } from "../../src/anonymo/keys/first-chat.ts";
import { moneyHarness, type MoneyHarness } from "./harness.ts";

let m: MoneyHarness;
beforeAll(async () => { m = await moneyHarness(); });
afterAll(async () => { await m?.close(); });
const signup = (id: string, origin?: string) => m.req("/keys", {
  json: { dashboard_signup: id }, ...(origin ? { headers: { origin } } : {}),
});
const db = () => m.h.ctx.db;
async function eligible() {
  const key = await m.newKey();
  const [row] = await db().select({ id: keys.accountId }).from(keys).where(eq(keys.keyHash, key.keyHash));
  expect(await issueFirstChat(db(), row.id, randomUUID())).toBe(true);
  return { ...key, id: row.id };
}

test("each dashboard root gets one independent first chat even when both are created by the same browser", async () => {
  const id = randomUUID();
  for (const origin of [undefined, "https://other.example"]) {
    const res = await signup(id, origin);
    expect(res.status).toBe(201);
    expect((await res.json()).first_chat_available).toBe(false);
  }
  const responses = await Promise.all([signup(id, "https://anonymo.tech"), signup(id.toUpperCase(), "https://anonymo.tech")]);
  expect(responses.map(r => r.status)).toEqual([201, 201]);
  const minted = await Promise.all(responses.map(r => r.json()));
  expect(minted.filter(k => k.first_chat_available)).toHaveLength(2);
  expect(minted[0].key_hash).not.toBe(minted[1].key_hash);
  for (const k of minted) {
    const headers = { authorization: `Bearer ${k.key}` };
    expect((await (await m.req("/keys/me", { headers })).json()).first_chat_available).toBe(k.first_chat_available);
    expect((await (await m.req("/balance", { headers })).json()).available_usd).toBe(0);
    const [row] = await db().select({ id: keys.accountId }).from(keys).where(eq(keys.keyHash, k.key_hash));
    const claim = await reserveFirstChat(db(), row.id);
    expect(claim).not.toBeNull();
    expect(await startFirstChat(db(), row.id, claim!)).toBe(true);
    await finishFirstChat(db(), row.id, claim!, "completed");
    expect((await (await m.req("/keys/me", { headers })).json()).first_chat_available).toBe(false);
  }
  const rows = await db().select().from(kv).where(like(kv.key, "first-chat:%"));
  expect(JSON.stringify(rows).toLowerCase()).not.toContain(id.toLowerCase());
  expect(JSON.stringify(rows)).not.toContain(minted[0].key);
  expect((await signup("not-a-uuid", "https://anonymo.tech")).status).toBe(400);
});

test("dashboard signup uses the existing per-address new-key policy and keeps ordinary issuance separate", async () => {
  const limit = m.h.ctx.cfg.limits.newKeysPerHour;
  const take = m.h.ctx.limiter.take.bind(m.h.ctx.limiter);
  const buckets: string[] = [];
  m.h.ctx.limiter.take = async (key, count, cap, windowMs) => {
    if (!key.startsWith("dashboard-signup:")) return take(key, count, cap, windowMs);
    buckets.push(key);
    expect([count, cap, windowMs]).toEqual([1, limit, 3_600_000]);
    return { ok: false, retryAfterMs: 1_000, remaining: 0 };
  };
  try {
    const id = randomUUID();
    expect((await signup(id, "https://anonymo.tech")).status).toBe(429);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatch(/^dashboard-signup:[a-f0-9]{64}$/);
    expect((await m.req("/keys", { json: {} })).status).toBe(201);
    expect((await signup(id, "https://other.example")).status).toBe(201);
    expect(buckets).toHaveLength(1);
  } finally {
    m.h.ctx.limiter.take = take;
  }
});

test("concurrent claims yield one dispatch; completion and partial-stream failures cannot be replayed", async () => {
  for (const outcome of ["completed", "failed"] as const) {
    const { id } = await eligible();
    expect(await issueFirstChat(db(), id, randomUUID())).toBe(false);
    const claims = await Promise.all(Array.from({ length: 5 }, () => reserveFirstChat(db(), id)));
    const winner = claims.find(x => x !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await startFirstChat(db(), id, randomUUID())).toBe(false);
    const starts = await Promise.all([startFirstChat(db(), id, winner), startFirstChat(db(), id, winner)]);
    expect(starts.filter(Boolean)).toHaveLength(1);
    // A worker can disappear after dispatch without running finish.
    await db().update(kv).set({ updatedAt: sql`now() - interval '1 day'` }).where(eq(kv.key, freshStartSlot(id)));
    expect(await reserveFirstChat(db(), id)).toBeNull();
    await finishFirstChat(db(), id, winner, outcome);
    await finishFirstChat(db(), id, winner, "failed");
    expect(await firstChatAvailable(db(), id)).toBe(false);
    expect(await db().select().from(ledger).where(eq(ledger.accountId, id))).toHaveLength(0);
  }
});

test("abandoned pre-send leases expire; old workers cannot act on a replacement; failed preflight retries are bounded", async () => {
  const { id } = await eligible();
  const first = (await reserveFirstChat(db(), id))!;
  await db().update(kv).set({ updatedAt: sql`now() - interval '3 minutes'` }).where(eq(kv.key, freshStartSlot(id)));
  expect(await startFirstChat(db(), id, first)).toBe(false);
  const second = (await reserveFirstChat(db(), id))!;
  expect(second).not.toBe(first);
  await finishFirstChat(db(), id, first, "failed");
  expect(await reserveFirstChat(db(), id)).toBeNull();
  await finishFirstChat(db(), id, second, "failed");
  const third = (await reserveFirstChat(db(), id))!;
  expect(third).toBeString();
  await finishFirstChat(db(), id, third, "failed");
  expect(await reserveFirstChat(db(), id)).toBeNull();
});

test("a deposit after reservation preserves the sponsored message and the shared UTC-day cap still applies", async () => {
  const funded = await eligible();
  const claim = (await reserveFirstChat(db(), funded.id))!;
  await m.deposit(funded.keyHash, "1", "0xabababababababababababababababababababab");
  expect(await startFirstChat(db(), funded.id, claim)).toBe(true);
  await finishFirstChat(db(), funded.id, claim, "completed");
  expect((await (await m.req("/balance", { headers: funded.auth })).json()).available_usd).toBe(1);
  expect(await reserveFirstChat(db(), funded.id)).toBeNull();

  const a = await eligible();
  const b = await eligible();
  const ids = [a.id, b.id];
  const claims = await Promise.all(ids.map(id => reserveFirstChat(db(), id)));
  const day = "first-chat:daily:" + new Date().toISOString().slice(0, 10);
  await db().insert(kv).values({ key: day, value: FIRST_CHAT_DAILY_LIMIT - 1 }).onConflictDoUpdate({ target: kv.key, set: { value: FIRST_CHAT_DAILY_LIMIT - 1 } });
  const starts = await Promise.all(ids.map((id, index) => startFirstChat(db(), id, claims[index]!)));
  expect(starts.filter(Boolean)).toHaveLength(1);
  expect((await db().select().from(kv).where(eq(kv.key, day)))[0].value).toBe(FIRST_CHAT_DAILY_LIMIT);
  await db().delete(kv).where(eq(kv.key, day));
});

const claimEndpoint = "/keys/first-chat/claim";
const campaign = (auth: Record<string, string>, id: string) => m.req(claimEndpoint, {
  headers: { ...auth, origin: "https://anonymo.tech" }, json: { dashboard_signup: id },
});
async function accountId(keyHash: string) {
  const [k] = await db().select({ id: keys.accountId }).from(keys).where(eq(keys.keyHash, keyHash));
  return k.id;
}

test("a funded returning dashboard root refreshes a spent legacy entitlement exactly once across concurrent sessions", async () => {
  const root = await m.newKey();
  const id = await accountId(root.keyHash);
  const signupId = randomUUID();
  await db().insert(kv).values({ key: `first-chat:account:${id}`, value: { state: "completed" } });
  await m.deposit(root.keyHash, "1", "0xabababababababababababababababababababab");
  const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => campaign(root.auth, i % 2 ? signupId : randomUUID())));
  for (const res of claims) {
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ first_chat_available: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  const attempts = await Promise.all(Array.from({ length: 4 }, () => reserveFirstChat(db(), id)));
  const winners = attempts.filter((value): value is string => value !== null);
  expect(winners).toHaveLength(1);
  expect(await startFirstChat(db(), id, winners[0])).toBe(true);
  await finishFirstChat(db(), id, winners[0], "completed");
  expect(await (await campaign(root.auth, randomUUID())).json()).toEqual({ first_chat_available: false });
  expect((await (await m.req("/keys/me", { headers: root.auth })).json()).first_chat_available).toBe(false);
  expect((await (await m.req("/balance", { headers: root.auth })).json()).available_usd).toBe(1);
});

test("an in-flight legacy lease can finish without consuming or releasing the new campaign reservation", async () => {
  const root = await m.newKey();
  const id = await accountId(root.keyHash);
  const legacy = randomUUID();
  await db().insert(kv).values({ key: `first-chat:account:${id}`, value: { state: "reserved", attempts: 1, claim: legacy } });
  expect(await (await campaign(root.auth, randomUUID())).json()).toEqual({ first_chat_available: false });
  expect(await reserveFirstChat(db(), id)).toBeNull();
  expect(await startFirstChat(db(), id, legacy)).toBe(true);
  const fresh = await reserveFirstChat(db(), id);
  expect(fresh).not.toBeNull();
  await finishFirstChat(db(), id, legacy, "failed");
  expect(await reserveFirstChat(db(), id)).toBeNull();
  expect(await startFirstChat(db(), id, fresh!)).toBe(true);
  await finishFirstChat(db(), id, fresh!, "completed");
  expect(await reserveFirstChat(db(), id)).toBeNull();
});

test("campaign recovery requires a valid root credential, allowed dashboard origin and valid signup marker", async () => {
  const root = await m.newKey();
  const id = randomUUID();
  for (const origin of ["", "https://outside.example"]) {
    expect((await m.req(claimEndpoint, { headers: { ...root.auth, origin }, json: { dashboard_signup: id } })).status).toBe(403);
  }
  expect((await campaign({}, id)).status).toBe(401);
  expect((await campaign(root.auth, "invalid")).status).toBe(400);
  await db().update(keys).set({ management: false }).where(eq(keys.keyHash, root.keyHash));
  expect((await campaign(root.auth, id)).status).toBe(403);
  expect(await firstChatAvailable(db(), await accountId(root.keyHash))).toBe(false);
});

test("confirmed empty campaign replies can retry twice without refunding any system dispatches", async () => {
  const { id } = await eligible();
  const day = "first-chat:daily:" + new Date().toISOString().slice(0, 10);
  const daily = async () => Number((await db().select().from(kv).where(eq(kv.key, day)))[0]?.value ?? 0);
  const before = await daily();
  let previous = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = (await reserveFirstChat(db(), id))!;
    expect(claim).toBeString();
    await finishFirstChat(db(), id, claim, "empty"); // still reserved
    expect(await startFirstChat(db(), id, claim)).toBe(true);
    if (previous) {
      await finishFirstChat(db(), id, previous, "empty");
      expect(await reserveFirstChat(db(), id)).toBeNull();
    }
    await Promise.all([finishFirstChat(db(), id, claim, "empty"), finishFirstChat(db(), id, claim, "empty")]);
    expect(await firstChatAvailable(db(), id)).toBe(attempt < 3);
    expect(await daily()).toBe(before + attempt);
    previous = claim;
  }
  expect(await reserveFirstChat(db(), id)).toBeNull();
  expect(await db().select().from(ledger).where(eq(ledger.accountId, id))).toHaveLength(0);
});

test("empty responses cannot reopen expired, legacy or already failed dispatches", async () => {
  for (const scenario of ["stale", "legacy", "failed", "unknown-attempts"] as const) {
    const root = await m.newKey();
    const id = await accountId(root.keyHash);
    if (scenario === "legacy")
      await db().insert(kv).values({ key: `first-chat:account:${id}`, value: { state: "available", attempts: 0 } });
    else await issueFirstChat(db(), id, randomUUID());
    const claim = (await reserveFirstChat(db(), id))!;
    expect(await startFirstChat(db(), id, claim)).toBe(true);
    if (scenario === "stale")
      await db().update(kv).set({ updatedAt: sql`now() - interval '3 minutes'` }).where(eq(kv.key, freshStartSlot(id)));
    if (scenario === "unknown-attempts")
      await db().update(kv).set({ value: { state: "started", claim } }).where(eq(kv.key, freshStartSlot(id)));
    if (scenario === "failed") await finishFirstChat(db(), id, claim, "failed");
    await finishFirstChat(db(), id, claim, "empty");
    expect(await reserveFirstChat(db(), id)).toBeNull();
  }
});

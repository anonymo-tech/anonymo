import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { kv, keys, ledger } from "../../src/db/schema.ts";
import { FIRST_CHAT_DAILY_LIMIT, finishFirstChat, firstChatAvailable, issueFirstChat, reserveFirstChat, startFirstChat } from "../../src/anonymo/keys/first-chat.ts";
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

test("only explicit dashboard signup can mint a first chat; duplicate UUIDs do not grant another key a trial", async () => {
  const id = randomUUID();
  for (const origin of [undefined, "https://other.example"]) {
    const res = await signup(id, origin);
    expect(res.status).toBe(201);
    expect((await res.json()).first_chat_available).toBe(false);
  }
  const responses = await Promise.all([signup(id, "https://anonymo.tech"), signup(id.toUpperCase(), "https://anonymo.tech")]);
  expect(responses.map(r => r.status)).toEqual([201, 201]);
  const minted = await Promise.all(responses.map(r => r.json()));
  expect(minted.filter(k => k.first_chat_available)).toHaveLength(1);
  for (const k of minted) {
    const headers = { authorization: `Bearer ${k.key}` };
    expect((await (await m.req("/keys/me", { headers })).json()).first_chat_available).toBe(k.first_chat_available);
    expect((await (await m.req("/balance", { headers })).json()).available_usd).toBe(0);
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
    await db().update(kv).set({ updatedAt: sql`now() - interval '1 day'` }).where(eq(kv.key, `first-chat:account:${id}`));
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
  await db().update(kv).set({ updatedAt: sql`now() - interval '3 minutes'` }).where(eq(kv.key, `first-chat:account:${id}`));
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

test("deposited funds and the shared UTC-day cap take precedence, including races at the dispatch boundary", async () => {
  const funded = await eligible();
  const claim = (await reserveFirstChat(db(), funded.id))!;
  await m.deposit(funded.keyHash, "1", "0xabababababababababababababababababababab");
  expect(await startFirstChat(db(), funded.id, claim)).toBe(false);
  await finishFirstChat(db(), funded.id, claim, "failed");
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

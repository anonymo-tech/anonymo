import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { accounts, keys, kv } from "../../src/db/schema.ts";
import { finishFirstChat, firstChatAvailable, issueFirstChat, poolAccountKey, poolDayKey, reserveFirstChat, startFirstChat, type FreePool } from "../../src/anonymo/keys/first-chat.ts";
import { usdToPico } from "../../src/lib/money.ts";
import { moneyHarness, type MoneyHarness } from "./harness.ts";

let m: MoneyHarness;
beforeAll(async () => { m = await moneyHarness(); });
afterAll(async () => { await m?.close(); });
const db = () => m.h.ctx.db;
const day = () => new Date().toISOString().slice(0, 10);
const spent = async (key: string) => {
  const [row] = await db().select({ value: kv.value }).from(kv).where(eq(kv.key, key));
  return BigInt((row?.value as { pico?: string } | undefined)?.pico ?? "0");
};
async function enrolled() {
  const key = await m.newKey();
  const [row] = await db().select({ id: keys.accountId }).from(keys).where(eq(keys.keyHash, key.keyHash));
  expect(await issueFirstChat(db(), row.id, randomUUID())).toBe(true);
  return row.id;
}
async function resetPool() {
  await db().delete(kv).where(like(kv.key, "free-pool:%"));
}

test("a key chats free many times, each request settling to what it cost, until its own daily cap", async () => {
  await resetPool();
  const pool: FreePool = { dailyUsd: 100, perKeyUsd: 0.1, requestUsd: 0.04 };
  const id = await enrolled();
  expect(await firstChatAvailable(db(), id, pool)).toBe(true);
  // Cheap replies: far more than the cap divided by the ceiling.
  for (let i = 0; i < 20; i++) {
    const claim = await reserveFirstChat(db(), id, pool);
    expect(claim).not.toBeNull();
    expect(await startFirstChat(db(), id, claim!)).toBe(true);
    await finishFirstChat(db(), id, claim!, "completed", usdToPico("0.001"));
  }
  expect(await spent(poolAccountKey(id, day()))).toBe(usdToPico("0.02"));
  expect(await spent(poolDayKey(day()))).toBe(usdToPico("0.02"));
  // A reservation is the full ceiling, so the cap stops new requests before it could be passed.
  const held: string[] = [];
  for (;;) {
    const claim = await reserveFirstChat(db(), id, pool);
    if (!claim) break;
    held.push(claim);
  }
  expect(held).toHaveLength(2); // 0.02 spent + 2 × 0.04 held ≤ 0.1
  expect(await firstChatAvailable(db(), id, pool)).toBe(false);
  // Settling a claim twice changes nothing; a claim that never reached a model gives everything back.
  await finishFirstChat(db(), id, held[0], "failed");
  await finishFirstChat(db(), id, held[0], "failed", usdToPico("0.04"));
  await finishFirstChat(db(), id, held[1], "completed", usdToPico("0.003"));
  expect(await spent(poolAccountKey(id, day()))).toBe(usdToPico("0.023"));
  expect(await firstChatAvailable(db(), id, pool)).toBe(true);
});

test("the shared daily amount stops every key, and a cancelled reply still counts what it used", async () => {
  await resetPool();
  const pool: FreePool = { dailyUsd: 0.1, perKeyUsd: 0.1, requestUsd: 0.04 };
  const [a, b] = [await enrolled(), await enrolled()];
  const first = await reserveFirstChat(db(), a, pool);
  await finishFirstChat(db(), a, first!, "failed", usdToPico("0.05")); // cancelled mid-stream after using tokens
  expect(await spent(poolDayKey(day()))).toBe(usdToPico("0.05"));
  expect(await reserveFirstChat(db(), b, pool)).not.toBeNull(); // 0.05 + 0.04 ≤ 0.1
  expect(await reserveFirstChat(db(), b, pool)).toBeNull();
  expect(await firstChatAvailable(db(), a, pool)).toBe(false);
});

test("only dashboard keys with no balance use the pool, and its rows hold no conversation or key", async () => {
  await resetPool();
  const pool: FreePool = { dailyUsd: 100, perKeyUsd: 1, requestUsd: 0.04 };
  const plain = await m.newKey();
  const [row] = await db().select({ id: keys.accountId }).from(keys).where(eq(keys.keyHash, plain.keyHash));
  expect(await reserveFirstChat(db(), row.id, pool)).toBeNull(); // never went through a dashboard signup

  const funded = await enrolled();
  await db().update(accounts).set({ balance: usdToPico("5") }).where(eq(accounts.id, funded));
  expect(await firstChatAvailable(db(), funded, pool)).toBe(false);
  expect(await reserveFirstChat(db(), funded, pool)).toBeNull();

  const ok = await enrolled();
  expect(await reserveFirstChat(db(), ok, pool)).not.toBeNull();
  const rows = await db().select().from(kv).where(like(kv.key, "free-pool:%"));
  expect(rows.length).toBe(3); // the day total, this key's total for the day, and the open reservation
  expect(JSON.stringify(rows)).not.toContain(plain.secret);
  expect(JSON.stringify(rows)).not.toContain(plain.keyHash);
});

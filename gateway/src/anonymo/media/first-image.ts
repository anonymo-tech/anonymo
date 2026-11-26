// One successful dashboard generation per root account. Count every provider dispatch against the
// UTC budget, including failed or blocked outputs. No prompt, output or caller address enters KV.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { fail } from "../../lib/errors.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";

export const MAX_FIRST_IMAGE_PRICE = usdToPico("0.10");
export const FIRST_IMAGE_DAILY_BUDGET = usdToPico("10");
const accountSlot = (accountId: string) => `first-image:v1:account:${accountId}`;
const dailySlot = sql<string>`'first-image:v1:daily:' || to_char(timezone('UTC', now()), 'YYYY-MM-DD')`;
// A process that never returns a result cannot lock the user out permanently. A replaced
// reservation must still own its exact request ID before it can return a successful response.
const expired = sql`${kv.value}->>'state' = 'generating' AND ${kv.updatedAt} < now() - interval '10 minutes'`;
const unavailable = () => fail(409, "The free generation is unavailable. Nothing was charged.", "first_image_unavailable");

export async function firstImageOffer(db: Db, accountId?: string) {
  const [counter] = await db.select({ spent: kv.value }).from(kv).where(eq(kv.key, dailySlot));
  const remaining = FIRST_IMAGE_DAILY_BUDGET - BigInt(String(counter?.spent ?? 0));
  if (!accountId) return { available: true, remaining };
  const [claim] = await db.select({ expired: sql<boolean>`(${expired})` }).from(kv).where(eq(kv.key, accountSlot(accountId)));
  return { available: !claim || claim.expired === true, remaining };
}

export async function startFirstImage(db: Db, accountId: string, id: string, price: Pico) {
  if (price <= 0n || price > MAX_FIRST_IMAGE_PRICE) unavailable();
  await db.transaction(async tx => {
    const value = { state: "generating", id };
    const claims = await tx.insert(kv).values({ key: accountSlot(accountId), value })
      .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: sql`now()` }, setWhere: expired })
      .returning({ key: kv.key });
    if (!claims.length) unavailable();
    const total = sql`(${kv.value} #>> '{}')::bigint + ${price.toString()}::bigint`;
    const spent = await tx.insert(kv).values({ key: dailySlot, value: Number(price) })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`to_jsonb(${total})`, updatedAt: sql`now()` },
        setWhere: sql`${total} <= ${FIRST_IMAGE_DAILY_BUDGET.toString()}::bigint` }).returning({ key: kv.key });
    if (!spent.length) unavailable(); // Transaction rolls the account reservation back, too.
  });
}

export async function finishFirstImage(db: Db, accountId: string, id: string, delivered: boolean) {
  const owner = and(eq(kv.key, accountSlot(accountId)), sql`${kv.value}->>'state' = 'generating' AND ${kv.value}->>'id' = ${id}`);
  if (!delivered) {
    await db.delete(kv).where(owner);
    return;
  }
  const done = await db.update(kv).set({ value: { state: "used" }, updatedAt: sql`now()` }).where(owner).returning({ key: kv.key });
  if (!done.length) unavailable();
}

import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { issueFirstChat, poolAccountKey, poolDayKey, type FreePool } from "../src/anonymo/keys/first-chat.ts";
import { accounts, keys, kv } from "../src/db/schema.ts";
import { usdToPico } from "../src/lib/money.ts";

let h: Harness;
const sent: Record<string, unknown>[] = [];
const model = { id: "test-chat", slug: "anonymo-1", prompt: "0.0000003", completion: "0.000001", ctx: 131072 };
beforeAll(async () => {
  h = await startRouter({ providers: [{
    id: "pool-route", name: "Pool route", models: [model], reply: (_prompt, body) => {
      sent.push(body);
      return "A free reply from the mock provider.";
    },
  }] });
});
afterAll(async () => h?.close());

const setPool = (pool: FreePool | null) => { (h.ctx.cfg as { freePool: FreePool | null }).freePool = pool; };
const day = () => new Date().toISOString().slice(0, 10);
const spent = async (key: string) => {
  const [row] = await h.ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));
  return BigInt((row?.value as { pico?: string } | undefined)?.pico ?? "0");
};

async function dashboardKey() {
  const key = await h.newKey();
  const [record] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  expect(await issueFirstChat(h.ctx.db, record.accountId, randomUUID())).toBe(true);
  return { ...key, accountId: record.accountId };
}

const chat = (auth: Record<string, string>, messages: { role: string; content: string }[]) =>
  h.request("/v1/chat/completions/sponsored", { method: "POST", headers: auth, json: { model: "anonymo-1", messages, dashboard_chat: "sponsored" } });

test("with the pool on, a key with no balance keeps chatting free, each reply settled to its real cost", async () => {
  await h.ctx.db.delete(kv).where(like(kv.key, "free-pool:%"));
  setPool({ dailyUsd: 50, perKeyUsd: 0.25, requestUsd: 0.04 });
  try {
    const key = await dashboardKey();
    const history: { role: string; content: string }[] = [{ role: "system", content: "You are a ship's cook." }];
    for (let i = 0; i < 4; i++) {
      history.push({ role: "user", content: `Question ${i}: what's for dinner?` });
      const res = await chat(key.auth, history);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usage.cost).toBe(0);
      history.push({ role: "assistant", content: body.choices[0].message.content });
      expect(sent.at(-1)).toMatchObject({ max_tokens: 1_500 });
    }
    const used = await spent(poolAccountKey(key.accountId, day()));
    expect(used).toBeGreaterThan(0n);
    expect(used).toBeLessThan(usdToPico("0.04")); // four settled replies cost far less than one reservation
    expect(await spent(poolDayKey(day()))).toBe(used);
    expect((await h.ctx.db.select().from(kv).where(like(kv.key, "free-pool:claim:%"))).length).toBe(0);
    const [account] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, key.accountId));
    expect([account.balance, account.held]).toEqual([0n, 0n]);

    const me = await (await h.request("/keys/me", { headers: key.auth })).json();
    expect(me).toMatchObject({ first_chat_available: true, free_pool: true });

    // Once the day's shared amount cannot cover another request, nothing more is sent and nothing is charged.
    setPool({ dailyUsd: Number(used) / 1e12 + 0.01, perKeyUsd: 0.25, requestUsd: 0.04 });
    const count = sent.length;
    const refused = await chat(key.auth, [{ role: "user", content: "One more?" }]);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(sent).toHaveLength(count);
    expect(await (await h.request("/keys/me", { headers: key.auth })).json()).toMatchObject({ first_chat_available: false });
  } finally {
    setPool(null);
  }
});

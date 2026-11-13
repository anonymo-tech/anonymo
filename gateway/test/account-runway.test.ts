import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { accounts, keys, kv, ledger } from "../src/db/schema.ts";
import { runwayMath } from "../src/account/runway.ts";
const USD = 1_000_000_000_000n;
let off: Harness, h: Harness;
beforeAll(async () => {
  off = await startRouter();
  h = await startRouter();
});
afterAll(async () => { await off?.close(); await h?.close(); });
async function keyRow(router: Harness, hash: string) { return (await router.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0]; }
let seq = 0;
async function line(account: string, amount: bigint, kind = "usage", keyHash?: string, createdAt = new Date()) {
  const id = `runway-line-${++seq}`;
  await h.ctx.db.insert(ledger).values({ id, accountId: account, amount, kind, keyHash, ref: id, createdAt });
}
test('runway math floors days, handles zero, tiny spend and fractional pace without integer rounding', () => {
  expect(runwayMath(12n * USD, 7n * USD)).toEqual({ balance_usd: 12, spend_7d_usd: 7, per_day_usd: 1, days_left: 12 });
  expect(runwayMath(USD / 2n, 7n * USD).days_left).toBe(0);
  expect(runwayMath(USD, 0n).days_left).toBeNull();
  expect(runwayMath(1n, 1n).days_left).toBe(7);
  expect(runwayMath(10n, 8n).days_left).toBe(8);
  expect(runwayMath(-1n, 8n)).toEqual({ balance_usd: -1e-12, spend_7d_usd: 8e-12, per_day_usd: 8e-12 / 7, days_left: -1 });
});
test('runway follows credits auth and posted seven-day charged spending with no flag', async () => {
  const owner = await h.newKey(), other = await h.newKey();
  const account = (await keyRow(h, owner.hash)).accountId;
  await line(account, 25n * USD, 'deposit');
  await line(account, -7n * USD, 'usage', owner.hash);
  await line(account, -USD, 'tool_call', owner.hash);
  await line(account, -USD, 'data_tool', owner.hash);
  await line(account, USD, 'refund', owner.hash);
  await line(account, -USD, 'withdrawal', owner.hash);
  await line(account, -USD, 'usage', owner.hash, new Date(Date.now() - 8 * 86_400_000));
  await line(account, -USD, 'usage', owner.hash, new Date(Date.now() + 86_400_000));
  const response = await h.request('/api/v1/account/runway', { headers: owner.auth });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ balance_usd: 14, spend_7d_usd: 9, per_day_usd: 9 / 7, days_left: 10 });
  const childResponse = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json();
  const childAuth = { authorization: 'Bearer ' + childResponse.key };
  expect(await (await h.request('/api/v1/account/runway', { headers: childAuth })).json()).toEqual(await (await h.request('/api/v1/account/runway', { headers: owner.auth })).json());
  expect((await (await h.request('/api/v1/account/runway', { headers: other.auth })).json()).days_left).toBeNull();
  const own = await off.newKey(); expect((await off.request('/api/v1/account/runway', { headers: own.auth })).status).toBe(200);
  for (const headers of [{}, { authorization: 'Bearer invalid' }]) expect((await h.request('/api/v1/account/runway', { headers })).status).toBe(401);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, other.hash));
  expect((await h.request('/api/v1/account/runway', { headers: other.auth })).status).toBe(401);
});
test('sessions get only their budget and spend, and inference-only keys remain refused', async () => {
  const owner = await h.newKey(), account = (await keyRow(h, owner.hash)).accountId;
  await line(account, 100n * USD, 'deposit'); await line(account, -7n * USD, 'usage', owner.hash);
  const session = await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 4 } })).json();
  const hash = session.data.key_hash, headers = { authorization: 'Bearer ' + session.data.key };
  await line(account, -USD, 'usage', hash); await h.ctx.db.update(keys).set({ spentTotal: USD }).where(eq(keys.keyHash, hash));
  expect(await (await h.request('/api/v1/account/runway', { headers })).json()).toEqual({ balance_usd: 3, spend_7d_usd: 1, per_day_usd: 1 / 7, days_left: 21 });
  expect((await h.request('/api/v1/account/low-balance', { headers })).status).toBe(404); // the balance-alert setting went with Telegram and the inbox
  await h.ctx.db.update(keys).set({ scope: 'inference' }).where(eq(keys.keyHash, hash));
  expect((await h.request('/api/v1/account/runway', { headers })).status).toBe(403);
});

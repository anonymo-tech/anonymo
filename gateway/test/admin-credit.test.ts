import { afterAll, beforeAll, expect, test } from "bun:test";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => { h = await startRouter(); });
afterAll(async () => { await h.close(); });

const credit = (headers: Record<string, string>, body: unknown) =>
  h.request("/trpc/creditKey", { method: "POST", headers, json: body });
const balance = async (auth: Record<string, string>) => ((await (await h.request("/balance", { headers: auth })).json()) as { balance_usd: number }).balance_usd;

test("operator test credit: admin only, capped, once per ref, and it shows on the key's balance", async () => {
  const k = await h.newKey();
  expect((await credit({ authorization: `Bearer ${k.secret}` }, { key_hash: k.hash, usd: 3, ref: "test-1" })).status).toBe(401);
  expect((await credit({ "x-admin-token": ADMIN }, { key_hash: k.hash, usd: 26, ref: "test-1" })).status).toBe(400);
  expect((await credit({ "x-admin-token": ADMIN }, { key_hash: "0".repeat(64), usd: 3, ref: "test-1" })).status).toBe(404);
  const ok = await credit({ "x-admin-token": ADMIN }, { key_hash: k.hash, usd: 3, ref: "test-1", note: "live check" });
  expect(ok.status).toBe(200);
  const again = await credit({ "x-admin-token": ADMIN }, { key_hash: k.hash, usd: 3, ref: "test-1" });
  expect(((await again.json()) as { result: { data: { credited: boolean } } }).result.data.credited).toBe(false);
  expect(await balance(k.auth)).toBe(3);
});

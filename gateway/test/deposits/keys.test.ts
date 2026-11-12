// WS05 keys: anm_live_ keys shown once and stored as sha256 only, SIWE wallet-minted keys, per-key caps (mirrored onto the
// Anonymo key limits) and the key-policy middleware. Also the M1 money half: a key funded through DepositSink chats.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { keys, kv } from "../../src/db/schema.ts";
import { anonymoKeys } from "../../src/anonymo/deposits/schema.ts";
import { keyPolicyMiddleware } from "../../src/anonymo/keys/caps.ts";
import { ApiError } from "../../src/lib/errors.ts";
import { sha256 } from "../../src/lib/util.ts";
import { usdToPico } from "../../src/lib/money.ts";
import { post } from "../../src/ledger/ledger.ts";
import { MODELS } from "../helpers.ts";
import { moneyHarness, type MoneyHarness } from "./harness.ts";

let m: MoneyHarness;
beforeAll(async () => {
  m = await moneyHarness({ env: { ANONYMO_EVM_CHAINS: JSON.stringify([{ chain: "base", rpcUrl: "http://127.0.0.1:9", router: "0x00000000000000000000000000000000000000d1", tokens: [{ symbol: "USDC", address: "0x00000000000000000000000000000000000000c1", decimals: 6 }] }]) } });
});
afterAll(async () => m?.close());

describe("POST /keys", () => {
  test("returns anm_live_ once, stores only its sha256, and hands out deposit instructions", async () => {
    const k = await m.newKey();
    expect(k.secret).toMatch(/^anm_live_[0-9a-f]{64}$/);
    expect(k.keyHash).toBe(sha256(k.secret));
    expect(k.deposit.evm.key_commit).toMatch(/^0x[0-9a-f]{64}$/);
    expect(k.deposit.evm.chains[0].chain).toBe("base");
    // The secret appears nowhere in the database.
    const dump = await m.h.ctx.db.execute(sql`select row_to_json(k)::text as j from keys k union all select row_to_json(a)::text from anonymo_keys a union all select row_to_json(d)::text from anonymo_deposit_addresses d`);
    const rows = ((dump as { rows?: { j: string }[] }).rows ?? (dump as unknown as { j: string }[])).map((r) => r.j);
    expect(rows.some((r) => r.includes(k.secret.slice(9)))).toBe(false);
    // Shown once: /keys/me never returns it.
    const me = await (await m.req("/keys/me", { headers: k.auth })).json();
    expect(JSON.stringify(me)).not.toContain(k.secret);
    expect(me.key_hash).toBe(k.keyHash);
  });

  test("caps are stored and the shortest window is mirrored onto the Anonymo key budget", async () => {
    const k = await m.newKey({ daily_usd: "2", monthly_usd: 20, lifetime_usd: "100", models: ["anonymo-1"], ip_allow: ["10.0.0.0/8"], sealed_only: false, expires_at: "2099-01-01T00:00:00.000Z" });
    const [row] = await m.h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
    expect(row.budget).toBe(usdToPico("2"));
    expect(row.budgetReset).toBe("daily");
    expect(row.allowedModels).toEqual(["anonymo-1"]);
    expect(row.expiresAt?.toISOString()).toBe("2099-01-01T00:00:00.000Z");
    const [a] = await m.h.ctx.db.select().from(anonymoKeys).where(eq(anonymoKeys.keyHash, k.keyHash));
    expect(a.monthlyCap).toBe(usdToPico("20"));
    expect(a.ipAllow).toEqual(["10.0.0.0/8"]);
    // Clearing the daily cap moves the mirror to the monthly window.
    const r = await m.req("/keys/caps", { method: "PATCH", headers: { ...k.auth, "content-type": "application/json" }, body: JSON.stringify({ daily_usd: null }) });
    expect(r.status).toBe(200);
    const [after] = await m.h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
    expect(after.budget).toBe(usdToPico("20"));
    expect(after.budgetReset).toBe("monthly");
  });

  test("bad caps are a 400, and nothing personal is accepted", async () => {
    expect((await m.req("/keys", { json: { caps: { ip_allow: ["not-an-ip"] } } })).status).toBe(400);
    expect((await m.req("/keys", { json: { email: "sample-user@example.com" } })).status).toBe(400);
    expect((await m.req("/keys", { json: { caps: { daily_usd: -1 } } })).status).toBe(400);
  });

  test("an expired key is refused by the existing key check", async () => {
    const k = await m.newKey({ expires_at: "2000-01-01T00:00:00.000Z" });
    expect((await m.req("/balance", { headers: k.auth })).status).toBe(401);
  });
});

describe("SIWE wallet-minted keys", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const domain = () => new URL(m.h.ctx.cfg.publicUrl).host;
  const signed = async (o: { nonce: string; domain?: string; issuedAt?: Date }) => {
    const message = createSiweMessage({ address: account.address, chainId: 8453, domain: o.domain ?? domain(), nonce: o.nonce, uri: m.h.ctx.cfg.publicUrl, version: "1", issuedAt: o.issuedAt ?? new Date() });
    return { message, signature: await account.signMessage({ message }) };
  };
  const nonce = async () => (await (await m.req("/keys/siwe/nonce")).json()).nonce as string;

  test("mints a key bound to the signing wallet; the nonce works once", async () => {
    const n = await nonce();
    const body = await signed({ nonce: n });
    const r = await m.req("/keys/siwe", { json: body });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.key).toMatch(/^anm_live_/);
    expect(j.wallet).toBe(account.address.toLowerCase());
    const [a] = await m.h.ctx.db.select().from(anonymoKeys).where(eq(anonymoKeys.keyHash, j.key_hash));
    expect(a.wallet).toBe(account.address.toLowerCase());
    expect((await m.req("/keys/siwe", { json: body })).status).toBe(401); // replay
  });

  test("wrong domain, forged signature, stale message and unknown nonce are refused", async () => {
    expect((await m.req("/keys/siwe", { json: await signed({ nonce: await nonce(), domain: "evil.example" }) })).status).toBe(401);
    const n = await nonce();
    const good = await signed({ nonce: n });
    const other = privateKeyToAccount(generatePrivateKey());
    expect((await m.req("/keys/siwe", { json: { message: good.message, signature: await other.signMessage({ message: good.message }) } })).status).toBe(401);
    expect((await m.req("/keys/siwe", { json: await signed({ nonce: await nonce(), issuedAt: new Date(Date.now() - 3_600_000) }) })).status).toBe(401);
    expect((await m.req("/keys/siwe", { json: await signed({ nonce: "abcdefgh12345678" }) })).status).toBe(401);
    // The refused attempts did not burn the good nonce.
    expect((await m.req("/keys/siwe", { json: good })).status).toBe(201);
    const left = await m.h.ctx.db.select().from(kv).where(eq(kv.key, `anonymo:siwe:${n}`));
    expect(left.length).toBe(0);
  });
});

describe("key policy middleware", () => {
  const app = () => {
    const a = new Hono();
    a.onError((err, c) => (err instanceof ApiError ? c.json(err.toJSON(), err.status as never) : c.text(String(err), 500)));
    a.use("*", keyPolicyMiddleware(m.h.ctx));
    a.post("/v1/chat/completions", (c) => c.json({ ok: true }));
    a.post("/v1/other", (c) => c.json({ ok: true }));
    return a;
  };
  const call = (k: { auth: Record<string, string> }, body: unknown, headers: Record<string, string> = {}, path = "/v1/chat/completions") =>
    app().request(path, { method: "POST", headers: { ...k.auth, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("sealed_only lets only sealed calls through", async () => {
    const k = await m.newKey({ sealed_only: true });
    expect((await call(k, { model: "anonymo-1" })).status).toBe(403);
    expect((await call(k, { model: "anonymo-sealed" })).status).toBe(200);
    expect((await call(k, { model: "anonymo-1" }, { "x-anonymo-sealed": "required" })).status).toBe(200);
    expect((await call(k, { model: "anonymo-1" }, {}, "/v1/other")).status).toBe(200); // not an inference route
  });

  test("ip_allow compares the caller's address in memory", async () => {
    const k = await m.newKey({ ip_allow: ["203.0.113.0/24"] });
    const r = await call(k, { model: "anonymo-1" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.type).toBe("ip_not_allowed");
  });

  test("every spend window refuses once reached", async () => {
    const k = await m.newKey({ daily_usd: "100", monthly_usd: "100", lifetime_usd: "3" });
    const [row] = await m.h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
    expect((await call(k, { model: "anonymo-1" })).status).toBe(200);
    await m.deposit(k.keyHash, "10", "0x00000000000000000000000000000000000000a1");
    await post(m.h.ctx.db, { accountId: row.accountId, keyHash: k.keyHash, amount: -usdToPico("3"), kind: "usage", ref: `test-usage:${k.keyHash}` });
    const r = await call(k, { model: "anonymo-1" });
    expect(r.status).toBe(402);
    expect((await r.json()).error.message).toContain("lifetime");
  });

  test("keys without Anonymo caps are untouched", async () => {
    const legacy = await m.h.newKey();
    expect((await call({ auth: legacy.auth }, { model: "x" })).status).toBe(200);
  });
});

describe("deposited credit pays for chat (M1 money half)", () => {
  test("a key credited only through DepositSink chats on the full app and is billed", async () => {
    // The key is minted through the real mount (src/anonymo/routes.ts), not the test app.
    const r = await m.h.request("/keys", { method: "POST", json: {} });
    expect(r.status).toBe(201);
    const k = (await r.json()) as { key: string; key_hash: string };
    expect((await m.deposit(k.key_hash, "5", "0x00000000000000000000000000000000000000a2")).credited).toBe(true);
    const chat = await m.h.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${k.key}` }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }] } });
    expect(chat.status).toBe(200);
    const bal = await (await m.h.request("/balance", { headers: { authorization: `Bearer ${k.key}` } })).json();
    expect(bal.balance_usd).toBeLessThan(5);
    expect(bal.balance_usd).toBeGreaterThan(4.9);
  });
});

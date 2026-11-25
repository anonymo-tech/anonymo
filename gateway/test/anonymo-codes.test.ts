import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { CODE_ALPHABET, canonicalCode } from "../src/anonymo/codes/format.ts";
import { MAX_BATCH_COUNT, MAX_BATCH_USD, issueBatch, redeemCode } from "../src/anonymo/codes/store.ts";
import { anonymoKeys } from "../src/anonymo/deposits/schema.ts";
import { loadConfig } from "../src/config.ts";
import { codes, keys, ledger } from "../src/db/schema.ts";
import { balanceOf, post, reserve, settle } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";
import { MemoryRateLimiter } from "../src/lib/ratelimit.ts";
import { sha256 } from "../src/lib/util.ts";
import { startRouter, type Harness } from "./helpers.ts";

const resellerA = "1bfe7dbc-7ce9-42bd-a9f6-c66e4f57eb91";
const resellerB = "2c8e5e70-c91a-47c8-8983-72d4ed49ef32";
const tokenA = "fixture-reseller-token-one"; // gitleaks:allow
const tokenB = "fixture-reseller-token-two"; // gitleaks:allow
const resellerHashes = JSON.stringify({ [resellerA]: sha256(tokenA), [resellerB]: sha256(tokenB) });
const batchesPath = "/v1/codes/batches";
const redeemPath = "/v1/codes/redeem";
const authorization = (token: string) => ({ authorization: `Bearer ${token}` });
type Batch = { batch_id: string; face_usd: number; count: number; codes: string[] };

let h: Harness;
beforeAll(async () => {
  h = await startRouter({ providers: [], env: {
    ANONYMO_FEATURE_CODES: "true", ANONYMO_CODES_RESELLER_HASHES: resellerHashes, TRUST_PROXY: "true",
  } });
});
afterAll(async () => h?.close());

const create = (face_usd: number, count: number, token = tokenA) =>
  h.request(batchesPath, { method: "POST", headers: authorization(token), json: { face_usd, count } });
const list = (token = tokenA, after = "") =>
  h.request(after ? `${batchesPath}?after=${after}` : batchesPath, { headers: authorization(token) });
const redeem = (code: string, headers?: Record<string, string>) => h.request(redeemPath, { method: "POST", headers, json: { code } });

async function issue(face = 25, size = 1): Promise<Batch> {
  const response = await create(face, size);
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json() as Promise<Batch>;
}

test("defaults to off and mounts neither voucher nor reseller routes", async () => {
  expect(loadConfig({ ANONYMO_FEATURE_CODES: false, ANONYMO_CODES_RESELLER_HASHES: "invalid" }).codeResellers.size).toBe(0);
  expect(() => loadConfig({ ANONYMO_FEATURE_CODES: true, ANONYMO_CODES_RESELLER_HASHES: '{"bad":"raw-token"}' })).toThrow("SHA-256");
  const off = await startRouter({ providers: [], env: { ANONYMO_FEATURE_CODES: "false" } });
  try {
    expect((await off.request(redeemPath, { method: "POST", json: {} })).status).toBe(404);
    expect((await off.request(batchesPath, { method: "POST", json: {} })).status).toBe(404);
    expect((await off.request(batchesPath)).status).toBe(404);
  } finally { await off.close(); }
});

test("reseller auth scopes listings and each code is returned only when issued", async () => {
  expect((await h.request(batchesPath)).status).toBe(401);
  expect((await create(25, 1, sha256(tokenA))).status).toBe(401);
  const { batch_id, codes: issued } = await issue(10, 2);
  expect(new Set(issued).size).toBe(2);
  const stored = await h.ctx.db.select().from(codes).where(eq(codes.batchId, batch_id));
  expect(stored.map((row) => row.codeHash).sort()).toEqual(issued.map(sha256).sort());
  for (const row of stored) {
    expect(Object.keys(row).sort()).toEqual(["batchId", "codeHash", "faceUsd", "redeemedAt", "redeemedBy", "resellerId"]);
    expect(row).toMatchObject({ resellerId: resellerA, faceUsd: 10, redeemedBy: null, redeemedAt: null });
    expect(issued.some((code) => JSON.stringify(row).includes(code))).toBe(false);
  }
  const key = await h.newKey();
  expect((await redeem(issued[0], key.auth)).status).toBe(200);
  const own = await list();
  expect(own.headers.get("cache-control")).toBe("no-store");
  expect(await own.json()).toMatchObject({ data: expect.arrayContaining([{ batch_id, face_usd: 10, count: 2, redeemed_count: 1 }]) });
  expect(await (await list(tokenB)).json()).toEqual({ data: [], next_cursor: null });
});

test("issuance enforces denominations, whole counts and both batch caps", async () => {
  for (const [value, count] of [[20, 1], [5, 0], [10, 1.5]]) {
    const response = await create(value, count);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_batch" } });
  }
  for (const [value, count] of [[5, MAX_BATCH_COUNT + 1], [50, MAX_BATCH_USD / 50 + 1]]) {
    const response = await create(value, count);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "batch_cap_exceeded" } });
  }
  expect((await issue(5, MAX_BATCH_COUNT)).codes).toHaveLength(MAX_BATCH_COUNT);
  expect((await issue(50, MAX_BATCH_USD / 50)).codes).toHaveLength(MAX_BATCH_USD / 50);
});

test("resellers can page through batch counts without disclosing voucher hashes", async () => {
  const fixture = Array.from({ length: 51 }, (_, i) => ({
    resellerId: resellerB, faceUsd: 5,
    batchId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    codeHash: sha256(`code-pagination-fixture:${i}`),
  }));
  await h.ctx.db.insert(codes).values(fixture);
  const first = await (await list(tokenB)).json() as { data: { batch_id: string }[]; next_cursor: string };
  expect(first.data).toHaveLength(50);
  expect(first.next_cursor).toBe(fixture[49].batchId);
  expect(await (await list(tokenB, first.next_cursor)).json()).toEqual({
    data: [{ batch_id: fixture[50].batchId, face_usd: 5, count: 1, redeemed_count: 0 }],
    next_cursor: null,
  });
});

test("checksum catches every single-symbol substitution and adjacent swap of unlike symbols", async () => {
  const { codes: issued } = await issue(5, 2);
  for (const code of issued) {
    expect(canonicalCode(code)).toBe(code);
    const raw = code.replace(/-/g, "");
    expect(canonicalCode(raw.toLowerCase().replaceAll("0", "o").replaceAll("1", "l"))).toBe(code);
    for (let i = 0; i < raw.length; i++) {
      for (const replacement of CODE_ALPHABET) {
        if (replacement !== raw[i]) expect(canonicalCode(raw.slice(0, i) + replacement + raw.slice(i + 1))).toBeNull();
      }
      if (i + 1 < raw.length && raw[i] !== raw[i + 1]) {
        expect(canonicalCode(raw.slice(0, i) + raw[i + 1] + raw[i] + raw.slice(i + 2))).toBeNull();
      }
    }
  }
  const malformed = await redeem("not a voucher");
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { type: "invalid_code" } });
  const absent = "0000-0000-0000-0000";
  const missing = await redeem(absent);
  expect(missing.status).toBe(404);
  expect(await missing.text()).not.toContain(absent);
});

test("exactly one concurrent claimant gets the face value and existing keys are never echoed", async () => {
  const { codes: [code] } = await issue();
  const key = await h.newKey();
  const heads = key.auth;
  const responses = await Promise.all([redeem(code, heads), redeem(code.replace(/-/g, "").toLowerCase(), heads)]);
  const winner = responses.find((r) => r.status === 200);
  const duplicate = responses.find((r) => r.status === 409);
  expect(await winner?.json()).toEqual({ added_usd: 25, key_hash: key.hash });
  expect(await duplicate?.json()).toMatchObject({ error: { type: "code_already_redeemed" } });
  const hash = sha256(code);
  const rows = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `code:${hash}`));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ amount: usdToPico(25), keyHash: key.hash, kind: "code" });
  const [stored] = await h.ctx.db.select().from(codes).where(eq(codes.codeHash, hash));
  expect(stored.redeemedBy).toBe(key.hash);
  expect((await balanceOf(h.ctx.db, rows[0].accountId)).available).toBe(usdToPico(25));
});

test("a keyless redemption returns a working funded root key once", async () => {
  const { codes: [code] } = await issue(50);
  const response = await redeem(code);
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as { key: string; key_hash: string; added_usd: number };
  expect(body.added_usd).toBe(50);
  expect(body.key_hash).toBe(sha256(body.key));
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, body.key_hash));
  expect(key.management).toBe(true);
  expect(JSON.stringify(key, (_k, v) => typeof v === "bigint" ? String(v) : v)).not.toContain(body.key);
  const balance = await h.request("/balance", { headers: authorization(body.key) });
  expect(await balance.json()).toMatchObject({ available_usd: 50, usage_only_usd: 50, withdraw_to: [] });
  expect(await reserve(h.ctx.db, { id: "voucher-paid-call", accountId: key.accountId, keyHash: key.keyHash, amount: usdToPico(1) })).toBe(usdToPico(1));
  expect(await settle(h.ctx.db, "voucher-paid-call", usdToPico(1))).toEqual({ charged: usdToPico(1), uncovered: 0n });
  expect((await balanceOf(h.ctx.db, key.accountId)).available).toBe(usdToPico(49));
  const duplicate = await redeem(code);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.text()).not.toContain(body.key);
});

test("an unredeemed code survives more than twelve months without an expiry timestamp", async () => {
  const issuedAt = new Date();
  const { codes: [code] } = await issueBatch(h.ctx.db, resellerA, 5, 1);
  const clock = new Date(issuedAt);
  clock.setUTCFullYear(clock.getUTCFullYear() + 1);
  clock.setUTCDate(clock.getUTCDate() + 1);
  expect((await redeemCode(h.ctx, code, null, clock)).added_usd).toBe(5);
  const [row] = await h.ctx.db.select().from(codes).where(eq(codes.codeHash, sha256(code)));
  expect(row.redeemedAt).toEqual(clock);
});

test("a conflicting ledger reference rolls back a fresh key and leaves the voucher unclaimed", async () => {
  const { codes: [code] } = await issue(5);
  const key = await h.newKey();
  const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  const hash = sha256(code);
  await post(h.ctx.db, { accountId: row.accountId, keyHash: key.hash, amount: usdToPico(5), kind: "code", ref: `code:${hash}` });
  const keyCount = async () => (await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(keys))[0].n;
  const before = await keyCount();
  expect((await redeem(code)).status).toBe(409);
  expect(await keyCount()).toBe(before);
  const [voucher] = await h.ctx.db.select().from(codes).where(eq(codes.codeHash, hash));
  expect(voucher).toMatchObject({ redeemedBy: null, redeemedAt: null });
});

test("voucher credit cannot be paid out to a wallet even when a separate deposit can be", async () => {
  const key = await h.fundedKey(10n);
  const wallet = "0xabababababababababababababababababababab"; // gitleaks:allow
  await h.ctx.db.insert(anonymoKeys).values({ keyHash: key.hash, wallet });
  const { codes: [code] } = await issue();
  expect((await redeem(code, key.auth)).status).toBe(200);
  const balance = await (await h.request("/balance", { headers: key.auth })).json() as { available_usd: number; usage_only_usd: number; withdraw_to: unknown[] };
  expect(balance).toMatchObject({ available_usd: 35, usage_only_usd: 25 });
  expect(balance.withdraw_to).toContainEqual({ chain: "rhc", address: wallet, max_usd: 10 });
  const response = await h.request("/withdraw", {
    method: "POST", headers: key.auth,
    json: { chain: "rhc", to: wallet, amount_usd: 11, idempotency_key: "code-cashout-check" },
  });
  expect(response.status).toBe(402);
  expect(await response.json()).toMatchObject({ error: { type: "insufficient_balance", metadata: { available_usd: 10 } } });
});

test("invalid key auth does not consume a voucher or fall back to minting", async () => {
  const { codes: [code] } = await issue(5);
  const response = await redeem(code, authorization("fixture-invalid-key")); // gitleaks:allow
  expect(response.status).toBe(401);
  expect((await redeem(code)).status).toBe(201);
});

test("redemption attempts share a bounded bucket by address and never store the address itself", async () => {
  const caller = "192.0.2.12"; // gitleaks:allow
  const other = "192.0.2.13"; // gitleaks:allow
  const captured = new Set<string>();
  const limiter = h.ctx.limiter;
  const fixed = new MemoryRateLimiter(() => 60_000);
  h.ctx.limiter = { close: () => fixed.close(), take: (key, ...args) => {
    if (key.startsWith("codes:")) captured.add(key);
    return fixed.take(key, ...args);
  } };
  try {
    const makeTry = (ip: string) => redeem("invalid", { "x-forwarded-for": ip });
    expect((await Promise.all(Array.from({ length: 15 }, () => makeTry(caller)))).map((r) => r.status)).toEqual(Array(15).fill(400));
    const limited = await makeTry(caller);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await makeTry(other)).status).toBe(400);
    expect(captured.size).toBe(2);
    for (const bucket of captured) expect(bucket).toMatch(/^codes:redeem:[a-f0-9]{64}$/);
  } finally {
    h.ctx.limiter = limiter;
    await fixed.close();
  }
});

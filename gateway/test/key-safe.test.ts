import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db/client.ts";
import { keySafes } from "../src/db/schema.ts";
import { KEY_SAFE_PATH } from "../src/anonymo/keysafe/wire.ts";
import { MemoryRateLimiter, type RateLimiter } from "../src/lib/ratelimit.ts";

const b64 = (size: number, value: number) => Buffer.alloc(size, value).toString("base64url");
const ids = { safeId: b64(16, 11), credentialId: b64(64, 22) };
const wrapped = { credentialId: ids.credentialId, ciphertext: b64(120, 33), nonce: b64(12, 44) };
const fixture = { ...ids, ...wrapped };
const lookup = `${KEY_SAFE_PATH}/lookup`;
const post = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const request = (path: string, body: unknown, method = "POST") => enabled.app.request(path, post(body, method));

let db: Awaited<ReturnType<typeof openDatabase>>;
let enabled: Awaited<ReturnType<typeof createApp>>;
let disabled: Awaited<ReturnType<typeof createApp>>;
let originalLimiter: RateLimiter;

beforeAll(async () => {
  db = await openDatabase("pglite://memory");
  const opts = { database: db, startJobs: false };
  const env = { ANONYMO_ENV: "test", CANARIES: "false", HEALTH_PROBES: "false", REDIS_URL: "" };
  disabled = await createApp({ ...opts, env });
  enabled = await createApp({ ...opts, env: { ...env, ANONYMO_FEATURE_KEY_SAFE: "true" } });
  originalLimiter = enabled.ctx.limiter;
});

beforeEach(() => { enabled.ctx.limiter = new MemoryRateLimiter(); });
afterEach(async () => {
  await enabled.ctx.limiter.close();
  enabled.ctx.limiter = originalLimiter;
});

afterAll(async () => {
  await enabled?.close();
  await disabled?.close();
  await db?.close();
});

test("key safe routes and active inventory are off by default", async () => {
  expect(disabled.ctx.cfg.features.keySafe).toBe(false);
  expect((await disabled.app.request(KEY_SAFE_PATH, post(fixture))).status).toBe(404);
  expect((await disabled.app.request(lookup, post({ credentialId: ids.credentialId }))).status).toBe(404);
  expect((await disabled.app.request(KEY_SAFE_PATH, post(ids, "DELETE"))).status).toBe(404);
  expect(await (await disabled.app.request("/keep/inventory.json")).text()).not.toContain("key_safes");
  expect(await (await enabled.app.request("/keep/inventory.json")).text()).toContain("key_safes");
});

test("the migrated table keeps only wrapped bytes and deletion requires the matching safe ID", async () => {
  expect((await request(KEY_SAFE_PATH, fixture)).status).toBe(204);
  expect((await request(KEY_SAFE_PATH, fixture)).status).toBe(204);
  expect((await request(KEY_SAFE_PATH, { ...fixture, safeId: b64(16, 55) })).status).toBe(409);

  const rows = await db.db.select().from(keySafes);
  expect(rows).toEqual([{
    safeId: Buffer.from(ids.safeId, "base64url"),
    credentialId: Buffer.from(ids.credentialId, "base64url"),
    ciphertext: Buffer.from(wrapped.ciphertext, "base64url"),
    nonce: Buffer.from(wrapped.nonce, "base64url"),
    createdAt: expect.any(Date),
  }]);
  for (const field of [{ credentialId: ids.credentialId }, { safeId: ids.safeId }]) {
    const found = await request(lookup, field);
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(await found.json()).toEqual(wrapped);
  }

  expect((await request(KEY_SAFE_PATH, { credentialId: ids.credentialId }, "DELETE")).status).toBe(400);
  expect((await request(KEY_SAFE_PATH, { ...ids, safeId: b64(16, 55) }, "DELETE")).status).toBe(204);
  expect((await request(lookup, { credentialId: ids.credentialId })).status).toBe(200);
  expect((await request(KEY_SAFE_PATH, ids, "DELETE")).status).toBe(204);
  expect((await request(KEY_SAFE_PATH, ids, "DELETE")).status).toBe(204);
  expect((await request(lookup, { credentialId: ids.credentialId })).status).toBe(404);
  expect((await request(lookup, { safeId: ids.safeId })).status).toBe(404);
  expect(await db.db.select().from(keySafes)).toEqual([]);
});

test("rejects secret fields, malformed encodings and oversized bodies without storing them", async () => {
  const plaintext = "anm_test_fixture_key_1234567890"; // gitleaks:allow
  for (const body of [
    { ...fixture, key: plaintext, memorySecret: b64(32, 55), prf: b64(32, 66) },
    { ...fixture, nonce: b64(13, 2) },
    { ...fixture, credentialId: b64(1024, 3) },
    { ...fixture, ciphertext: b64(1025, 3) },
    { ...fixture, safeId: `${ids.safeId}=` },
  ]) {
    const response = await request(KEY_SAFE_PATH, body);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(plaintext);
  }
  expect((await request(KEY_SAFE_PATH, { ...fixture, ciphertext: "x".repeat(4096) })).status).toBe(413);
  expect(await db.db.select().from(keySafes)).toEqual([]);
});

test("counts key safe operations separately and provides a retry delay", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1000);
  try {
    for (let i = 0; i < 6; i++) expect((await request(KEY_SAFE_PATH, fixture)).status).toBe(204);
    const denied = await request(KEY_SAFE_PATH, fixture);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await request(lookup, { credentialId: ids.credentialId })).status).toBe(200);
    expect((await request(KEY_SAFE_PATH, ids, "DELETE")).status).toBe(204);
  } finally {
    now.mockRestore();
  }
});

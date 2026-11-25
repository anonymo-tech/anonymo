import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { deriveKey, generateApiKey } from "../src/chain/keys.ts";
import { openDatabase } from "../src/db/client.ts";
import { keys, kv, memoryBlobs } from "../src/db/schema.ts";
import { ensureAccount, post } from "../src/ledger/ledger.ts";
import { MEMORY_BYTES_CAP, MEMORY_ITEM_CAP, memoryWins } from "../src/anonymo/memory-sync/routes.ts";
import { encode, memoryKeys, openItem, sealItem, type MemoryBlob, type MemoryItem } from "../../dash/lib/anonymo/vault-memory/crypto.ts";
import { blindGrant } from "../../dash/lib/anonymo/vault-memory/grant.ts";

const secret = randomBytes(32);
const apiKey = generateApiKey(); // gitleaks:allow
const key = deriveKey(apiKey);
const accountId = "demo-account";
const plaintext = "Prefers sour cherries in a sealed jar.";
const first: MemoryItem = {
  id: randomUUID(), characterId: "sample-character", kind: "pref", text: plaintext,
  createdAt: "2026-03-01T00:00:00Z", weight: 2,
};
const env = { ANONYMO_ENV: "test", REDIS_URL: "", ANONYMO_FEATURE_MEMORY_SYNC: false };
const base = "/v1/memory-sync";
let database: Awaited<ReturnType<typeof openDatabase>>;
let server: Awaited<ReturnType<typeof createApp>>;
let deviceA: Awaited<ReturnType<typeof memoryKeys>>;
let deviceB: Awaited<ReturnType<typeof memoryKeys>>;
let item: MemoryBlob;
let issuer: { n: string; e: string };

beforeAll(async () => {
  database = await openDatabase("pglite://memory");
  const issuerPem = generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey.export({ format: "pem", type: "pkcs8" });
  server = await createApp({ database, env: { ...env, ANONYMO_FEATURE_MEMORY_SYNC: true, ANONYMO_MEMORY_SYNC_ISSUER: issuerPem }, startJobs: false });
  await ensureAccount(database.db, accountId, "key");
  await database.db.insert(keys).values({
    keyHash: key.keyHash, accountId, chainKeyHash: key.chainKeyHash, keyAddress: key.keyAddress, label: "sample-key", management: true,
  });
  [deviceA, deviceB] = await Promise.all([memoryKeys(secret), memoryKeys(secret.slice())]);
  item = await sealItem(deviceA, first, 1);
  issuer = await (await request("issuer")).json();
}, 15_000);

afterAll(async () => {
  await server?.close();
  await database?.close();
});

function request(path: string, authorization?: string, data?: unknown) {
  return server.app.request(`${base}/${path}`, {
    method: "POST",
    headers: { ...(authorization ? { authorization } : {}), ...(data ? { "content-type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}

test("the routes are absent by default", async () => {
  const off = await createApp({ database, env, startJobs: false });
  try {
    expect(off.ctx.cfg.features.memorySync).toBe(false);
    expect((await off.app.request(`${base}/issuer`, { method: "POST" })).status).toBe(404);
  } finally { await off.close(); }
});

test("funding issues a blind grant, and two devices sync ciphertext with only the memory secret", async () => {
  const blind = await blindGrant(issuer, deviceA.id, deviceA.verifier);
  expect(blind.blinded).not.toContain(deviceA.id);
  expect((await request("read", deviceA.authorization)).status).toBe(404);
  expect((await request("grant", `Bearer ${apiKey}`, { blinded: blind.blinded })).status).toBe(402);

  await post(database.db, { accountId, amount: 1n, kind: "deposit", ref: "sample-top-up", keyHash: key.keyHash });
  await post(database.db, { accountId, amount: -1n, kind: "usage", ref: "sample-use", keyHash: key.keyHash });
  expect((await request("grant", `Bearer ${apiKey}`, { blinded: blind.blinded, vaultId: deviceA.id })).status).toBe(400);
  const granted = await request("grant", `Bearer ${apiKey}`, { blinded: blind.blinded });
  expect(granted.status).toBe(200);
  const signed = await blind.finalize((await granted.json()).signed);
  const otherVault = await memoryKeys(randomBytes(32));
  expect((await request("enable", otherVault.authorization, signed)).status).toBe(401);
  expect((await request("enable", deviceA.authorization, signed)).status).toBe(200);

  await database.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, key.keyHash));
  expect((await request("write", `Bearer ${apiKey}`, { items: [item] })).status).toBe(401);
  expect((await request("write", deviceA.authorization, { items: [item] })).status).toBe(200);
  const received = await request("read", deviceB.authorization);
  expect(received.status).toBe(200);
  expect(received.headers.get("cache-control")).toBe("no-store");
  const [row] = (await received.json()).items;
  expect(await openItem(deviceB, row)).toEqual(first);
  await expect(openItem(otherVault, row)).rejects.toThrow();

  const expectedId = Buffer.from(hkdfSync("sha256", secret, "", "vault-id-v1", 32)).toString("hex");
  const keyId = Buffer.from(hkdfSync("sha256", apiKey, "", "vault-id-v1", 32)).toString("hex");
  expect(deviceA.id).toBe(expectedId);
  expect(deviceA.id).not.toBe(keyId);
  expect(deviceA.id).not.toBe(key.keyHash);
  const [stored] = await database.db.select().from(memoryBlobs);
  expect(Object.keys(stored).sort()).toEqual(["ciphertext", "deleted", "itemId", "updatedAt", "vaultId", "version"]);
  expect(stored.vaultId.toString("hex")).toBe(expectedId);
  expect(stored.ciphertext.toString("base64url")).toBe(item.ciphertext);
  expect(stored.ciphertext.includes(plaintext)).toBe(false);
  expect(stored.ciphertext.includes(first.characterId!)).toBe(false);
  const registrations = await database.db.select().from(kv).where(like(kv.key, "memory-sync:%"));
  expect(registrations.map(({ key: name, value }) => [name, value])).toEqual([
    [`memory-sync:verifier:${expectedId}`, deviceA.verifier],
  ]);
  const bogus = `Vault ${expectedId}.${otherVault.authorization.split(".")[1]}`;
  expect((await request("read", bogus)).status).toBe(401);
});

test("logical versions settle concurrent writes and tombstones prevent resurrection", async () => {
  const change = await sealItem(deviceA, { ...first, text: "Prefers plums." }, 2);
  const concurrent = await sealItem(deviceB, { ...first, text: "Prefers peaches." }, 2);
  const winner = memoryWins(change, concurrent) ? change : concurrent;
  const write = (blob: MemoryBlob) => request("write", deviceA.authorization, { items: [blob] });
  const settled = await Promise.all([write(change), write(concurrent)]);
  expect(settled.map((r) => r.status)).toEqual([200, 200]);
  expect((await (await request("read", deviceB.authorization)).json()).items).toEqual([winner]);

  const deleted = { id: item.id, version: 2, ciphertext: "", deleted: true };
  expect((await write(deleted)).status).toBe(200);
  for (const stale of [item, change, await sealItem(deviceB, first, 100)]) {
    expect((await (await write(stale)).json()).items).toEqual([deleted]);
  }
  const [stored] = await database.db.select().from(memoryBlobs);
  expect(stored.ciphertext).toEqual(Buffer.alloc(0));
  expect(await openItem(deviceB, deleted)).toBeNull();
});

test("row shape, ciphertext size, batch size and total count are capped", async () => {
  const upload = (items: unknown[]) => request("write", deviceA.authorization, { items });
  expect((await upload([{ ...item, text: plaintext }])).status).toBe(400);
  expect((await upload([{ ...item, ciphertext: encode(new Uint8Array(MEMORY_BYTES_CAP + 1)) }])).status).toBe(400);
  expect((await upload([{ ...item, ciphertext: encode(new Uint8Array(28)) }])).status).toBe(400);
  expect((await upload([{ ...item, deleted: true }])).status).toBe(400);
  expect((await upload(Array.from({ length: 17 }, () => ({ ...item, id: randomUUID() })))).status).toBe(400);

  const fill = async (id: string) => sealItem(deviceA, { ...first, id }, 1);
  const rows = await Promise.all(Array.from({ length: MEMORY_ITEM_CAP - 2 }, () => fill(randomUUID())));
  for (let i = 0; i < rows.length; i += 16) expect((await upload(rows.slice(i, i + 16))).status).toBe(200);
  const competing = await Promise.all([fill(randomUUID()), fill(randomUUID())]);
  const results = await Promise.all(competing.map((row) => upload([row])));
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect((await (await request("read", deviceA.authorization)).json()).items.length).toBe(MEMORY_ITEM_CAP);
  expect((await upload([{ id: rows[0]!.id, version: 2, deleted: true, ciphertext: "" }])).status).toBe(200);
  expect((await upload([await fill(randomUUID())])).status).toBe(409);
}, 20_000);

test("a Pass grants expanded sync through a day-scoped blind signature without connecting the vault to the key", async () => {
  const now = new Date();
  const orderId = randomBytes(32).toString("hex");
  const { passOrders, passes } = await import("../src/anonymo/everyday/schema.ts");
  await database.db.update(keys).set({ disabled: false }).where(eq(keys.keyHash, key.keyHash));
  await database.db.insert(passOrders).values({ orderId, keyHash: key.keyHash, sku: "PASS30" });
  await database.db.insert(passes).values({ orderId, keyHash: key.keyHash, sku: "PASS30", starts: now, ends: new Date(now.getTime() + 86_400_000) });
  const everyday = await createApp({ database, env: { ...env, ANONYMO_FEATURE_MEMORY_SYNC: true, ANONYMO_FEATURE_PASSES: true }, startJobs: false });
  const call = (path: string, authorization: string, data: object) => everyday.app.request(`${base}/${path}`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(data),
  });
  try {
    const authorize = `Bearer ${apiKey}`;
    const offered = await call("capacity", authorize, {});
    expect(offered.status).toBe(200);
    const { n, e, day, level, limit } = await offered.json();
    expect(level).toBe("large");
    expect(limit).toBe(2048);
    const row = await sealItem(deviceA, { ...first, id: randomUUID() }, 1);
    expect((await call("write", deviceA.authorization, { items: [row] })).status).toBe(409);
    const blind = await blindGrant({ n, e }, deviceA.id, deviceA.verifier, `${level}:${day}`);
    const signed = (await (await call("capacity", authorize, { blinded: blind.blinded, day, level })).json()).signed;
    const proof = { ...await blind.finalize(signed), day, level };
    expect((await call("write", deviceA.authorization, { items: [row], proof: { ...proof, level: "unlimited" } })).status).toBe(409);
    expect((await call("write", deviceA.authorization, { items: [row], proof })).status).toBe(200);
    const readable = await call("read-page", deviceA.authorization, {});
    expect(readable.status).toBe(200);
    expect((await readable.json()).items).toHaveLength(128);
    const persisted = await database.db.select().from(kv).where(like(kv.key, "memory-sync:capacity-signer:%"));
    expect(persisted.map((entry) => entry.key)).toEqual(["memory-sync:capacity-signer:large"]);
    expect(JSON.stringify(persisted)).not.toContain(deviceA.id);
    expect(JSON.stringify(persisted)).not.toContain(key.keyHash);
    expect(JSON.stringify(persisted)).not.toContain(proof.signature);
  } finally { await everyday.close(); }
}, 20_000);

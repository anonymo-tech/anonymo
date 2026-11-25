import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { FREE_PROOF_HEADER, FREE_REMAINING_HEADER, FREE_TOKEN_HEADER, hashDevice, issueChallenge, nextDay, utcDay, verifyProof, workDifficulty } from "../src/anonymo/freetier/pow.ts";
import { consumeFreeChat } from "../src/anonymo/freetier/routes.ts";
import { loadConfig } from "../src/config.ts";
import { accounts, apps, freeTokens, generations, holds, keys, ledger, offers } from "../src/db/schema.ts";
import { creditAccount, post } from "../src/ledger/ledger.ts";
import { startRouter, sse, type Harness } from "./helpers.ts";

const moderated = "anonymo-rp";
const paid = "anonymo-1";
const hiddenPrompt = "Free tier prompt privacy marker.";
const hiddenReply = "Free tier reply privacy marker.";
const input = [{ role: "user", content: hiddenPrompt }];
const calls: string[] = [];
const token = () => randomBytes(32).toString("hex");
const model = (id: string, slug = moderated) => ({ id, slug, prompt: "0.000001", completion: "0.000001", ctx: 32768 });
const mock = (id: string, slug = moderated) => ({
  id, name: id, models: [model(id, slug)],
  reply: () => {
    calls.push(id);
    return hiddenReply;
  },
});
let h: Harness;

beforeAll(async () => {
  h = await startRouter({
    env: { ANONYMO_FEATURE_FREE_TIER: "true", ANONYMO_FREE_DAILY: "2", ANONYMO_FREE_POW_DIFFICULTY: "12" },
    providers: [mock("safe-qwen"), mock("safe-llama"), mock("unreviewed"), mock("paid-route", paid)],
    rand: () => 0,
  });
  for (const [id, family] of [["safe-qwen", "qwen"], ["safe-llama", "llama"]])
    await h.ctx.db.update(offers).set({ tier: 1, upstream: "selfhost", isModerated: true, family }).where(eq(offers.providerId, id));
  await h.ctx.catalog.refresh();
});
afterAll(async () => h?.close());

function solve(challenge: string, difficulty: number) {
  for (let nonce = 0; ; nonce++) {
    if (!(createHash("sha256").update(`${challenge}:${nonce}`).digest().readUInt32BE() >>> (32 - difficulty))) return nonce;
  }
}

async function challenge(device: string, batch = 1) {
  const res = await h.request(`/v1/free/challenge?batch=${batch}`, { headers: { [FREE_TOKEN_HEADER]: device } });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.json() as Promise<{ challenge: string | null; difficulty: number; expires: number; batch: number; remaining: number; model: string | null }>;
}

async function proof(device = token(), batch = 1) {
  const puzzle = await challenge(device, batch);
  expect(puzzle.model).toBe(moderated);
  const nonce = solve(puzzle.challenge!, puzzle.difficulty);
  return { device, puzzle, headers: (slot = 0) => ({
    [FREE_TOKEN_HEADER]: device, [FREE_PROOF_HEADER]: `${puzzle.challenge}:${nonce}:${slot}`,
  }) };
}

const chat = (headers: HeadersInit, body: Record<string, unknown> = {}) => h.request("/v1/chat/completions", {
  method: "POST", headers, json: { model: moderated, messages: input, ...body },
});
const codeOf = async (res: Response) => (await res.json() as { error: { type: string } }).error.type;

test("switch defaults off, quota defaults to ten, and the challenge endpoint is absent", async () => {
  const cfg = loadConfig({ ANONYMO_ENV: "test" });
  expect(cfg.features.freeTier).toBe(false);
  expect(cfg.freeTier.daily).toBe(10);
  const off = await startRouter({ providers: [mock("ordinary-off", paid)] });
  try {
    expect((await off.request("/v1/free/challenge")).status).toBe(404);
    const key = await off.newKey();
    const response = await off.request("/v1/chat/completions", {
      method: "POST", headers: key.auth, json: { model: paid, messages: input },
    });
    expect(await codeOf(response)).toBe("insufficient_credits");
  } finally { await off.close(); }
});

test("proof is signed, device-bound, time limited and adaptive", () => {
  const now = Date.UTC(2026, 0, 1, 23, 59, 59);
  const device = hashDevice(token())!;
  const secret = "fixture-signing-secret"; // gitleaks:allow
  const puzzle = issueChallenge(secret, device, 3, 2, 8, now);
  const nonce = solve(puzzle.challenge, puzzle.difficulty);
  const signed = `${puzzle.challenge}:${nonce}:1`;
  expect(puzzle.expires).toBe(nextDay(now));
  expect(verifyProof(secret, device, signed, now)).toMatchObject({ expected: 4, day: utcDay(now), difficulty: 8 });
  expect(verifyProof(secret, hashDevice(token())!, signed, now)).toBeNull();
  expect(verifyProof(secret, device, signed, nextDay(now))).toBeNull();
  expect(verifyProof(secret, device, signed.replace(".3.2.8.", ".3.8.8."), now)).toBeNull();
  expect(verifyProof(secret, device, signed.slice(0, -1) + "2", now)).toBeNull();
  expect(workDifficulty(16, 1, 0, 1)).toBe(16);
  expect(workDifficulty(16, 60, 0, 1)).toBe(17);
  expect(workDifficulty(16, 1, 3, 1)).toBe(17);
  expect(workDifficulty(16, 1, 0, 4)).toBe(18);
  expect(workDifficulty(22, 1200, 100, 8)).toBe(24);
});

test("one proof buys a batch of ordered, single-use slots; concurrency respects the quota", async () => {
  const access = await proof(token(), 8);
  expect(access.puzzle.batch).toBe(2);
  expect(await codeOf(await chat(access.headers(1)))).toBe("free_proof_stale");
  expect(await codeOf(await chat({ ...access.headers(), [FREE_TOKEN_HEADER]: token() }))).toBe("invalid_free_proof");
  const parallel = await Promise.all(Array.from({ length: 4 }, () => chat(access.headers())));
  expect(parallel.map((res) => res.status).sort()).toEqual([200, 409, 409, 409]);
  const first = parallel.find((res) => res.ok)!;
  expect(first.headers.get(FREE_REMAINING_HEADER)).toBe("1");
  const row = await first.json() as { receipt: { payload: { cost: string } } };
  expect(row.receipt.payload.cost).toBe("0");
  const last = await chat(access.headers(1), { stream: true });
  expect(last.status).toBe(200);
  expect(last.headers.get(FREE_REMAINING_HEADER)).toBe("0");
  const events = (await sse(last)).events;
  expect(events.find((event) => event.receipt)?.receipt.payload).toMatchObject({ cost: "0", payer: null, sponsorship: "free_daily" });
  expect(await codeOf(await chat(access.headers(1)))).toBe("free_daily_limit");
  expect((await challenge(access.device)).remaining).toBe(0);
  const deviceHash = hashDevice(access.device)!;
  const [saved] = await h.ctx.db.select().from(freeTokens).where(eq(freeTokens.deviceToken, deviceHash));
  expect(Buffer.from(saved.deviceToken)).toEqual(deviceHash);
  expect(saved).toMatchObject({ used: 2, powDifficulty: access.puzzle.difficulty, day: utcDay(Date.now()) });
});

test("the quota resets at UTC midnight on the same device", async () => {
  const device = token();
  const hash = hashDevice(device)!;
  const yesterday = utcDay(Date.now() - 86_400_000);
  await h.ctx.db.insert(freeTokens).values({ deviceToken: hash, day: yesterday, used: 2, powDifficulty: 14 });
  const access = await proof(device);
  expect(access.puzzle.remaining).toBe(2);
  const old = { device: hash, expected: 0, day: yesterday, expires: Date.now() + 10_000, difficulty: 12 };
  await expect(consumeFreeChat(h.ctx, old)).rejects.toMatchObject({ type: "free_proof_stale" });
  expect((await chat(access.headers())).status).toBe(200);
  const [saved] = await h.ctx.db.select().from(freeTokens).where(eq(freeTokens.deviceToken, hash));
  expect(saved).toMatchObject({ used: 1, day: utcDay(Date.now()) });
});

test("free chat applies both floor checks and never reroutes a floor block", async () => {
  const access = await proof();
  const originalFloor = h.ctx.anonymo.floor;
  const originalRefusal = h.ctx.anonymo.refusal;
  const before = calls.length;
  let replyChecks = 0;
  let refuseChecks = 0;
  let blockInput = true;
  try {
    h.ctx.anonymo.floor = {
      checksReplies: true,
      check: async ({ stage }) => {
        if (stage === "reply") replyChecks++;
        return blockInput || stage === "reply" ? { ok: false, category: "cbrn" } : { ok: true };
      },
    };
    h.ctx.anonymo.refusal = { isRefusal: async () => { refuseChecks++; return false; } };
    expect((await chat(access.headers())).status).toBe(451);
    expect(calls).toHaveLength(before);
    expect(refuseChecks).toBe(0);
    expect((await challenge(access.device)).remaining).toBe(2);
    blockInput = false;
    const replyBlock = await chat(access.headers());
    expect(replyBlock.status).toBe(451);
    expect(await replyBlock.text()).not.toContain(hiddenReply);
    expect(replyChecks).toBe(1);
    expect(calls).toHaveLength(before + 1);
  } finally {
    h.ctx.anonymo.floor = originalFloor;
    h.ctx.anonymo.refusal = originalRefusal;
  }
});

test("refusal retries remain moderated with zero charges, and free storage contains only counters and receipt metadata", async () => {
  const access = await proof();
  const originalRefusal = h.ctx.anonymo.refusal;
  const balanceBefore = await h.ctx.db.select().from(accounts);
  const ledgerBefore = await h.ctx.db.select().from(ledger);
  const holdsBefore = await h.ctx.db.select().from(holds);
  const appsBefore = await h.ctx.db.select().from(apps);
  const before = calls.length;
  let classified = 0;
  try {
    h.ctx.anonymo.refusal = { isRefusal: async () => ++classified === 1 };
    const res = await chat({
      ...access.headers(), "x-anonymo-cache": "exact", "x-anonymo-refusal-catch": "off", "x-title": hiddenPrompt,
    });
    expect(res.status).toBe(200);
    expect(calls.slice(before).sort()).toEqual(["safe-llama", "safe-qwen"]);
    const data = await res.json() as { id: string; anonymo_receipt: { payload: { cost: string; routes: { cost: string }[] } } };
    expect(data.anonymo_receipt.payload.cost).toBe("0");
    expect(data.anonymo_receipt.payload.routes.map((route) => route.cost)).toEqual(["0", "0"]);
    const [gen] = await h.ctx.db.select().from(generations).where(eq(generations.id, data.id));
    expect(gen).toMatchObject({ mode: "free", cost: 0n, keyHash: null, accountId: null, appId: null });
    const stored = JSON.stringify(gen, (_key, value) => typeof value === "bigint" ? String(value) : value);
    for (const privateValue of [hiddenPrompt, hiddenReply, access.device, hashDevice(access.device)!.toString("hex")])
      expect(stored).not.toContain(privateValue);
    expect(await h.ctx.db.select().from(accounts)).toEqual(balanceBefore);
    expect(await h.ctx.db.select().from(ledger)).toEqual(ledgerBefore);
    expect(await h.ctx.db.select().from(holds)).toEqual(holdsBefore);
    expect(await h.ctx.db.select().from(apps)).toEqual(appsBefore);
  } finally { h.ctx.anonymo.refusal = originalRefusal; }
});

test("guest requests reject unmoderated routes and paywalled features before dispatch", async () => {
  const access = await proof();
  const before = calls.length;
  expect(await codeOf(await chat(access.headers(), { model: paid }))).toBe("funded_key_required");
  for (const fields of [{ models: [paid] }, { n: 2 }, { model: `${moderated}:online` }, { cache: { mode: "exact" } }])
    expect(await codeOf(await chat(access.headers(), fields))).toBe("free_text_only");
  expect((await challenge(access.device)).remaining).toBe(2);
  expect(calls).toHaveLength(before);
  const cors = await h.request("/v1/chat/completions", {
    method: "OPTIONS", headers: { origin: "https://example.test", "access-control-request-method": "POST" },
  });
  expect(cors.headers.get("access-control-allow-headers")).toContain(FREE_PROOF_HEADER);
  const region = await chat({ ...access.headers(), "cf-ipcountry": "KP" });
  expect(region.status).toBe(451);
  expect(calls).toHaveLength(before);
});

test("the explicit route allowlist selects self-hosted offers and rejects hosted routes", async () => {
  const ids = h.ctx.cfg.freeTier.routes;
  try {
    ids.add("paid-route");
    const unavailable = await h.request("/v1/free/challenge", { headers: { [FREE_TOKEN_HEADER]: token() } });
    expect(unavailable.status).toBe(503);
    expect(await codeOf(unavailable)).toBe("free_unavailable");
    ids.add("safe-llama");
    const access = await proof();
    const before = calls.length;
    expect((await chat(access.headers())).status).toBe(200);
    expect(calls.slice(before)).toEqual(["safe-llama"]);
  } finally { ids.clear(); }
});

test("law 5 distinguishes funding history from other credits and keeps the normal paid path after top-up", async () => {
  const key = await h.newKey();
  const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  const before = calls.length;
  await creditAccount(h.ctx.db, { accountId: row.accountId, keyHash: row.keyHash, amount: 1_000_000_000_000n, kind: "adjustment", ref: "fixture:adjustment" });
  expect(await codeOf(await chat(key.auth, { model: paid }))).toBe("funded_key_required");
  expect(await codeOf(await chat(key.auth, { model: "anonymo-council", council: { models: [paid, moderated] } }))).toBe("funded_key_required");
  expect(calls).toHaveLength(before);
  expect((await chat(key.auth)).status).toBe(200);
  expect(calls.at(-1)).toMatch(/^safe-/);
  await h.chain.deposit(h.ctx, key.chainKeyHash, 1_000_000n);
  const res = await chat(key.auth, { model: paid });
  expect(res.status).toBe(200);
  expect((await res.json() as { usage: { cost: number } }).usage.cost).toBeGreaterThan(0);
  expect(calls.at(-1)).toBe("paid-route");
  const [account] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, row.accountId));
  await post(h.ctx.db, { accountId: row.accountId, keyHash: row.keyHash, amount: -account.balance, kind: "withdraw", ref: "fixture:withdraw" });
  expect(await codeOf(await chat(key.auth, { model: paid }))).toBe("insufficient_credits");
  for (const kind of ["code_credit", "ticket_credit", "stars_credit"]) {
    const funded = await h.newKey();
    const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, funded.hash));
    await creditAccount(h.ctx.db, { accountId: k.accountId, keyHash: k.keyHash, amount: 1_000_000_000_000n, kind, ref: `fixture:${kind}` });
    expect((await chat(funded.auth, { model: paid })).status).toBe(200);
  }
});

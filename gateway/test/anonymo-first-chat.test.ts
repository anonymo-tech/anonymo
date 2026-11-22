import { beforeAll, afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { reserveFirstChat, issueFirstChat } from "../src/anonymo/keys/first-chat.ts";
import { accounts, generations, holds, keys } from "../src/db/schema.ts";
import { usdToPico } from "../src/lib/money.ts";

let h: Harness;
const messages = [{ role: "user", content: "Give me a greeting." }];
const sent: Record<string, unknown>[] = [];
const model = { id: "test-chat", slug: "anonymo-1", prompt: "0.0000003", completion: "0.000001", ctx: 32768 };
beforeAll(async () => {
  h = await startRouter({ providers: [{
    id: "test-route", name: "Test route", models: [model], reply: (_prompt, body) => {
      sent.push(body);
      return "A short greeting from the mock provider.";
    },
  }] });
});
afterAll(async () => h?.close());

async function eligibleKey() {
  const key = await h.newKey();
  const [record] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  expect(await issueFirstChat(h.ctx.db, record.accountId, randomUUID())).toBe(true);
  return { ...key, accountId: record.accountId };
}

function chat(auth: Record<string, string>, fields: Record<string, unknown> = {}) {
  return h.request("/v1/chat/completions", { method: "POST", headers: auth, json: { model: "anonymo-1", messages, dashboard_chat: true, ...fields } });
}

for (const stream of [false, true]) {
  test(`one real bounded reply with a zero charge, including Character Studio context, stream=${stream}`, async () => {
    const key = await eligibleKey();
    const characterMessages = [{ role: "system", content: "You are a lighthouse keeper." }, { role: "assistant", content: "Welcome aboard." }, ...messages];
    const response = await chat(key.auth, { stream, messages: characterMessages, max_completion_tokens: 6000 });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const events = stream ? raw.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6))) : [];
    const last = stream ? events.find((event) => event.receipt) : JSON.parse(raw);
    const received = stream ? events.map((event) => event.choices?.[0]?.delta?.content ?? "").join("") : last.choices[0].message.content;
    expect(received).toBe("A short greeting from the mock provider.");
    expect(last.receipt.payload.sponsorship).toBe("first_dashboard_chat");
    expect(last.receipt.payload.cost).toBe("0");
    expect(Number(last.receipt.payload.cost_details.upstream)).toBeGreaterThan(0);
    expect(last.usage.cost).toBe(0);
    expect(last.anonymo_receipt.payload.cost).toBe("0");
    expect(sent.at(-1)).toMatchObject({ max_tokens: 256, messages: characterMessages });
    expect(sent.at(-1)).not.toHaveProperty("max_completion_tokens");
    expect(sent.at(-1)).not.toHaveProperty("dashboard_chat");
    const [account] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, key.accountId));
    expect(account.balance).toBe(0n);
    expect(account.held).toBe(0n);
    const [hold] = await h.ctx.db.select().from(holds).where(eq(holds.id, last.receipt.id));
    expect(hold.amount).toBe(0n);
    expect(hold.status).toBe("settled");
    const [gen] = await h.ctx.db.select().from(generations).where(eq(generations.id, last.receipt.id));
    expect(gen.cost).toBe(0n);
    expect(gen.upstreamCost).toBeGreaterThan(0n);
    const count = sent.length;
    expect((await chat(key.auth)).status).toBe(402);
    expect(sent).toHaveLength(count);
  });
}

test("two simultaneous requests share one sponsored dispatch", async () => {
  const key = await eligibleKey();
  const before = sent.length;
  const responses = await Promise.all([chat(key.auth), chat(key.auth)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 402]);
  expect(sent.length - before).toBe(1);
});

test("ineligible requests, an unavailable costly route and an input floor block leave the trial intact", async () => {
  const key = await eligibleKey();
  const before = sent.length;
  for (const extra of [
    { dashboard_chat: false }, { model: "anonymo-1:floor" }, { n: 2 }, { models: ["anonymo-1"] },
    { cache: { mode: "exact" } }, { reasoning: { enabled: true } }, { messages: [{ role: "user", content: "🟣".repeat(2100) }] },
    { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
  ]) expect((await chat(key.auth, extra)).status).toBeGreaterThanOrEqual(400);
  const candidates = h.ctx.catalog.offers("anonymo-1");
  const prices = candidates.map((c) => c.priceRequest);
  try {
    for (const c of candidates) c.priceRequest = usdToPico("0.01");
    expect((await chat(key.auth)).status).toBe(402);
  } finally { candidates.forEach((c, i) => { c.priceRequest = prices[i]; }); }
  const floor = h.ctx.anonymo.floor;
  try {
    h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "cbrn" }) };
    expect((await chat(key.auth)).status).toBe(451);
  } finally { h.ctx.anonymo.floor = floor; }
  expect(sent).toHaveLength(before);
  expect((await chat(key.auth)).status).toBe(200);
});

test("ordinary paid keys keep their original output cap and paid receipt", async () => {
  const key = await eligibleKey();
  await h.chain.deposit(h.ctx, key.chainKeyHash, 1_000_000n);
  const response = await chat(key.auth, { max_tokens: 1024 });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.usage.cost).toBeGreaterThan(0);
  expect(data.receipt.payload.sponsorship).toBeUndefined();
  expect(sent.at(-1)?.max_tokens).toBe(1024);
  expect(await reserveFirstChat(h.ctx.db, key.accountId)).toBeNull();
});

test("a dispatched upstream failure releases the zero hold, and cannot be blindly replayed", async () => {
  const key = await eligibleKey();
  const mock = h.mocks["test-route"];
  const previous = mock.cfg.behaviour;
  try {
    mock.cfg.behaviour = "reject400";
    expect((await chat(key.auth)).status).toBeGreaterThanOrEqual(400);
  } finally { mock.cfg.behaviour = previous; }
  const [hold] = await h.ctx.db.select().from(holds).where(eq(holds.accountId, key.accountId));
  expect(hold.status).toBe("released");
  expect(hold.amount).toBe(0n);
  expect((await chat(key.auth)).status).toBe(402);
});

test("new credit arriving during the first reply remains entirely spendable", async () => {
  const key = await eligibleKey();
  const mock = h.mocks["test-route"];
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let unblock!: () => void;
  const resume = new Promise<void>((resolve) => { unblock = resolve; });
  mock.cfg.holdStream = async (part) => { if (part === 0) { entered(); await resume; } };
  try {
    const call = chat(key.auth, { stream: true });
    await waiting;
    await h.chain.deposit(h.ctx, key.chainKeyHash, 1_000_000n);
    unblock();
    const text = await (await call).text();
    expect(text).toContain('"sponsorship":"first_dashboard_chat"');
    const [account] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, key.accountId));
    expect(account.balance).toBe(usdToPico("1"));
    expect(account.held).toBe(0n);
  } finally { unblock(); delete mock.cfg.holdStream; }
});

test("a plain API key cannot request sponsorship without a dashboard-issued allowance", async () => {
  const key = await h.newKey();
  const before = sent.length;
  expect((await chat(key.auth)).status).toBe(402);
  expect(sent).toHaveLength(before);
});

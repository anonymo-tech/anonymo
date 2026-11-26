import { beforeAll, afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { issueFirstChat } from "../src/anonymo/keys/first-chat.ts";
import { accounts, generations, holds, keys } from "../src/db/schema.ts";
import { firstChatInputBound } from "../src/api/chat.ts";
import { PPQ_CHAT_MODELS } from "../src/providers/ppq-chat.ts";
import * as network from "../src/providers/network.ts";
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

test("a first message can name any approved PPQ Regular Chat model at its exact ID", () => {
  const bound = firstChatInputBound({ model: "anonymo-1", messages });
  expect(bound).toBeGreaterThan(0);
  for (const { id } of PPQ_CHAT_MODELS) {
    expect(firstChatInputBound({ model: id, messages })).toBe(bound);
    expect(firstChatInputBound({ model: id + ":floor", messages })).toBeNull();
    expect(firstChatInputBound({ model: id, messages, models: ["anonymo-1"] })).toBeNull();
  }
  for (const id of ["anonymo-sealed", "anonymo-council", "private/sample", "other/sample"]) {
    expect(firstChatInputBound({ model: id, messages })).toBeNull();
  }
});

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

test("a funded returning account gets its campaign reply with history, then can send an ordinary paid reply", async () => {
  const key = await eligibleKey();
  await h.chain.deposit(h.ctx, key.chainKeyHash, 1_000_000n);
  const history = [...messages, { role: "assistant", content: "Hello!" }, { role: "user", content: "Say hello again." }];
  const [a, b] = await Promise.all([1, 2].map(() =>
    chat(key.auth, { dashboard_chat: "sponsored", max_tokens: 1024, messages: history })));
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const first = await (a.status === 200 ? a : b).json();
  expect(first.usage.cost).toBe(0);
  expect(first.receipt.payload.sponsorship).toBe("first_dashboard_chat");
  expect(sent.at(-1)).toMatchObject({ messages: history, max_tokens: 256 });
  expect(sent.at(-1)).not.toHaveProperty("dashboard_chat");
  const [funded] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, key.accountId));
  expect(funded.balance).toBe(usdToPico("1"));
  expect(funded.held).toBe(0n);
  const response = await chat(key.auth, { max_tokens: 1024 });
  expect(response.status).toBe(200);
  const paid = await response.json();
  expect(paid.usage.cost).toBeGreaterThan(0);
  expect(paid.receipt.payload.sponsorship).toBeUndefined();
  expect(sent.at(-1)?.max_tokens).toBe(1024);
});

test("an explicit free request cannot fall through to paid, cached or council billing", async () => {
  const key = await eligibleKey();
  await h.chain.deposit(h.ctx, key.chainKeyHash, 1_000_000n);
  const before = sent.length;
  for (const fields of [
    { model: "anonymo-council" }, { cache: { mode: "exact" } }, { messages: Array(17).fill(messages[0]) },
    { messages: [...messages, { role: "assistant", content: "Continue." }] },
    { messages: [{ role: "user", content: "x".repeat(8200) }] },
  ]) {
    const r = await chat(key.auth, { ...fields, dashboard_chat: "sponsored" });
    expect(r.status).toBe(409);
    expect((await r.json()).error.type).toBe("first_chat_ineligible");
  }
  expect(sent).toHaveLength(before);
  const floor = h.ctx.anonymo.floor;
  try {
    h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "cbrn" }) };
    expect((await chat(key.auth, { dashboard_chat: "sponsored" })).status).toBe(451);
  } finally { h.ctx.anonymo.floor = floor; }
  const normal = await chat(key.auth);
  expect(normal.status).toBe(200);
  expect((await normal.json()).receipt.payload.sponsorship).toBe("first_dashboard_chat");
});

test("the dedicated dashboard endpoint enforces zero cost, authentication, key caps and floor checks", async () => {
  const path = "/v1/chat/completions/sponsored";
  const call = (headers: Record<string, string>) => h.request(path, {
    method: "POST", headers, json: { model: "anonymo-1", messages, dashboard_chat: false },
  });
  const before = sent.length;
  expect((await call({})).status).toBe(401);
  const issued = await h.request("/keys", { method: "POST", headers: { origin: "https://anonymo.tech" },
    json: { dashboard_signup: randomUUID(), caps: { sealed_only: true } } });
  expect(issued.status).toBe(201);
  const secret = (await issued.json()).key;
  const blocked = await call({ authorization: "Bearer " + secret });
  expect(blocked.status).toBe(403);
  expect((await blocked.json()).error.type).toBe("sealed_only");
  const ordinary = await h.newKey();
  await h.chain.deposit(h.ctx, ordinary.chainKeyHash, 1_000_000n);
  expect((await call(ordinary.auth)).status).toBe(409);
  const key = await eligibleKey();
  const floor = h.ctx.anonymo.floor;
  try {
    h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "cbrn" }) };
    expect((await call(key.auth)).status).toBe(451);
  } finally { h.ctx.anonymo.floor = floor; }
  expect(sent).toHaveLength(before);
  const response = await call(key.auth);
  expect(response.status).toBe(200);
  const reply = await response.json();
  expect(reply.receipt.payload.sponsorship).toBe("first_dashboard_chat");
  expect(reply.usage.cost).toBe(0);
  expect((await call(key.auth)).status).toBe(409);
});

for (const stream of [false, true]) {
  for (const thinkingOnly of [false, true]) {
    test(`an empty first reply releases its claim without a success receipt, stream=${stream}, thinkingOnly=${thinkingOnly}`, async () => {
      const key = await eligibleKey();
      const content = thinkingOnly ? { content: "", reasoning_content: "internal reasoning" } : { content: "" };
      const finish_reason = thinkingOnly ? "length" : "stop";
      const usage = { prompt_tokens: 5, completion_tokens: thinkingOnly ? 9 : 0 };
      const stub = spyOn(network, "providerFetch").mockImplementation(async () => {
        if (!stream) return Response.json({ choices: [{ index: 0, message: content, finish_reason }], usage });
        const events = [{ choices: [{ index: 0, delta: content, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason }] }, { choices: [], usage }];
        return new Response(events.map(ev => "data: " + JSON.stringify(ev) + "\n\n").join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } });
      });
      try {
        const failed = await chat(key.auth, { stream, dashboard_chat: "sponsored" });
        expect(failed.status).toBe(stream ? 200 : 502);
        const wire = await failed.text();
        expect(wire).toContain('"type":"first_chat_empty_reply"');
        expect(wire).not.toContain('"anonymo_receipt"');
        expect(wire).not.toContain('internal reasoning');
      } finally { stub.mockRestore(); }
      const recovered = await chat(key.auth, { dashboard_chat: "sponsored" });
      expect(recovered.status).toBe(200);
      const answer = await recovered.json();
      expect(answer.choices[0].message.content.trim()).toBeTruthy();
      expect(answer.receipt.payload.cost).toBe("0");
      expect((await chat(key.auth, { dashboard_chat: "sponsored" })).status).toBe(409);
    });
  }
}

for (const stream of [false, true]) {
  test(`an empty filtered completion is terminal, stream=${stream}`, async () => {
    const key = await eligibleKey();
    const stub = spyOn(network, "providerFetch").mockImplementation(async () => {
      const content = { content: "" };
      const choice = { index: 0, finish_reason: "content_filter", ...(stream ? { delta: content } : { message: content }) };
      const body = { choices: [choice] };
      return stream ? new Response("data: " + JSON.stringify(body) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) : Response.json(body);
    });
    try {
      const response = await chat(key.auth, { stream, dashboard_chat: "sponsored" });
      expect(await response.text()).toContain('"type":"first_chat_no_answer"');
    } finally { stub.mockRestore(); }
    expect((await chat(key.auth, { dashboard_chat: "sponsored" })).status).toBe(409);
  });
}

test("a reasoning-only stream with no finish event still passes through the reply floor", async () => {
  const key = await eligibleKey();
  const floor = h.ctx.anonymo.floor;
  h.ctx.anonymo.floor = { check: async input => input.stage === "reply" && input.text.includes("hidden fixture")
    ? { ok: false, category: "cbrn" } : { ok: true } };
  const body = { choices: [{ index: 0, delta: { reasoning_content: "hidden fixture" } }] };
  const stub = spyOn(network, "providerFetch").mockImplementation(async () => new Response(
    "data: " + JSON.stringify(body) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
  try {
    const response = await chat(key.auth, { stream: true, dashboard_chat: "sponsored" });
    const wire = await response.text();
    expect(wire).toContain('"type":"floor_blocked"');
    expect(wire).not.toContain("hidden fixture");
  } finally { stub.mockRestore(); h.ctx.anonymo.floor = floor; }
  expect((await chat(key.auth, { dashboard_chat: "sponsored" })).status).toBe(409);
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

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hasFundedKey } from "../src/anonymo/freetier/policy.ts";
import { SESSION_KEY, telegramDigest, verifiedInitUser } from "../src/anonymo/telegram/identity.ts";
import { resolveKey } from "../src/api/auth.ts";
import { loadConfig } from "../src/config.ts";
import { anonymoKeys } from "../src/anonymo/deposits/schema.ts";
import { freeTokens, generations, ledger, offers, starsOrders, telegramLinks, telegramTokens } from "../src/db/schema.ts";
import { balanceOf, creditAccount, verifyInvariants } from "../src/ledger/ledger.ts";
import { deployedInventory } from "../src/privacy/inventory.ts";
import { startRouter, type Harness } from "./helpers.ts";

const botToken = "100000:fixture-bot-token"; // gitleaks:allow
const webhookSecret = "fixture-webhook-secret"; // gitleaks:allow
const salt = "fixture-telegram-digest-salt-for-fixtures"; // gitleaks:allow
const env = {
  ANONYMO_FEATURE_TELEGRAM: "true", ANONYMO_TELEGRAM_BOT_TOKEN: botToken, ANONYMO_TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  ANONYMO_TELEGRAM_ID_SALT: salt, ANONYMO_TELEGRAM_TOPUP_STARS: "75", ANONYMO_TELEGRAM_TOPUP_USD: "1.25",
  ANONYMO_FEATURE_COMPLIANCE: "true", ANONYMO_REGION_UNKNOWN_TEXT: "block", ANONYMO_REGION_BLOCKED: "IR",
  ANONYMO_FREE_DAILY: "2", ANONYMO_FREE_POW_DIFFICULTY: "12", SITE_URL: "https://workspace.example",
};
const user = 73_627_124;
const partner = user + 1;
const region = { "cf-ipcountry": "NZ" };
const marker = "A retained prompt would contain this sentence.";
const modelText = "A private reply. Links: https://checkout.example/pay bitcoin:fixture-address.";
const outgoing: { method: string; data: Record<string, any> }[] = [];
const upstream: string[] = [];
const model = { id: "fixture-text", slug: "anonymo-rp", prompt: "0.000001", completion: "0.000001", ctx: 32768 };
let h: Harness;
let network: { mockRestore: () => void };

beforeAll(async () => {
  const originalFetch = globalThis.fetch.bind(globalThis);
  network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.telegram.org") return originalFetch(input, init);
    outgoing.push({ method: url.pathname.split("/").at(-1)!, data: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  }, { preconnect: globalThis.fetch.preconnect }));
  h = await startRouter({
    env, rand: () => 0,
    providers: ["fixture-moderated", "fixture-other"].map((id) => ({ id, name: id, models: [model], reply: () => {
      upstream.push(id);
      return modelText;
    } })),
  });
  await h.ctx.db.update(offers).set({ tier: 1, upstream: "selfhost", isModerated: true, family: "qwen" })
    .where(eq(offers.providerId, "fixture-moderated"));
  await h.ctx.catalog.refresh();
}, 20_000);
afterAll(async () => { await h?.close(); network?.mockRestore(); });

function webhook(update: object, secret = webhookSecret) {
  return h.request("/v1/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, json: update });
}

function msg(textOrEvent: string | object, id = user) {
  const event = typeof textOrEvent === "string" ? { text: textOrEvent } : textOrEvent;
  return webhook({ message: { from: { id }, chat: { id, type: "private" }, ...event } });
}

async function newKey() {
  const r = await h.request("/api/v1/keys", { method: "POST", headers: region, json: {} });
  expect(r.status).toBe(201);
  const data = await r.json() as { key: string; data: { hash: string } };
  return { secret: data.key, hash: data.data.hash, auth: { ...region, authorization: `Bearer ${data.key}` } };
}

async function link(key: Awaited<ReturnType<typeof newKey>>, id = user) {
  const r = await h.request("/v1/telegram/link-code", { method: "POST", headers: key.auth });
  expect(r.status).toBe(201);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const { code } = await r.json() as { code: string };
  expect((await msg(code, id)).status).toBe(200);
  return code;
}

function initData(id: number, seconds = Math.floor(Date.now() / 1000)) {
  const fields = new URLSearchParams({ auth_date: String(seconds), user: JSON.stringify({ id, first_name: "sample-user" }), query_id: "fixture" });
  fields.sort();
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  fields.set("hash", createHmac("sha256", secret).update([...fields].map(([k, v]) => `${k}=${v}`).join("\n")).digest("hex"));
  return fields.toString();
}

const mini = (action: string, input: object = {}, id = user, edge = region, init = initData(id)) =>
  h.request("/v1/telegram/mini", { method: "POST", headers: edge, json: { init_data: init, action, ...input } });

async function proof(id = user) {
  const r = await mini("challenge", { adult: true }, id);
  expect(r.status).toBe(200);
  const puzzle = await r.json() as { challenge: string; difficulty: number; remaining: number; model: string };
  expect(puzzle.model).toBe("anonymo-rp");
  for (let nonce = 0; ; nonce++) {
    if (!(createHash("sha256").update(`${puzzle.challenge}:${nonce}`).digest().readUInt32BE() >>> (32 - puzzle.difficulty)))
      return `${puzzle.challenge}:${nonce}:0`;
  }
}

test("the flag defaults off and the webhook rejects bad secrets before processing an update", async () => {
  const cfg = loadConfig({ ANONYMO_ENV: "test", ANONYMO_FEATURE_TELEGRAM: false });
  expect(cfg.features.telegram).toBe(false);
  const off = await startRouter({ providers: [] });
  try { expect((await off.request("/v1/telegram/webhook", { method: "POST" })).status).toBe(404); }
  finally { await off.close(); }
  const count = outgoing.length;
  const rejected = await webhook({ message: { text: "/help", chat: { id: user, type: "private" }, from: { id: user } } }, "wrong");
  expect(rejected.status).toBe(401);
  expect(outgoing).toHaveLength(count);
  expect((await msg("/help")).status).toBe(200);
  expect(outgoing.at(-1)?.data.text).toContain("Telegram keeps messages sent here. The full app is where nobody keeps the chat.");
  expect((await msg("/start")).status).toBe(200);
  expect(outgoing.at(-1)?.data.reply_markup.inline_keyboard[0][0].web_app.url).toBe("https://workspace.example/telegram/mini");
});

test("Stars invoice credits the issued key exactly once through duplicate payments, relinking and refunds", async () => {
  const key = await newKey();
  const initialCode = await link(key);
  await msg(initialCode, partner);
  expect(await h.ctx.db.select().from(telegramLinks)).toEqual([{
    telegramHash: telegramDigest(salt, "user", String(user)), keyHash: key.hash,
  }]);
  await msg("/topup");
  const invoice = outgoing.at(-1)!;
  expect(invoice.method).toBe("sendInvoice");
  expect(invoice.data).toMatchObject({ currency: "XTR", provider_token: "", prices: [{ amount: 75 }] });
  expect(invoice.data.payload).not.toContain(key.hash);
  expect(invoice.data.payload.length).toBeLessThan(129);

  const checkout = async (id: number, total_amount: number, payload = invoice.data.payload) => {
    const res = await webhook({ pre_checkout_query: { id: "fixture-checkout", from: { id }, currency: "XTR", total_amount, invoice_payload: payload } });
    expect(res.status).toBe(200);
    expect(outgoing.at(-1)?.method).toBe("answerPreCheckoutQuery");
    return outgoing.at(-1)?.data.ok;
  };
  expect(await checkout(partner, 75)).toBe(false);
  expect(await checkout(user, 74)).toBe(false);
  expect(await checkout(user, 75, "wrong")).toBe(false);
  expect(await checkout(user, 75)).toBe(true);
  expect(await h.ctx.db.select().from(starsOrders)).toHaveLength(0);

  const next = await newKey();
  await link(next);
  expect(await checkout(user, 75)).toBe(false);
  const payment = { currency: "XTR", total_amount: 75, invoice_payload: invoice.data.payload, telegram_payment_charge_id: "fixture-charge" };
  expect((await msg({ successful_payment: payment }, partner)).status).toBe(200);
  expect(await h.ctx.db.select().from(starsOrders)).toHaveLength(0);
  const completed = await Promise.all(Array.from({ length: 8 }, () => msg({ successful_payment: payment })));
  expect(completed.every((r) => r.status === 200)).toBe(true);
  const original = (await resolveKey(h.ctx, key.secret))!;
  const other = (await resolveKey(h.ctx, next.secret))!;
  expect((await balanceOf(h.ctx.db, original.accountId)).balance).toBe(1_250_000_000_000n);
  expect((await balanceOf(h.ctx.db, other.accountId)).balance).toBe(0n);
  expect(await hasFundedKey(h.ctx, original)).toBe(true);
  const balance = await h.request("/balance", { headers: key.auth });
  expect(await balance.json()).toMatchObject({ available_usd: 1.25, usage_only_usd: 1.25, withdraw_to: [] });

  const wallet = "0xabababababababababababababababababababab"; // gitleaks:allow
  await h.ctx.db.insert(anonymoKeys).values({ keyHash: key.hash, wallet });
  const payout = await h.request("/withdraw", {
    method: "POST", headers: key.auth, json: { chain: "base", to: wallet, idempotency_key: "fixture-withdraw" },
  });
  expect(payout.status).toBe(402);
  expect(await payout.json()).toMatchObject({ error: { type: "nothing_to_withdraw" } });

  const refunded = await Promise.all(Array.from({ length: 4 }, () => msg({ refunded_payment: payment })));
  expect(refunded.every((r) => r.status === 200)).toBe(true);
  await msg({ successful_payment: payment });
  expect((await balanceOf(h.ctx.db, original.accountId)).balance).toBe(0n);
  expect(await hasFundedKey(h.ctx, original)).toBe(false);

  const early = { ...payment, telegram_payment_charge_id: "fixture-refund-first" };
  await msg({ refunded_payment: early });
  await msg({ successful_payment: early });
  const orders = await h.ctx.db.select().from(starsOrders);
  expect(orders).toHaveLength(2);
  expect(orders.every((order) => !!order.refundedAt)).toBe(true);
  const entries = await h.ctx.db.select({ kind: ledger.kind, amount: ledger.amount }).from(ledger).where(eq(ledger.keyHash, key.hash));
  expect(entries).toEqual([{ kind: "stars_credit", amount: 1_250_000_000_000n }, { kind: "stars_refund", amount: -1_250_000_000_000n }]);
  expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
});

test("handoff tokens are short-lived, one-use capabilities and unlink revokes the chat session", async () => {
  const key = await newKey();
  await link(key, partner);
  await msg("/open", partner);
  const url = new URL(outgoing.at(-1)?.data.reply_markup.inline_keyboard[0][0].url);
  expect(url.pathname).toBe("/telegram/handoff");
  expect(url.search).toBe("");
  const token = new URLSearchParams(url.hash.slice(1)).get("handoff")!;
  const exchange = (value: string) => h.request("/v1/telegram/handoff", { method: "POST", headers: region, json: { token: value } });
  const replies = await Promise.all(Array.from({ length: 5 }, () => exchange(token)));
  expect(replies.map((r) => r.status).sort()).toEqual([200, 410, 410, 410, 410]);
  const session = await replies.find((r) => r.ok)!.json() as { key: string; key_hash: string };
  expect(session.key).toMatch(SESSION_KEY);
  expect(session.key_hash).toBe(key.hash);
  const headers = { ...region, authorization: `Bearer ${session.key}` };
  const balance = await h.request("/balance", { headers });
  expect(await balance.json()).toMatchObject({ withdraw_to: [], available_usd: 0 });
  for (const path of ["/withdraw", "/deposits/btcpay", "/v1/telegram/link-code", "/api/v1/keys"]) {
    expect((await h.request(path, { method: "POST", headers, json: {} })).status).toBe(403);
  }
  const original = (await resolveKey(h.ctx, key.secret))!;
  await creditAccount(h.ctx.db, { accountId: original.accountId, keyHash: key.hash, amount: 1_000_000_000_000n, kind: "credit", ref: "fixture-handoff-credit" });
  const body = { model: "anonymo-rp", messages: [{ role: "user", content: "Hello from the handoff." }] };
  const chat = () => h.request("/v1/chat/completions", { method: "POST", headers, json: body });
  expect((await chat()).status).toBe(200);
  await h.ctx.db.insert(anonymoKeys).values({ keyHash: key.hash, sealedOnly: true });
  expect((await chat()).status).toBe(403);
  await msg("/open", partner);
  const expiredUrl = new URL(outgoing.at(-1)?.data.reply_markup.inline_keyboard[0][0].url);
  await h.ctx.db.update(telegramTokens).set({ expiresAt: new Date(0) }).where(eq(telegramTokens.kind, "handoff"));
  expect((await exchange(new URLSearchParams(expiredUrl.hash.slice(1)).get("handoff")!)).status).toBe(410);
  await msg("/unlink", partner);
  expect((await h.request("/balance", { headers })).status).toBe(401);
  expect((await h.request("/balance", { headers: key.auth })).status).toBe(200);
});

test("Mini App verifies a recent Telegram signature and gates chat by region and an adult declaration", async () => {
  const signed = initData(user);
  expect(verifiedInitUser(signed, botToken)).toBe(user);
  expect(verifiedInitUser(signed + "&auth_date=1", botToken)).toBeNull();
  expect(verifiedInitUser(initData(user, 1), botToken)).toBeNull();
  expect(verifiedInitUser(signed.replace("fixture", "tampered"), botToken)).toBeNull();
  expect((await mini("verify")).status).toBe(200);
  expect((await mini("verify", {}, user, region, "fake")).status).toBe(401);
  expect((await mini("challenge")).status).toBe(400);
  expect((await mini("challenge", { adult: true }, user, { "cf-ipcountry": "IR" })).status).toBe(451);
  expect((await mini("challenge", { adult: true }, user, { "cf-ipcountry": "GB" })).status).toBe(451);
  expect((await mini("challenge", { adult: true }, user, { ...region, "x-anonymo-declared-region": "IR" })).status).toBe(451);
  expect((await mini("challenge", { adult: true }, user, {} as typeof region)).status).toBe(451);
});

test("bot and Mini App share one daily trial, spend zero, and only use the moderated lane", async () => {
  const id = user + 20;
  upstream.length = 0;
  const work = await proof(id);
  expect((await mini("chat", { adult: true, work, text: marker }, id + 1)).status).toBe(403);
  expect((await mini("arm", { adult: true, work }, id)).status).toBe(200);
  expect((await msg(marker, id)).status).toBe(200);
  expect(outgoing.at(-1)?.data.text).toContain("1 free today");
  expect(outgoing.at(-1)?.data.text).not.toMatch(/https?:|bitcoin:|checkout\.example/);
  expect(outgoing.at(-1)?.data.text).toContain("A private reply.");
  expect((await mini("chat", { adult: true, work, text: marker }, id)).status).toBe(409);
  const next = await proof(id);
  const response = await mini("chat", { adult: true, work: next, text: marker }, id);
  expect(await response.json()).toEqual({ text: modelText, remaining: 0 });
  expect(upstream).toEqual(["fixture-moderated", "fixture-moderated"]);
  const exhausted = await mini("challenge", { adult: true }, id);
  expect(await exhausted.json()).toMatchObject({ challenge: null, remaining: 0 });
  const quota = Buffer.from(telegramDigest(salt, "free", telegramDigest(salt, "user", String(id))), "hex");
  const [counter] = await h.ctx.db.select().from(freeTokens).where(eq(freeTokens.deviceToken, quota));
  expect(counter.used).toBe(2);
  const rows = await h.ctx.db.select().from(generations).where(and(eq(generations.modelId, "anonymo-rp"), eq(generations.mode, "free")));
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.cost === 0n && !r.accountId)).toBe(true);
  const kept = JSON.stringify({ rows, links: await h.ctx.db.select().from(telegramLinks), tokens: await h.ctx.db.select().from(telegramTokens) },
    (_, value) => typeof value === "bigint" ? value.toString() : value);
  for (const markerOfPrivacy of [marker, modelText, String(id), work, initData(id), "sample-user"]) expect(kept).not.toContain(markerOfPrivacy);
});

test("a floor block returns 451 before routing and never consumes free allowance", async () => {
  const id = user + 21;
  const work = await proof(id);
  const floor = h.ctx.anonymo.floor;
  const upstreamBefore = upstream.length;
  h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "minor" }) };
  try {
    const rejected = await mini("chat", { adult: true, work, text: marker }, id);
    expect(rejected.status).toBe(451);
    expect(await rejected.json()).toMatchObject({ error: { type: "floor_blocked" } });
    expect(upstream).toHaveLength(upstreamBefore);
    expect(await (await mini("challenge", { adult: true }, id)).json()).toMatchObject({ remaining: 2 });
  } finally { h.ctx.anonymo.floor = floor; }
});

test("the Telegram-only deployed inventory includes trial quotas and hides the feature while off", () => {
  const on = deployedInventory({ ventures: false, telegram: true });
  const off = deployedInventory({ ventures: false, telegram: false });
  const names = (doc: typeof on) => doc.postgres.tables.map((t) => t.name);
  expect(names(on)).toEqual(expect.arrayContaining(["free_tokens", "stars_orders", "telegram_links", "telegram_tokens"]));
  for (const name of ["free_tokens", "stars_orders", "telegram_links", "telegram_tokens"]) expect(names(off)).not.toContain(name);
  expect(JSON.stringify(on.outside_postgres)).toContain('"limiter_prefix":"telegram:"');
  expect(JSON.stringify(off.outside_postgres)).not.toContain('"limiter_prefix":"telegram:"');
});

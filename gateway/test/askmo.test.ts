import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { askMoQuery, checkedAnswer, needsCitations } from "../src/anonymo/askmo/answer.ts";
import { CHECKLIST, REGION_NOTES, TOPIC_PACKS, type Topic } from "../src/anonymo/askmo/packs.ts";
import { BRAVE_ENDPOINT } from "../src/anonymo/search/brave.ts";
import { TAVILY_ENDPOINT } from "../src/anonymo/search/tavily.ts";
import { createWebSearch } from "../src/anonymo/search/config.ts";
import type { FloorGate } from "../src/anonymo/seams.ts";
import { accounts, apps, generations, holds, keys } from "../src/db/schema.ts";
import { sha256 } from "../src/lib/util.ts";
import { questions } from "./fixtures/askmo.ts";
import { startRouter, type Harness } from "./helpers.ts";

const QUERY = "query-canary What records do I need for my taxes?";
const ANSWER = "answer-canary The records identify the tax year [1].";
const UNSOURCED = "A sentence with no citation.";
const SOURCE = "source-canary record keeping";
const checks = (topic: Topic) => `## ${CHECKLIST}\n- ${TOPIC_PACKS[topic].checks.replace(/\.$/, "")} [1].`;
const REGION = `## ${REGION_NOTES}\nCheck whether local rules apply [1].`;
const COMPARISON = { agree: "agreement-canary The proposals agree about collecting records.", disagree: "A suggests checking timing first. B and C start with location." };
const allow: FloorGate = { check: async () => ({ ok: true }) };
const block = { ok: false, category: "cbrn" } as const;

function standIn(provider: "brave" | "tavily", priceUsd: string) {
  return createWebSearch({ ANONYMO_WEB_SEARCH: { provider, apiKey: "demo-search-token", priceUsd } }, fakeSearch)!; // gitleaks:allow
}

let searches: { provider: string; query: string | null; headers: Headers }[] = [];
let brave: "ok" | "error" | "empty" = "ok";
let tavilyEmpty = false;
const fakeSearch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input.toString());
  const record = { provider: url.origin, headers: new Headers(init?.headers), query: url.searchParams.get("q") };
  searches.push(record);
  if (url.origin === new URL(TAVILY_ENDPOINT).origin) {
    record.query = JSON.parse(String(init?.body)).query;
    return Response.json({ results: tavilyEmpty ? [] : [{ url: "https://example.org/tax", title: SOURCE, content: "Tavily result." }] });
  }
  if (brave === "error") return new Response("private query echo", { status: 502 });
  return Response.json({ web: { results: brave === "empty" ? [] : [{ url: "https://example.org/tax", title: SOURCE, description: "Brave result." }] } });
}) as typeof fetch;

const councilModels = ["deepseek/deepseek-test", "qwen/qwen-test", "google/gemma-test"];
const model = (id: string, slug: string, price = "0.000001") => ({ id, slug, prompt: price, completion: price });
const providers = councilModels.map((slug, i) => ({
  id: `sample-${i}`,
  name: `Sample ${i}`,
  models: [model(`council-${i}`, slug), model(`ask-${i}`, "anonymo-1", String((i + 1) / 1000000))],
  reply: (prompt: string, body: any) => {
    if (prompt.includes("Valid winners")) return JSON.stringify({ winner: "B", reason: "Clearest", ...COMPARISON });
    if (body.model.startsWith("council")) return `Proposal ${i} compares local rules.`;
    if (prompt.includes("double refusal canary") || (i === 0 && prompt.includes("reroute canary"))) return "I can't help with that request.";
    const pack = Object.entries(TOPIC_PACKS).find(([, value]) => body.messages[0].content.includes(value.checks));
    return `${UNSOURCED} ${ANSWER} Hallucinated source [99].${pack ? `\n\n${checks(pack[0] as Topic)}\n\n${REGION}` : ""}`;
  },
}));

let h: Harness;
let auth: Record<string, string>;
let keyHash: string;

const ask = (body: Record<string, unknown> = { question: QUERY }, path = "/v1/ask", headers: Record<string, string> = {}) =>
  h.request(path, { method: "POST", headers: { ...auth, ...headers }, json: body });
const calls = () => Object.values(h.mocks).reduce((total, { stats }) => total + stats.requests, 0);
const held = async () => (await h.ctx.db.select().from(holds).where(eq(holds.status, "held"))).length;
async function balance() {
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, keyHash));
  const [account] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, key.accountId));
  return account.balance;
}

describe("Ask Mo citation checks", () => {
  test("drops uncited sentences and made-up, escaped or linked markers", () => {
    const text = [
      "Unsourced. Kept [1]. Removed [99].",
      "- Valid [2] and invalid [42]. uncited lower-case sentence.",
      "Invalid [0]. Escaped \\[1]. A [1](https://example.org/link).",
      "No link [3]. A sentence [1] ends here. Uncited!",
      "根拠があります [1]。根拠なし。",
      `## ${CHECKLIST}\n- No citation.`,
    ].join("\n");
    expect(checkedAnswer(text, QUERY, 2, "money")).toBe("Kept [1].\n- Valid [2] and invalid .\nA sentence [1] ends here.\n根拠があります [1]。");
  });

  test("keeps explicit drafts, checks mixed requests, and strips identifiers before applying search size limits", () => {
    expect(needsCitations("Draft a polite message to a friend")).toBe(false);
    expect(needsCitations("Draft a letter explaining the law on deposits")).toBe(true);
    expect(checkedAnswer("Would you like to talk?", "Draft a polite message", 1, null)).toBe("Would you like to talk?");
    const { length } = askMoQuery("tax ".repeat(1000));
    expect(length).toBeLessThanOrEqual(400);
    expect(askMoQuery("tax ".repeat(1000)).split(" ")).toHaveLength(50);
    expect(askMoQuery("tax +1 202-555-0123 192.0.2.4 2001:db8::1 @sample-user https://example.org/private deductions")).toBe("tax deductions"); // gitleaks:allow
  });

  test("default-off mounts neither route and ignores fallback configuration", async () => {
    const off = await startRouter({ providers: [], env: { ANONYMO_ASK_MO_SEARCH_FALLBACK: "invalid-json" } });
    try {
      for (const path of ["/v1/ask", "/v1/ask/second-opinion"]) {
        const result = await off.request(path, { method: "POST", json: { question: QUERY } });
        expect(result.status).toBe(404);
      }
    } finally {
      await off.close();
    }
  });
});

describe("Ask Mo through the gateway", () => {
  beforeAll(async () => {
    h = await startRouter({ providers, rand: () => 0, env: {
      ANONYMO_FEATURE_ASK_MO: "true",
      ANONYMO_COUNCIL_MODELS: councilModels.join(","),
      ANONYMO_COUNCIL_JUDGE: councilModels[0],
    } });
    ({ auth, hash: keyHash } = await h.fundedKey(20n));
    for (const offer of h.ctx.catalog.offers("anonymo-1")) {
      const family = councilModels[Number(offer.providerId.split("-").at(-1))].split("/")[0];
      Object.assign(offer, { family });
    }
  });
  afterAll(async () => h?.close());
  beforeEach(() => {
    searches = [];
    brave = "ok";
    tavilyEmpty = false;
    h.ctx.anonymo.search = standIn("brave", "0.005");
    h.ctx.cfg.askMoSearchFallback = standIn("tavily", "0.006");
    h.ctx.anonymo.floor = allow;
  });

  test("requires a key, validates topic, and refuses sealed and zero-balance requests before search", async () => {
    expect((await h.request("/v1/ask", { method: "POST", json: { question: QUERY } })).status).toBe(401);
    expect((await ask({ question: QUERY, topic: "other" })).status).toBe(400);
    expect((await ask({}, "/v1/ask")).status).toBe(400);
    expect((await ask({ question: QUERY }, "/v1/ask", { "x-anonymo-sealed": "required" })).status).toBe(409);
    const unfunded = await h.newKey();
    expect((await ask({ question: QUERY }, "/v1/ask", unfunded.auth)).status).toBe(402);
    expect(searches).toHaveLength(0);
  });

  test("enforces the existing key spend caps before search or council dispatch", async () => {
    const response = await h.request("/keys/caps", { method: "PATCH", headers: auth, json: { daily_usd: "0" } });
    expect(response.status).toBe(200);
    const before = calls();
    try {
      for (const path of ["/v1/ask", "/v1/ask/second-opinion"]) {
        const result = await ask({ question: QUERY }, path);
        expect(result.status).toBe(402);
        expect(await result.json()).toMatchObject({ error: { type: "key_cap_reached" } });
      }
      expect(searches).toHaveLength(0);
      expect(calls()).toBe(before);
    } finally {
      expect((await h.request("/keys/caps", { method: "PATCH", headers: auth, json: { daily_usd: null } })).status).toBe(200);
    }
  });

  test("consumes only a scrubbed query, hashes the checked reply and skips persistence and content export", async () => {
    const enqueue = h.ctx.tracing.enqueue;
    let traces = 0;
    h.ctx.tracing.enqueue = () => { traces++; return true; };
    try {
      await h.ctx.db.update(keys).set({ tracing: { include_content: true } }).where(eq(keys.keyHash, keyHash));
      const result = await ask({ question: QUERY + " @sample-user", user: "caller-canary" }, "/v1/ask", {
        "x-forwarded-for": "192.0.2.4", "user-agent": "client-canary", "x-title": "app-canary", "x-anonymo-cache": "exact", // gitleaks:allow
      });
      const body = await result.json() as any;
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(body.choices[0].message.content).toBe(ANSWER);
      expect(body.choices[0].message.annotations[0].url_citation).toMatchObject({ url: "https://example.org/tax", title: SOURCE });
      expect(body.receipt.payload).toMatchObject({ response_sha256: sha256(ANSWER), web_search: { provider: "brave", price: "0.005" } });
      expect(body.anonymo_receipt.payload.request_id).toBe(body.id);
      expect(searches).toHaveLength(1);
      expect(searches[0].query).toBe(QUERY);
      expect([...searches[0].headers.keys()].sort()).toEqual(["accept", "x-subscription-token"]);
      const [row] = await h.ctx.db.select().from(generations).where(eq(generations.id, body.id));
      const stored = JSON.stringify(row, (_, value) => typeof value === "bigint" ? value.toString() : value);
      for (const canary of ["query-canary", "answer-canary", "source-canary", "caller-canary", "client-canary", "192.0.2.4"]) expect(stored).not.toContain(canary);
      expect(await h.ctx.db.select().from(apps)).toHaveLength(0);
      expect(traces).toBe(0);
    } finally {
      h.ctx.tracing.enqueue = enqueue;
      await h.ctx.db.update(keys).set({ tracing: null }).where(eq(keys.keyHash, keyHash));
    }
  });

  test("tries Brave first even when Private Web Search uses Tavily, charging only the successful engine", async () => {
    h.ctx.anonymo.search = standIn("tavily", "0.006");
    h.ctx.cfg.askMoSearchFallback = standIn("brave", "0.005");
    brave = "error";
    const result = await ask();
    expect(result.status).toBe(200);
    const json = await result.json() as any;
    expect(searches.map((call) => call.provider)).toEqual([new URL(BRAVE_ENDPOINT).origin, new URL(TAVILY_ENDPOINT).origin]);
    expect(searches[1].query).toBe(QUERY);
    expect([...searches[1].headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(json.receipt.payload.web_search).toEqual({ provider: "tavily", price: "0.006", searches: 1, results: 1 });
    expect(await held()).toBe(0);
  });

  test("reroutes a refused attempt and bills zero if the retry also refuses", async () => {
    const reroute = await ask({ question: "reroute canary What records count?" });
    expect(reroute.status).toBe(200);
    const body = await reroute.json() as any;
    expect(body.choices[0].message.content).toBe(ANSWER);
    expect(body.anonymo_receipt.payload.routes).toMatchObject([{ status: "refused", cost: "0" }, { status: "ok" }]);
    expect(searches).toHaveLength(1);

    const before = await balance();
    const double = await ask({ question: "double refusal canary What records count?" });
    expect(double.status).toBe(200);
    const refused = await double.json() as any;
    expect(refused.anonymo_receipt.payload).toMatchObject({ refused: true, cost: "0" });
    expect(await balance()).toBe(before);
    expect(await held()).toBe(0);
  });

  test("falls back on empty results and releases the hold when neither provider finds sources", async () => {
    brave = "empty";
    tavilyEmpty = true;
    const before = calls();
    const result = await ask();
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { type: "ask_mo_no_sources" } });
    expect(searches).toHaveLength(2);
    expect(calls()).toBe(before);
    expect(await held()).toBe(0);
  });

  test("floor blocks before search, before model dispatch for blocked snippets, and before returning the reply", async () => {
    const before = calls();
    h.ctx.anonymo.floor = { check: async () => block };
    expect((await ask()).status).toBe(451);
    expect(searches).toHaveLength(0);
    h.ctx.anonymo.floor = { check: async (input) => input.text.includes(SOURCE) ? block : { ok: true } };
    expect((await ask()).status).toBe(451);
    expect(searches).toHaveLength(1);
    expect(calls()).toBe(before);
    h.ctx.anonymo.floor = { check: async (input) => input.stage === "reply" ? block : { ok: true } };
    const reply = await ask();
    expect(reply.status).toBe(451);
    expect(await reply.json()).toMatchObject({ error: { type: "floor_blocked", metadata: { stage: "reply" } } });
    expect(calls()).toBe(before + 1);
    expect(await held()).toBe(0);
  });

  test("runs Second Opinion as council select with three families and no extra search or stored summary", async () => {
    const result = await ask({ question: QUERY, topic: "money" }, "/v1/ask/second-opinion", { "x-anonymo-council-mode": "merge" });
    expect(result.status).toBe(200);
    const json = await result.json() as any;
    expect(json.council).toMatchObject({ mode: "select", selected: "B", comparison: COMPARISON });
    expect(new Set(json.council.proposers.map((seat: any) => seat.family)).size).toBe(3);
    expect(json.council.proposers.every((seat: any) => seat.status === "ok")).toBe(true);
    expect(json.anonymo_receipt.payload.routes.map((seat: any) => seat.role)).toEqual(["proposer", "proposer", "proposer", "judge"]);
    expect(searches).toHaveLength(0);
    const [row] = await h.ctx.db.select().from(generations).where(eq(generations.id, json.id));
    expect(JSON.stringify(row, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("agreement-canary");
  });

  test("blocks council replies before settlement, and never passes a blocked proposal to the judge", async () => {
    h.ctx.anonymo.floor = { check: async (input) => input.stage === "reply" && input.text.includes("Proposal 1") ? block : { ok: true } };
    const before = calls();
    expect((await ask({ question: QUERY }, "/v1/ask/second-opinion")).status).toBe(451);
    expect(calls()).toBe(before + 3);
    expect(await held()).toBe(0);
    h.ctx.anonymo.floor = { check: async (input) => input.stage === "reply" && input.text.includes("agreement-canary") ? block : { ok: true } };
    expect((await ask({ question: QUERY }, "/v1/ask/second-opinion")).status).toBe(451);
    expect(calls()).toBe(before + 7);
    expect(await held()).toBe(0);
  });

  test.each(Object.entries(questions) as [Topic, string[]][])("%s eval fixtures return sources and a checklist", async (topic, fixtures) => {
    expect(fixtures).toHaveLength(10);
    for (const question of fixtures) {
      const result = await ask({ question, topic });
      expect(result.status).toBe(200);
      const json = await result.json() as any;
      expect(json.choices[0].message.content).toContain(checks(topic));
      expect(json.choices[0].message.content).toContain(`## ${REGION_NOTES}`);
      expect(json.choices[0].message.annotations).not.toHaveLength(0);
    }
  }, 15000);
});

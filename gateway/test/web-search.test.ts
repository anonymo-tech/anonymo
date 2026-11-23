// Private Web Search: `:online`, `plugins: [{ id: "web" }]` and `web_search_options` search the web through the gateway's
// own engine (ANONYMO_WEB_SEARCH, Brave behind a mocked fetch here: no real search API is ever called). The floor reads
// the prompt before any query leaves; sealed, attested and private requests never search; a failed search charges
// nothing; a served one is charged the fixed price once and receipted; the query and results are never logged or stored.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { holds, keys, ledger } from "../src/db/schema.ts";
import { setLogLevel } from "../src/lib/util.ts";
import { usdToPico } from "../src/lib/money.ts";
import { createWebSearch, parseWebSearchConfig } from "../src/anonymo/search/config.ts";
import { citationsFor, searchQueryOf, stripOnline, takeWebSearch } from "../src/anonymo/search/chat.ts";
import { BRAVE_ENDPOINT } from "../src/anonymo/search/brave.ts";
import { TAVILY_ENDPOINT } from "../src/anonymo/search/tavily.ts";
import type { FloorGate } from "../src/anonymo/seams.ts";
import { MODELS, sse, startRouter, type Harness } from "./helpers.ts";

const MODEL = MODELS.llama.slug;
const QUERY = "ws-query-canary-4e1d which river runs through the old town";
const RESULT_TITLE = "ws-result-title-canary-91ac";
const RESULT_SNIPPET = "ws-result-snippet-canary-c07b";
const API_KEY = "test-brave-token-not-real";

type Call = { url: URL; headers: Headers; method: string };
let calls: Call[] = [];
let mode: "ok" | "fail" | "hang" | "empty" = "ok";

/** A stand-in for the Brave API: records what it was sent and answers like it. */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push({ url, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
  if (mode === "fail") return new Response("upstream says no", { status: 500 });
  if (mode === "hang")
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true }));
  const results = mode === "empty" ? [] : [
    { title: `<strong>${RESULT_TITLE}</strong> one`, url: "https://example.org/one", description: `First ${RESULT_SNIPPET} &amp; more` },
    { title: "Second source", url: "https://example.net/two", description: "Second snippet" },
    { title: "Not a web link", url: "javascript:alert(1)", description: "dropped" },
    { title: "Third source", url: "https://example.com/three", description: "Third snippet" },
  ];
  return Response.json({ type: "search", web: { results } });
}) as typeof fetch;

const service = (extra: Record<string, unknown> = {}) =>
  createWebSearch({ ANONYMO_WEB_SEARCH: JSON.stringify({ provider: "brave", apiKey: API_KEY, maxResults: 3, ...extra }) }, fakeFetch);

const allow: FloorGate = { check: async () => ({ ok: true }) };
const block: FloorGate = { check: async () => ({ ok: false, category: "cbrn" }) };

let h: Harness;
let key: { auth: Record<string, string>; hash: string };
let accountId: string;

const providerRequests = () => Object.values(h.mocks).reduce((n, m) => n + m.stats.requests, 0);
const lastBody = () => h.mocks.alpha.stats.lastBody;
const balance = async () => {
  const rows = await h.ctx.db.select({ amount: ledger.amount }).from(ledger).where(eq(ledger.accountId, accountId));
  return rows.reduce((s, r) => s + BigInt(r.amount as unknown as bigint), 0n);
};
const openHolds = async () => (await h.ctx.db.select({ id: holds.id }).from(holds).where(eq(holds.status, "held"))).length;
const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...headers }, json: { messages: [{ role: "user", content: QUERY }], ...body } });

beforeAll(async () => {
  h = await startRouter({
    providers: [{
      id: "alpha",
      name: "Alpha",
      models: [MODELS.llama, MODELS.qwen],
      // Cites the sources when the gateway injected them, so citations can be checked against the text.
      reply: (_prompt, body) =>
        (body?.messages ?? []).some((m: any) => m?.role === "system" && String(m.content).startsWith("Web search results"))
          ? "The river is named in [1] and again in [2]."
          : "No sources were given.",
    }],
  });
  key = await h.fundedKey(20n);
  const [row] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, key.hash));
  accountId = row.accountId;
  h.ctx.anonymo.floor = allow;
});
afterAll(async () => h?.close());
beforeEach(() => {
  calls = [];
  mode = "ok";
  h.ctx.anonymo.search = service();
  h.ctx.anonymo.floor = allow;
});

describe("triggers", () => {
  test("model suffix :online searches, strips the suffix and injects numbered sources", async () => {
    const res = await chat({ model: `${MODEL}:online` });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const sent = lastBody();
    expect(String(sent.model)).not.toContain("online");
    const sys = sent.messages.filter((m: any) => m.role === "system");
    expect(sys.length).toBe(1);
    expect(sys[0].content).toContain(`[1] ${RESULT_TITLE} one`);
    expect(sys[0].content).toContain("URL: https://example.org/one");
    expect(sys[0].content).toContain(`First ${RESULT_SNIPPET} & more`);
    expect(sys[0].content).toContain("[3] Third source"); // the javascript: link was dropped
    expect(sys[0].content).not.toContain("javascript:");
    expect(sys[0].content).toMatch(/cite .* \[1\]/);
    expect(sent.messages.at(-1)).toEqual({ role: "user", content: QUERY }); // the user's turn is untouched and last
  });

  test("plugins: [{ id: \"web\" }] searches, honours max_results, and plugins never reach the provider", async () => {
    const res = await chat({ model: MODEL, plugins: [{ id: "web", max_results: 2 }] });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url.searchParams.get("count")).toBe("2");
    expect(lastBody().plugins).toBeUndefined();
    const j = (await res.json()) as any;
    expect(j.choices[0].message.annotations.length).toBe(2);
  });

  test("web_search_options searches and is not forwarded", async () => {
    const res = await chat({ model: MODEL, web_search_options: { search_context_size: "low" } });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(lastBody().web_search_options).toBeUndefined();
  });

  test("an :online model in `models` searches too", async () => {
    const res = await chat({ model: MODEL, models: [`${MODELS.qwen.slug}:online`] });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  test("no trigger, or a disabled web plugin, never searches", async () => {
    expect((await chat({ model: MODEL })).status).toBe(200);
    expect((await chat({ model: MODEL, plugins: [{ id: "web", enabled: false }] })).status).toBe(200);
    expect(calls.length).toBe(0);
    expect(lastBody().messages.some((m: any) => m.role === "system")).toBe(false);
  });
});

describe("what leaves the gateway", () => {
  test("only the query, a count and the token go to the engine: no caller headers, ids or IPs", async () => {
    const res = await chat({ model: `${MODEL}:online`, user: "sample-user" }, { "user-agent": "ProbeAgent/1.0", "x-forwarded-for": "198.51.100.7", cookie: "s=1" });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const c = calls[0];
    expect(`${c.url.origin}${c.url.pathname}`).toBe(BRAVE_ENDPOINT);
    expect(c.method).toBe("GET");
    expect(c.url.searchParams.get("q")).toBe(QUERY);
    expect([...c.url.searchParams.keys()].sort()).toEqual(["count", "q", "safesearch", "text_decorations"]);
    expect([...c.headers.keys()].sort()).toEqual(["accept", "x-subscription-token"]);
    expect(c.headers.get("x-subscription-token")).toBe(API_KEY);
    expect(c.url.toString()).not.toContain("sample-user");
    expect(c.url.toString()).not.toContain("198.51.100.7");
  });
});

describe("refusals before any search", () => {
  test("unconfigured: 501 web_search_unavailable, nothing sent, held or charged", async () => {
    h.ctx.anonymo.search = null;
    const [reqs, before] = [providerRequests(), await balance()];
    const res = await chat({ model: `${MODEL}:online` });
    expect(res.status).toBe(501);
    expect(((await res.json()) as any).error.type).toBe("web_search_unavailable");
    expect(providerRequests()).toBe(reqs);
    expect(await openHolds()).toBe(0);
    expect(await balance()).toBe(before);
  });

  test("a floor block is 451 and no query leaves the gateway", async () => {
    h.ctx.anonymo.floor = block;
    const reqs = providerRequests();
    for (const body of [{ model: `${MODEL}:online` }, { model: MODEL, plugins: [{ id: "web" }] }, { model: MODEL, web_search_options: {} }, { model: `${MODEL}:online`, stream: true }]) {
      const res = await chat(body);
      expect(res.status).toBe(451);
    }
    expect(calls.length).toBe(0);
    expect(providerRequests()).toBe(reqs);
  });

  test("sealed, attested, :private and provider.private requests are refused before any search", async () => {
    const reqs = providerRequests();
    const cases: [Record<string, unknown>, Record<string, string>][] = [
      [{ model: `${MODEL}:online` }, { "x-anonymo-sealed": "required" }],
      [{ model: "anonymo-sealed:online" }, {}],
      [{ model: `${MODEL}:private:online` }, {}],
      [{ model: `${MODEL}:online:private` }, {}],
      [{ model: MODEL, plugins: [{ id: "web" }], provider: { private: true } }, {}],
      [{ model: MODEL, web_search_options: {}, provider: { lane: "attested" } }, {}],
    ];
    for (const [body, headers] of cases) {
      const res = await chat(body, headers);
      const j = (await res.json()) as any;
      expect([409, 400]).toContain(res.status);
      expect(["web_search_private", "sealed_unavailable"]).toContain(j.error.type);
    }
    expect(calls.length).toBe(0);
    expect(providerRequests()).toBe(reqs);
    expect(await openHolds()).toBe(0);
  });

  test("council mode, dual verification and legacy completions are refused before any search", async () => {
    const council = await chat({ model: "anonymo-council", plugins: [{ id: "web" }] });
    expect(council.status).toBe(400);
    expect(((await council.json()) as any).error.type).toBe("web_search_unsupported");
    const dual = await chat({ model: `${MODEL}:online`, verify: "dual" });
    expect(dual.status).toBe(400);
    const completion = await h.request("/api/v1/completions", { method: "POST", headers: key.auth, json: { model: `${MODEL}:online`, prompt: QUERY } });
    expect(completion.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

describe("search failure", () => {
  test("an engine error is 502 web_search_failed, nothing reaches a model and nothing is charged", async () => {
    mode = "fail";
    const [reqs, before] = [providerRequests(), await balance()];
    const res = await chat({ model: `${MODEL}:online` });
    expect(res.status).toBe(502);
    const j = (await res.json()) as any;
    expect(j.error.type).toBe("web_search_failed");
    expect(JSON.stringify(j)).not.toContain("ws-query-canary");
    expect(providerRequests()).toBe(reqs);
    expect(await openHolds()).toBe(0);
    expect(await balance()).toBe(before);
  });

  test("a hanging engine times out (502) and the stream never starts", async () => {
    mode = "hang";
    h.ctx.anonymo.search = service({ timeoutMs: 500 });
    const [reqs, before] = [providerRequests(), await balance()];
    const res = await chat({ model: `${MODEL}:online`, stream: true });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(providerRequests()).toBe(reqs);
    expect(await openHolds()).toBe(0);
    expect(await balance()).toBe(before);
  });
});

describe("citations and billing", () => {
  test("JSON: url_citation annotations, the price charged once and receipted", async () => {
    const before = await balance();
    const res = await chat({ model: `${MODEL}:online` });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    const msg = j.choices[0].message;
    expect(msg.content).toBe("The river is named in [1] and again in [2].");
    expect(msg.annotations).toEqual([
      { type: "url_citation", url_citation: { url: "https://example.org/one", title: `${RESULT_TITLE} one`, start_index: 22, end_index: 25 } },
      { type: "url_citation", url_citation: { url: "https://example.net/two", title: "Second source", start_index: 39, end_index: 42 } },
      { type: "url_citation", url_citation: { url: "https://example.com/three", title: "Third source" } },
    ]);
    expect(msg.content.slice(22, 25)).toBe("[1]");
    // Usage and receipt show the search price; the ledger moved by exactly the charge, once.
    expect(j.usage.cost_details.web_search).toBe(0.005);
    expect(j.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    expect(j.receipt.payload.web_search).toEqual({ provider: "brave", searches: 1, results: 3, price: "0.005" });
    const parts = j.receipt.payload.cost_details;
    const charged = usdToPico(j.receipt.payload.cost);
    expect(charged).toBe(usdToPico(parts.upstream) + usdToPico(parts.royalty) + usdToPico(parts.margin) + usdToPico("0.005"));
    expect(before - (await balance())).toBe(charged);
    const settles = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `settle:${j.id}`));
    expect(settles.length).toBe(1);
    // The receipt holds counts and a price, never the query or the results.
    expect(JSON.stringify(j.receipt)).not.toContain("ws-");
  });

  test("the hold covers the search price and the injected results", async () => {
    const res = await chat({ model: `${MODEL}:online` });
    const j = (await res.json()) as any;
    const [row] = await h.ctx.db.select({ amount: holds.amount }).from(holds).where(eq(holds.id, j.id));
    const held = BigInt(row.amount as unknown as bigint);
    expect(held).toBeGreaterThan(usdToPico("0.005"));
  });

  test("stream: annotations on the last chunk's delta, then usage with the search price", async () => {
    const before = await balance();
    const res = await chat({ model: `${MODEL}:online`, stream: true });
    expect(res.status).toBe(200);
    const { events, done } = await sse(res);
    expect(done).toBe(true);
    const text = events.map((e: any) => e.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toBe("The river is named in [1] and again in [2].");
    const withCites = events.filter((e: any) => e.choices?.[0]?.delta?.annotations);
    expect(withCites.length).toBe(1);
    const final = events.at(-1) as any;
    expect(events.indexOf(withCites[0])).toBe(events.length - 2); // the last chunk before usage and the receipt
    const ann = withCites[0].choices[0].delta.annotations;
    expect(ann[0]).toEqual({ type: "url_citation", url_citation: { url: "https://example.org/one", title: `${RESULT_TITLE} one`, start_index: 22, end_index: 25 } });
    expect(final.usage.cost_details.web_search).toBe(0.005);
    expect(final.receipt.payload.web_search.searches).toBe(1);
    expect(before - (await balance())).toBe(usdToPico(final.receipt.payload.cost));
  });

  test("no results still answers (the model is told), and the search is charged", async () => {
    mode = "empty";
    const res = await chat({ model: `${MODEL}:online` });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(lastBody().messages[0].content).toContain("no results");
    expect(j.choices[0].message.annotations).toBeUndefined();
    expect(j.usage.cost_details.web_search).toBe(0.005);
  });

  test("a provider failure after the search refunds everything, the search price included", async () => {
    const before = await balance();
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behaviour: "error500" }) });
    try {
      const res = await chat({ model: `${MODEL}:online` });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(calls.length).toBe(1);
      expect(await openHolds()).toBe(0);
      expect(await balance()).toBe(before);
    } finally {
      await fetch(h.mocks.alpha.url + "/_control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behaviour: "ok" }) });
    }
  });
});

describe("never logged or stored", () => {
  test("no query or result text in any log line or database table", async () => {
    const lines: string[] = [];
    const [log, err, warn] = [console.log, console.error, console.warn];
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    setLogLevel("debug");
    try {
      expect((await chat({ model: `${MODEL}:online` })).status).toBe(200);
      expect((await chat({ model: `${MODEL}:online`, stream: true })).status).toBe(200);
      mode = "fail";
      expect((await chat({ model: `${MODEL}:online` })).status).toBe(502);
    } finally {
      setLogLevel("error");
      [console.log, console.error, console.warn] = [log, err, warn];
    }
    expect(lines.some((l) => l.includes("web search failed"))).toBe(true); // the failure is logged, by reason only
    for (const l of lines) {
      expect(l).not.toContain("ws-query-canary");
      expect(l).not.toContain("ws-result");
      expect(l).not.toContain(API_KEY);
    }
    const res = await h.ctx.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
    const tables = (((res as { rows?: unknown[] }).rows ?? res) as { table_name: string }[]).map((r) => r.table_name);
    for (const t of tables) {
      const r = await h.ctx.db.execute(sql.raw(`select * from "${t.replace(/"/g, '""')}"`));
      const dump = JSON.stringify((r as { rows?: unknown[] }).rows ?? r, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
      expect(dump).not.toContain("ws-query-canary");
      expect(dump).not.toContain("ws-result");
      expect(dump).not.toContain("example.org/one");
    }
  });
});

describe("parsing", () => {
  test("stripOnline removes the suffix wherever it sits among the suffixes", () => {
    expect(stripOnline("a/b:online")).toBe("a/b");
    expect(stripOnline("a/b:online:nitro")).toBe("a/b:nitro");
    expect(stripOnline("a/b:private:online")).toBe("a/b:private");
    expect(stripOnline("a/b")).toBeNull();
    expect(stripOnline("a/b:free")).toBeNull();
  });

  test("takeWebSearch strips every trigger and keeps other plugins", () => {
    const body: Record<string, unknown> = { model: "a/b:online", plugins: [{ id: "web", max_results: 9 }, { id: "other" }], web_search_options: {} };
    expect(takeWebSearch(body)).toEqual({ via: "model_suffix", maxResults: 9 });
    expect(body).toEqual({ model: "a/b", plugins: [{ id: "other" }] });
    expect(takeWebSearch({ model: "a/b" })).toBeNull();
    expect(takeWebSearch({ model: "a/b", web_search_options: { search_context_size: "high" } })).toEqual({ via: "web_search_options", maxResults: 10 });
  });

  test("the query is the last user message, trimmed and capped", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join("   ");
    const q = searchQueryOf({ messages: [{ role: "user", content: "old" }, { role: "assistant", content: "x" }, { role: "user", content: [{ type: "text", text: `  ${long}\n` }] }] });
    expect(q.split(" ").length).toBe(50);
    expect(q.length).toBeLessThanOrEqual(400);
    expect(q.startsWith("word0 word1")).toBe(true);
  });

  test("config: unset is off, bad config names the field and never the key", () => {
    expect(parseWebSearchConfig(undefined)).toBeNull();
    expect(parseWebSearchConfig("")).toBeNull();
    expect(createWebSearch({})).toBeNull();
    expect(() => parseWebSearchConfig(`{"provider":"brave","apiKey":"${API_KEY}","maxResults":99}`)).toThrow(/maxResults/);
    try {
      parseWebSearchConfig(`{"provider":"other","apiKey":"${API_KEY}"}`);
    } catch (e) {
      expect((e as Error).message).not.toContain(API_KEY);
    }
    expect(() => parseWebSearchConfig(`not json ${API_KEY}`)).toThrow(/must be JSON/);
    const s = createWebSearch({ ANONYMO_WEB_SEARCH: `{"provider":"brave","apiKey":"k"}` })!;
    expect(s.maxResults).toBe(5);
    expect(s.price).toBe(usdToPico("0.005"));
  });

  test("citationsFor marks the first [n] in the text", () => {
    const c = citationsFor("see [2]", [{ title: "a", url: "https://a.example/", snippet: "" }, { title: "b", url: "https://b.example/", snippet: "" }]);
    expect(c[0].url_citation.start_index).toBeUndefined();
    expect(c[1].url_citation).toEqual({ url: "https://b.example/", title: "b", start_index: 4, end_index: 7 });
  });
});

describe("tavily", () => {
  const TAVILY_KEY = "tvly-test-key-not-real";
  type TCall = { url: string; headers: Headers; method: string; body: any };
  let tcalls: TCall[] = [];
  let status = 200;
  const tavilyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    tcalls.push({ url: String(input), headers: new Headers(init?.headers), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
    if (status !== 200) return Response.json({ detail: { error: "upstream says no" } }, { status });
    return Response.json({
      query: "echo",
      results: [
        { title: `${RESULT_TITLE} one`, url: "https://example.org/one", content: `First ${RESULT_SNIPPET} &amp; more`, score: 0.9 },
        { title: "Dup", url: "https://example.org/one", content: "dropped", score: 0.8 },
        { title: "Not a web link", url: "javascript:alert(1)", content: "dropped", score: 0.7 },
        { title: "Second source", url: "https://example.net/two", content: "Second snippet", score: 0.6 },
      ],
      response_time: 0.4,
    });
  }) as typeof fetch;
  const tavily = (extra: Record<string, unknown> = {}) =>
    createWebSearch({ ANONYMO_WEB_SEARCH: JSON.stringify({ provider: "tavily", apiKey: TAVILY_KEY, maxResults: 3, ...extra }) }, tavilyFetch)!;
  beforeEach(() => {
    tcalls = [];
    status = 200;
  });

  test("sends only the query, a count, basic depth and safe search, with the key as a bearer token", async () => {
    h.ctx.anonymo.search = tavily();
    const res = await chat({ model: `${MODEL}:online`, user: "sample-user" }, { "user-agent": "ProbeAgent/1.0", "x-forwarded-for": "198.51.100.7", cookie: "s=1" });
    expect(res.status).toBe(200);
    expect(tcalls.length).toBe(1);
    const c = tcalls[0];
    expect(c.url).toBe(TAVILY_ENDPOINT);
    expect(c.method).toBe("POST");
    expect(c.body).toEqual({ query: QUERY, max_results: 3, search_depth: "basic", topic: "general", include_answer: false, include_raw_content: false, include_images: false, safe_search: true });
    expect([...c.headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(c.headers.get("authorization")).toBe(`Bearer ${TAVILY_KEY}`);
    expect(JSON.stringify(c.body)).not.toContain("sample-user");
    expect(JSON.stringify(c.body)).not.toContain("198.51.100.7");
    const sys = lastBody().messages.filter((m: any) => m.role === "system");
    expect(sys[0].content).toContain(`[1] ${RESULT_TITLE} one`);
    expect(sys[0].content).toContain(`First ${RESULT_SNIPPET} & more`);
    expect(sys[0].content).toContain("[2] Second source"); // duplicate and javascript: links dropped
    expect(sys[0].content).not.toContain("dropped");
    const j = (await res.json()) as any;
    expect(j.receipt.payload.web_search).toEqual({ provider: "tavily", searches: 1, results: 2, price: "0.005" });
  });

  test("safesearch off sends safe_search false", async () => {
    h.ctx.anonymo.search = tavily({ safesearch: "off" });
    expect((await chat({ model: `${MODEL}:online` })).status).toBe(200);
    expect(tcalls[0].body.safe_search).toBe(false);
  });

  test("used-up credits (432) fail the search: 502, nothing sent to a model or charged", async () => {
    h.ctx.anonymo.search = tavily();
    status = 432;
    const [reqs, before] = [providerRequests(), await balance()];
    const res = await chat({ model: `${MODEL}:online` });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("web_search_failed");
    expect(providerRequests()).toBe(reqs);
    expect(await balance()).toBe(before);
    expect(await openHolds()).toBe(0);
  });

  test("config accepts tavily and still refuses other providers", () => {
    expect(parseWebSearchConfig(`{"provider":"tavily","apiKey":"k"}`)?.provider).toBe("tavily");
    expect(() => parseWebSearchConfig(`{"provider":"other","apiKey":"k"}`)).toThrow(/provider/);
  });
});

// WS04 · M3: with mock providers, switching the Venice-tier mock off in the middle of a load run fails no request.
// Venice goes down two ways in one run: first its API starts answering 503, then its host stops answering at all.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startRouter, type Harness } from "./helpers.ts";
import { seedUpstreams } from "../src/providers/tiers.ts";
import { MOCK_UPSTREAMS, mockUpstreamsDoc, runLoad, servedByOf, type MockUpstream } from "../src/routing/load-test.ts";

const KEYS = Object.keys(MOCK_UPSTREAMS) as MockUpstream[];
let h: Harness;
let auth: Record<string, string>;

beforeAll(async () => {
  h = await startRouter({ providers: KEYS.map((k) => ({ id: `mock-${k}`, name: MOCK_UPSTREAMS[k], models: [], live: false, delayMs: 5 })), env: { FIRST_TOKEN_TIMEOUT_MS: "1000" } });
  const urls = Object.fromEntries(KEYS.map((k) => [k, h.mocks[`mock-${k}`].url])) as Record<MockUpstream, string>;
  await seedUpstreams(h.ctx.db, mockUpstreamsDoc(urls, { timeoutMs: 3_000 }), { appSecret: h.ctx.cfg.appSecret, production: false, env: { MOCK_UPSTREAM_KEY: "mock-upstream-key" } });
  await h.ctx.catalog.refresh();
  auth = (await h.fundedKey(200n)).auth;
});
afterAll(async () => h?.close());

test("Venice disabled mid-run: zero failed requests, and the backups take over", async () => {
  const send = async (i: number) => {
    const t = performance.now();
    const stream = i % 3 === 0;
    const res = await h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: "anonymo-1", stream, messages: [{ role: "user", content: `load ${i}` }] } });
    const text = await res.text();
    const content = stream
      ? text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))?.choices?.[0]?.delta?.content ?? "").join("")
      : res.status === 200 ? (JSON.parse(text).choices?.[0]?.message?.content ?? "") : "";
    // A stream that started and then failed still answers 200: count it as failed unless content arrived.
    const status = res.status === 200 && !servedByOf(content) ? 599 : res.status;
    return { status, servedBy: servedByOf(content), ms: performance.now() - t };
  };
  const venice = h.mocks["mock-venice"];
  const report = await runLoad({
    requests: 240,
    concurrency: 16,
    send,
    actions: [
      { at: 0.3, name: "venice-503", run: () => void Object.assign(venice.cfg, { behaviour: "error503" }) },
      { at: 0.6, name: "venice-gone", run: () => venice.stop() },
    ],
  });
  expect(report.failed).toBe(0);
  expect(report.total).toBe(240);
  expect(report.servedBy[MOCK_UPSTREAMS.venice]).toBeGreaterThan(0); // Venice served the start of the run
  expect(report.servedAfter["venice-gone"][MOCK_UPSTREAMS.venice] ?? 0).toBe(0);
  const backups = (report.servedAfter["venice-503"][MOCK_UPSTREAMS.selfhostDeepseek] ?? 0) + (report.servedAfter["venice-503"][MOCK_UPSTREAMS.selfhostMistral] ?? 0);
  expect(backups).toBeGreaterThan(0);
}, 120_000);

// WS04 · Failover load test (M3). Two modes:
//
//   bun scripts/load-failover.ts [--requests 400] [--concurrency 24]
//     Self-contained: mock upstreams (a Venice-tier mock, self-hosted backups, a TEE route, an overflow route) behind an
//     in-memory router. Venice starts answering 503 at 30% of the run and its host disappears at 60%. Exits 1 if any
//     request failed.
//
//   bun scripts/load-failover.ts --url https://gateway.example --key <api key> [--model anonymo-1] [--requests 400]
//     Against a running gateway (the failover drill, WS10): switch the Venice upstream off yourself during the run.
//     Exits 1 if any request failed.
import { parseArgs } from "node:util";
import { runLoad, servedByOf, MOCK_UPSTREAMS, mockUpstreamsDoc, type LoadCall, type MockUpstream } from "../src/routing/load-test.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    key: { type: "string" },
    model: { type: "string", default: "anonymo-1" },
    requests: { type: "string", default: "400" },
    concurrency: { type: "string", default: "24" },
  },
});
const requests = Number(values.requests);
const concurrency = Number(values.concurrency);

const contentOf = (text: string, stream: boolean) =>
  stream
    ? text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => { try { return JSON.parse(l.slice(6))?.choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("")
    : (() => { try { return JSON.parse(text)?.choices?.[0]?.message?.content ?? ""; } catch { return ""; } })();

async function call(fetcher: (body: unknown) => Promise<Response>, i: number, model: string): Promise<LoadCall> {
  const t = performance.now();
  const stream = i % 3 === 0;
  const res = await fetcher({ model, stream, max_tokens: 32, messages: [{ role: "user", content: `failover drill ${i}` }] });
  const text = await res.text();
  const content = res.status === 200 ? contentOf(text, stream) : "";
  // A stream that began and then broke still has status 200: it counts as failed when no content arrived.
  return { status: res.status === 200 && !content ? 599 : res.status, servedBy: servedByOf(content) ?? (content ? "upstream" : null), ms: performance.now() - t };
}

if (values.url) {
  if (!values.key) throw new Error("--key is required with --url");
  const endpoint = values.url.replace(/\/$/, "") + "/api/v1/chat/completions";
  const report = await runLoad({
    requests,
    concurrency,
    send: (i) => call((body) => fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${values.key}`, "content-type": "application/json" }, body: JSON.stringify(body) }), i, values.model!),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.failed ? 1 : 0);
}

// The test harness (pglite, a fake chain for funded keys, mock servers). Loaded by a computed path: test/ is outside the
// typechecked sources.
type Harness = {
  ctx: import("../src/context.ts").Ctx;
  mocks: Record<string, { url: string; cfg: Record<string, unknown>; stop: () => void }>;
  request: (path: string, init: RequestInit & { json?: unknown }) => Promise<Response>;
  fundedKey: (usdg?: bigint) => Promise<{ auth: Record<string, string> }>;
  close: () => Promise<void>;
};
const helpers = "../test/helpers.ts";
const { startRouter } = (await import(helpers)) as { startRouter: (opts: unknown) => Promise<Harness> };
const { seedUpstreams } = await import("../src/providers/tiers.ts");
const keys = Object.keys(MOCK_UPSTREAMS) as MockUpstream[];
const h = await startRouter({ providers: keys.map((k) => ({ id: `mock-${k}`, name: MOCK_UPSTREAMS[k], models: [], live: false, delayMs: 5 })), env: { FIRST_TOKEN_TIMEOUT_MS: "1000" } });
try {
  const urls = Object.fromEntries(keys.map((k) => [k, h.mocks[`mock-${k}`].url])) as Record<MockUpstream, string>;
  await seedUpstreams(h.ctx.db, mockUpstreamsDoc(urls, { timeoutMs: 3_000 }), { appSecret: h.ctx.cfg.appSecret, production: false, env: { MOCK_UPSTREAM_KEY: "mock-upstream-key" } });
  await h.ctx.catalog.refresh();
  const { auth } = await h.fundedKey(1_000n);
  const venice = h.mocks["mock-venice"];
  const report = await runLoad({
    requests,
    concurrency,
    send: (i) => call((body) => h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: body }), i, values.model!),
    actions: [
      { at: 0.3, name: "venice-503", run: () => void Object.assign(venice.cfg, { behaviour: "error503" }) },
      { at: 0.6, name: "venice-gone", run: () => venice.stop() },
    ],
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failed ? 1 : 0;
} finally {
  await h.close();
}

// B116: human links use the site address; signed and protocol URLs keep the router address.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { privacyLabel } from "../src/privacy/label.ts";
import { atomFeed, rssFeed } from "../src/services/slo.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";

const router = "https://router.example";
const site = "https://anonymo.tech";
const env = { PUBLIC_BASE_URL: router };
let h: Harness;
let fallback: Harness;
beforeAll(async () => {
  h = await startRouter({ env: { ...env, SITE_URL: site } });
  fallback = await startRouter({ env });
});
afterAll(async () => { await h?.close(); await fallback?.close(); });

const rpc = (app: Harness, name: string, args: unknown) => app.request("/mcp", {
  method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
});

test("SITE_URL is opt-in and leaves protocol configuration unchanged", () => {
  const original = loadConfig({ ANONYMO_ENV: "test", PUBLIC_BASE_URL: router + "/" });
  const explicit = loadConfig({ ANONYMO_ENV: "test", PUBLIC_BASE_URL: router + "/", SITE_URL: router + "/" });
  expect(original).toEqual(explicit);
  const configured = loadConfig({ ANONYMO_ENV: "test", PUBLIC_BASE_URL: router, SITE_URL: site + "/" });
  expect(configured.siteUrl).toBe(site);
  expect(configured.publicUrl).toBe(router);
  expect(configured.chain).toEqual(original.chain);
});

for (const configured of [true, false]) test(`receipt read links and signed payloads (${configured ? "SITE_URL" : "unset"})`, async () => {
  const app = configured ? h : fallback;
  const owner = await app.fundedKey();
  const path = "/api/v1/chat/completions";
  const json = { model: MODELS.llama.slug, messages: [{ role: "user", content: "Hello" }], max_tokens: 20 };
  expect((await app.request(path, { method: "POST", headers: { authorization: "Bearer invalid-key" }, json })).status).toBe(401);
  const call = await app.request(path, { method: "POST", headers: owner.auth, json });
  expect(call.status).toBe(200);
  const id = call.headers.get("x-receipt-id")!;
  await call.text();
  const receiptPath = `/api/v1/receipts/${id}`;
  const response = await app.request(receiptPath); // Public by receipt id, as before.
  expect(response.status).toBe(200);
  const bytes = await response.text();
  const { data } = JSON.parse(bytes);
  expect(data.privacy.verify_url).toBe(`${configured ? site : router}/verify?r=${id}`);
  expect(data.privacy.verify_url).toStartWith(`${configured ? site : router}/verify`);
  expect(data.payload.router).toBe(router);
  expect(data.v2.claims.iss).toBe(router);
  expect(await app.ctx.signer.verify(data.payload, data.sig, data.key_id)).toBe(true);
  const signed = JSON.stringify({ payload: data.payload, sig: data.sig, v2: data.v2 });
  expect((await (await app.request(`${receiptPath}/privacy`)).json()).data).toEqual(data.privacy);
  expect((await (await rpc(app, "get_receipt", { id })).json()).result.structuredContent.privacy.verify_url).toBe(data.privacy.verify_url);
  const savedSite = app.ctx.cfg.siteUrl;
  try {
    app.ctx.cfg.siteUrl = router;
    const legacyBytes = await (await app.request(receiptPath)).text();
    const legacy = JSON.parse(legacyBytes);
    expect(legacy.data.privacy).toEqual(privacyLabel(data, { baseUrl: router }));
    expect(JSON.stringify({ payload: legacy.data.payload, sig: legacy.data.sig, v2: legacy.data.v2 })).toBe(signed);
    if (!configured) expect(bytes).toBe(legacyBytes);
  } finally { app.ctx.cfg.siteUrl = savedSite; }
  expect((await app.request("/api/v1/receipts/unknown")).status).toBe(404);
});

test("MCP provider verification opens the site without requiring authentication", async () => {
  const result = (await (await rpc(h, "verify_provider", { provider_id: "alpha" })).json()).result.structuredContent;
  expect(result.verify_page).toBe(`${site}/verify?p=alpha`);
  const original = await (await rpc(fallback, "verify_provider", { provider_id: "alpha" })).text();
  fallback.ctx.cfg.siteUrl = router;
  expect(await (await rpc(fallback, "verify_provider", { provider_id: "alpha" })).text()).toBe(original);
});


test("status feeds separate human links from API identifiers and self links, with identical defaults", async () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const incident = { id: "inc_sample", title: "Service update", status: "investigating", impact: "minor", lanes: ["public"], surfaces: [], started_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), resolved_at: null, updates: [] } as Parameters<typeof atomFeed>[1][number];
  for (const feed of [atomFeed, rssFeed]) {
    expect(feed(router, [incident], now, fallback.ctx.cfg.siteUrl)).toBe(feed(router, [incident], now));
    const bytes = feed(router, [incident], now, site);
    expect(bytes).toContain(`${site}/status/#incident-inc_sample`);
    expect(bytes).toContain(`${router}/api/v1/status/incidents.`);
    expect(bytes).not.toContain(`${router}/status/`);
  }
  for (const format of ["atom", "rss"]) {
    const response = await h.request(`/api/v1/status/incidents.${format}`);
    expect(response.status).toBe(200);
    const bytes = await response.text();
    expect(bytes).toContain(`${site}/status/`);
    expect(bytes).toContain(`${router}/api/v1/status/incidents.${format}`);
  }
});


test("unset SITE_URL preserves status-feed normalization with extra trailing slashes", async () => {
  const original = { publicUrl: fallback.ctx.cfg.publicUrl, siteUrl: fallback.ctx.cfg.siteUrl };
  const config = loadConfig({ ANONYMO_ENV: "test", PUBLIC_BASE_URL: router + "//" });
  fallback.ctx.cfg.publicUrl = config.publicUrl;
  fallback.ctx.cfg.siteUrl = config.siteUrl;
  try {
    for (const format of ["atom", "rss"]) {
      const bytes = await (await fallback.request(`/api/v1/status/incidents.${format}`)).text();
      expect(bytes).toContain(`${router}/status/`);
      expect(bytes).toContain(`${router}/api/v1/status/incidents.${format}`);
      expect(bytes).not.toContain(`${router}//status/`);
    }
  } finally { Object.assign(fallback.ctx.cfg, original); }
});

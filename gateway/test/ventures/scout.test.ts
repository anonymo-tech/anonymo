// WS11 · Scout sandbox against the fictional "Ledgerly" fixture site (Ventures Backend spec, PART 4, Law 4).
// The fixture server logs every request, so the never-list is proved on the wire, not only in Scout's own report.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { scoutSite, SCOUT_USER_AGENT, type BrowserDriver, type ScoutResult } from "../../src/anonymo/ventures/scout/index.ts";
import { loadPlaywrightDriver } from "../../src/anonymo/ventures/scout/browser.ts";
import { fixtureFetch, startFixtureSite, type FixtureSite } from "./fixtures/saas/server.ts";

const NOW = () => new Date("2026-11-20T12:00:00Z");
let site: FixtureSite;
let run: ScoutResult;
const sleeps: number[] = [];
const fetched: string[] = [];

beforeAll(async () => {
  site = startFixtureSite();
  run = await scoutSite({
    url: `${site.origin}/`,
    fetch: fixtureFetch(site.origin, fetched),
    now: NOW,
    limits: { delayMs: 5 },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    reviewUrls: [`${site.origin}/reviews-feed`],
  });
});
afterAll(() => site?.stop());

const paths = () => site.log.map((r) => r.path);
const stopFor = (path: string) => run.stops.filter((s) => new URL(s.url).pathname + new URL(s.url).search === path).map((s) => s.reason);

test("login and signup pages are never requested, even through a redirect; their links are noted as stops", () => {
  for (const p of paths()) expect(p).not.toMatch(/^\/(login|signup|account)/);
  expect(stopFor("/login")).toEqual(["guard:login"]);
  expect(stopFor("/signup")).toEqual(["guard:signup"]);
  expect(stopFor("/signup?plan=sprout")).toEqual(["guard:signup"]);
  expect(stopFor("/account/settings")).toEqual(["guard:account"]);
  expect(paths()).toContain("/app");
  expect(stopFor("/login?next=/app")).toEqual(["guard:login"]);
});

test("no form is submitted except the single-input GET search; every request is a GET with the honest UA", () => {
  expect(site.log.every((r) => r.method === "GET")).toBe(true);
  expect(site.log.every((r) => r.ua === SCOUT_USER_AGENT)).toBe(true);
  expect(paths()).toContain("/search?q=export");
  expect(paths().filter((p) => p.startsWith("/contact"))).toEqual(["/contact"]);
});

test("a captcha page stops its branch and is not kept", () => {
  expect(stopFor("/beta")).toEqual(["captcha:recaptcha"]);
  expect(paths()).not.toContain("/beta/secret");
  expect(run.artifacts.some((a) => a.meta.url === `${site.origin}/beta`)).toBe(false);
});

test("paywalls stop their branch (HTTP 402 and a subscribe-to-continue marker)", () => {
  expect(stopFor("/guides/pro")).toEqual(["paywall:402"]);
  expect(stopFor("/guides/members")).toEqual(["paywall:marker"]);
});

test("robots.txt is respected for * and for AnonymoScout, and its Crawl-delay is honoured", () => {
  expect(paths()[0]).toBe("/robots.txt");
  expect(paths().some((p) => p.startsWith("/private"))).toBe(false);
  expect(paths().some((p) => p.startsWith("/internal"))).toBe(false);
  expect(stopFor("/private/roadmap")).toEqual(["robots"]);
  expect(stopFor("/internal/status")).toEqual(["robots"]);
  expect(run.analysis.robots.crawlDelayMs).toBe(10);
  expect(sleeps.length).toBeGreaterThan(5);
  expect(sleeps.every((ms) => ms === 10)).toBe(true);
});

test("same-site only: off-site links are recorded (job board) but never fetched", () => {
  expect(fetched.some((u) => u.includes("greenhouse"))).toBe(false);
  expect(run.analysis.jobs.map((j) => new URL(j.url).hostname)).toEqual(["boards.greenhouse.io"]);
  expect(run.targetHosts).toEqual([site.host]);
});

test("artifacts: pages, bundles, a public source map (sources and content only), sitemap and HAR, all SCOUT zone", () => {
  expect(run.artifacts.every((a) => a.ref.zone === "SCOUT" && /^[0-9a-f]{64}$/.test(a.ref.sha256))).toBe(true);
  const kinds = new Set(run.artifacts.map((a) => `${a.ref.kind}:${a.meta.type}`));
  for (const k of ["page:html", "page:sitemap", "page:robots", "bundle:js", "bundle:css", "bundle:source-map", "bundle:deminified", "har:har", "page:csv", "page:archive-snapshot"]) expect(kinds.has(k)).toBe(true);
  const map = run.artifacts.find((a) => a.meta.type === "source-map")!;
  expect(Object.keys(JSON.parse(String(map.body))).sort()).toEqual(["sources", "sourcesContent"]);
  const har = JSON.parse(String(run.artifacts.find((a) => a.meta.type === "har")!.body));
  expect(har.log.entries.length).toBe(site.log.length);
  expect(run.analysis.sitemaps).toEqual([`${site.origin}/sitemap.xml`]);
});

test("review pages are read for themes only: no review text is stored anywhere", () => {
  expect(run.analysis.themes.map((t) => t.id)).toEqual(expect.arrayContaining(["price", "support", "import-export", "mobile"]));
  const all = run.artifacts.map((a) => (typeof a.body === "string" ? a.body : new TextDecoder().decode(a.body))).join("\n");
  expect(all).not.toContain("too expensive for a solo studio");
  expect(JSON.stringify(run.analysis)).not.toContain("too expensive for a solo studio");
});

test("analysis: pricing grid, API shapes, OSS, CSV format, archive history and flows", () => {
  const a = run.analysis;
  expect(a.pricing?.plans.map((p) => [p.name, p.priceUsdMonthly])).toEqual([["Free", 0], ["Sprout", 19], ["Business", 49]]);
  expect(a.apis.map((x) => `${x.method} ${x.path}`)).toContain("GET /api/v1/invoices/:id");
  expect(a.apis.find((x) => x.path === "/api/v1/invoices/:id" && x.method === "GET")?.seenIn).toEqual(["bundle", "probe"]);
  expect(a.oss.map((o) => [o.name, o.licence])).toEqual([["minidate", "ISC"], ["tinychart", "MIT"], ["tinytable", null]]);
  expect(a.formats[0].fields).toEqual(["invoice_number", "customer", "amount", "currency", "status", "issued_at", "due_date"]);
  expect(fetched).toContain(`https://web.archive.org/cdx/search/cdx?url=${site.host}/pricing&output=json&limit=50`);
  expect(a.archive?.captures.map((c) => c.timestamp)).toEqual(["20250115000000", "20260301000000"]);
  expect(a.archive?.grids[0].grid.plans.map((p) => p.priceUsdMonthly)).toEqual([0, 15, 39]);
  const checkout = a.flows.find((f) => f.name === "checkout")!;
  expect(checkout.states.map((s) => [s.id, s.kind])).toEqual([["/", "page"], ["/pricing", "choice"], ["/signup", "action"]]);
  expect(a.flows.find((f) => f.name === "settings")!.states.map((s) => s.id)).toEqual(["/", "/docs", "/docs/settings", "/account/settings"]);
  expect(a.screenshots).toBe(0);
});

test("budgets: max pages and max bytes stop the crawl and say why", async () => {
  const small = startFixtureSite();
  try {
    const r = await scoutSite({ url: `${small.origin}/`, fetch: fixtureFetch(small.origin), now: NOW, limits: { delayMs: 0, maxPages: 2 }, sleep: async () => {}, archive: false });
    expect(r.analysis.pages.length).toBe(2);
    expect(r.stops.some((s) => s.reason === "max-pages")).toBe(true);
    const tiny = await scoutSite({ url: `${small.origin}/`, fetch: fixtureFetch(small.origin), now: NOW, limits: { delayMs: 0, maxBytes: 3000 }, sleep: async () => {}, archive: false });
    expect(tiny.stops.some((s) => s.reason === "max-bytes")).toBe(true);
  } finally {
    small.stop();
  }
});

test("optional browser: HAR and screenshots at 375/768/1440; blocked URLs never reach the page", async () => {
  const small = startFixtureSite();
  const allowed: Record<string, boolean> = {};
  const driver: BrowserDriver = {
    async capture(url, { widths, allow }) {
      for (const u of [`${small.origin}/login`, `${small.origin}/private/x`, "https://cdn.elsewhere.test/a.js", `${small.origin}/api/v1/me/plan`]) allowed[u] = allow(u);
      return {
        har: url.endsWith("/")
          ? [{ method: "GET", url: `${small.origin}/api/v1/projects/42`, status: 200, mimeType: "application/json", bytes: 40, startedAt: "", timeMs: 1, resourceType: "fetch", responseBody: '{"id":"42","title":"Sample","archived":false}' }]
          : [],
        screenshots: widths.map((width) => ({ width, png: new Uint8Array([137, 80, 78, 71, width & 255]) })),
      };
    },
    async close() {},
  };
  try {
    const r = await scoutSite({ url: `${small.origin}/`, fetch: fixtureFetch(small.origin), now: NOW, limits: { delayMs: 0 }, sleep: async () => {}, archive: false, browser: driver, browserPages: 2 });
    expect(r.analysis.screenshots).toBe(6);
    expect(r.artifacts.filter((a) => a.ref.kind === "screenshot").map((a) => a.meta.width)).toEqual([375, 768, 1440, 375, 768, 1440]);
    expect(allowed).toEqual({ [`${small.origin}/login`]: false, [`${small.origin}/private/x`]: false, "https://cdn.elsewhere.test/a.js": false, [`${small.origin}/api/v1/me/plan`]: false });
    const api = r.analysis.apis.find((x) => x.path === "/api/v1/projects/:id")!;
    expect(api.seenIn).toEqual(["har"]);
    expect(api.response).toEqual([{ name: "id", type: "id" }, { name: "title", type: "string" }, { name: "archived", type: "boolean" }]);
    expect(r.analysis.entities.map((e) => e.name)).toContain("Project");
    expect(r.artifacts.some((a) => a.meta.source === "browser")).toBe(true);
  } finally {
    small.stop();
  }
});

test("the Playwright driver is optional: a missing playwright-core gives null, not an error", async () => {
  expect(
    await loadPlaywrightDriver(async () => {
      throw new Error("Cannot find package 'playwright-core'");
    }),
  ).toBeNull();
  expect(await loadPlaywrightDriver(async () => ({ chromium: { launch: async () => Promise.reject(new Error("no browser")) } }))).toBeNull();
});

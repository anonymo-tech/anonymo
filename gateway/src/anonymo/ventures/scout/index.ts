// WS11 · Scout sandbox entry point (Ventures Backend spec, PART 4 "Scout sandbox (internet, logged-out)", Law 4).
//
// scoutSite crawls a target's public pages logged-out and returns SCOUT-zone artifacts (pages, bundles, source maps,
// sitemaps, HAR, screenshots) plus a structured analysis for the Spec Filter. It never signs up, logs in, submits a form
// other than a single-input GET search, solves a captcha or passes a paywall; each branch it refuses is listed in
// `stops` with the reason.

import type { Llm } from "../llm.ts";
import { apisFromHar, entitiesFromResponses, findBundleCalls, mergeApis } from "./apis.ts";
import { fetchArchiveHistory } from "./archive.ts";
import { SCREENSHOT_WIDTHS, loadPlaywrightDriver, type BrowserDriver } from "./browser.ts";
import { collectBundles } from "./bundles.ts";
import { crawlPages, createFetcher, loadRobots, loadSitemaps, scoutArtifact } from "./crawl.ts";
import { formatFromFile, formatsInPage, mergeFormats } from "./formats.ts";
import { mapFlows } from "./flows.ts";
import { htmlToText } from "./html.ts";
import { findOss } from "./oss.ts";
import { extractPricing, looksLikePricingPath } from "./pricing.ts";
import { isJobLink, llmReviewThemes, reviewThemes } from "./reviews.ts";
import { DEFAULT_LIMITS, SCOUT_USER_AGENT, type ApiObservation, type FetchLike, type ScoutAnalysis, type ScoutArtifact, type ScoutLimits, type Stop } from "./types.ts";

export * from "./types.ts";
export { guardUrl, detectCaptcha, detectPaywall } from "./guards.ts";
export { parseRobots } from "./robots.ts";
export { prettyPrintJs } from "./bundles.ts";
export { generalisePath, findBundleCalls, inferFields } from "./apis.ts";
export { extractPricing, parsePrice } from "./pricing.ts";
export { cdxUrl, parseCdx } from "./archive.ts";
export { findOss, licenceHeaders } from "./oss.ts";
export { reviewThemes } from "./reviews.ts";
export { loadPlaywrightDriver, SCREENSHOT_WIDTHS, type BrowserDriver, type BrowserCapture } from "./browser.ts";
export { htmlToText } from "./html.ts";

export type ScoutOptions = {
  url: string;
  fetch: FetchLike;
  now: () => Date;
  limits?: Partial<ScoutLimits>;
  llm?: Llm;
  /** A driver, "auto" to try playwright-core, or omitted/null for fetch-only. */
  browser?: BrowserDriver | "auto" | null;
  /** Pages captured by the browser (each at three widths). */
  browserPages?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Wayback CDX pricing history; on by default. */
  archive?: boolean | { limit?: number; snapshots?: number };
  /** Public review pages the caller chose. Read for themes only; their text is never kept. */
  reviewUrls?: string[];
};

export type ScoutResult = { artifacts: ScoutArtifact[]; analysis: ScoutAnalysis; stops: Stop[]; targetHosts: string[] };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function scoutSite(o: ScoutOptions): Promise<ScoutResult> {
  const start = new URL(o.url);
  start.hash = "";
  const origin = start.origin;
  const limits: ScoutLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const f = createFetcher({ origin, fetch: o.fetch, now: o.now, sleep: o.sleep ?? defaultSleep, limits });
  const artifacts: ScoutArtifact[] = [];

  const robots = await loadRobots(f, origin);
  f.setRobots(robots.robots);
  if (robots.artifact) artifacts.push(robots.artifact);
  const maps = await loadSitemaps(f, origin, robots.robots);
  artifacts.push(...maps.artifacts);

  const crawl = await crawlPages(f, start.toString(), maps.urls);
  artifacts.push(...crawl.artifacts);
  const { pages } = crawl;

  const bundles = await collectBundles(
    f,
    pages.flatMap((p) => p.scripts),
    pages.flatMap((p) => p.stylesheets),
    pages.flatMap((p) => p.inlineScripts),
  );
  artifacts.push(...bundles.artifacts);

  const fileFormats = [];
  for (const csv of crawl.csvLinks) {
    const r = await f.get(csv, "asset");
    if (!r || r.status !== 200) continue;
    artifacts.push(scoutArtifact("page", r.text, { type: "csv", url: csv, contentType: r.contentType }, new URL(csv).pathname));
    const fmt = formatFromFile(csv, r.text);
    if (fmt) fileFormats.push(fmt);
  }

  // API shapes from bundle call sites, then GET probes of literal public URLs for response shapes.
  const jsTexts = bundles.texts.filter((b) => b.type === "js");
  const calls = jsTexts.flatMap((b) => [b.text, ...b.mapped]).flatMap((t) => findBundleCalls(t, origin));
  const observed: ApiObservation[] = calls.map((c) => ({ method: c.method, path: c.path, ...(c.request.length ? { request: c.request } : {}), seenIn: ["bundle" as const] }));
  const probeUrls = new Set<string>();
  for (const c of calls) {
    if (c.method !== "GET" || !c.concrete) continue;
    const u = new URL(c.concrete, origin).toString();
    if (probeUrls.has(u)) continue;
    probeUrls.add(u);
    const r = await f.get(u, "api");
    if (r && (r.status === 401 || r.status === 403)) f.stop(u, `auth-required:${r.status}`);
  }
  const probeEntries = f.har.filter((e) => probeUrls.has(e.url));
  observed.push(...apisFromHar(probeEntries, f.sameSite, "probe"));
  const samples = probeEntries.filter((e) => e.status === 200 && e.responseBody).flatMap((e) => {
    try {
      return [{ path: new URL(e.url).pathname, json: JSON.parse(e.responseBody!) as unknown }];
    } catch {
      return [];
    }
  });

  // Optional browser: HAR and screenshots at three widths, for the first pages crawled.
  let screenshots = 0;
  const driver = o.browser === "auto" ? await loadPlaywrightDriver() : (o.browser ?? null);
  const browserHar = [];
  if (driver) {
    const allow = (u: string) => f.precheck(u, "asset") === null;
    try {
      for (const p of pages.slice(0, o.browserPages ?? 3)) {
        const cap = await driver.capture(p.url, { widths: SCREENSHOT_WIDTHS, allow, userAgent: SCOUT_USER_AGENT });
        const at = o.now().toISOString();
        const har = cap.har.filter((e) => allow(e.url)).map((e) => ({ ...e, startedAt: at }));
        browserHar.push(...har);
        for (const s of cap.screenshots) {
          artifacts.push(scoutArtifact("screenshot", s.png, { type: "screenshot", url: p.url, width: s.width, contentType: "image/png" }, `${new URL(p.url).pathname}@${s.width}`));
          screenshots++;
        }
      }
    } finally {
      await driver.close().catch(() => {});
    }
    observed.push(...apisFromHar(browserHar, f.sameSite, "har"));
    for (const e of browserHar)
      if (e.responseBody && /json/.test(e.mimeType) && f.sameSite(e.url))
        try {
          samples.push({ path: new URL(e.url).pathname, json: JSON.parse(e.responseBody) as unknown });
        } catch {
          /* not JSON */
        }
    if (browserHar.length) artifacts.push(scoutArtifact("har", JSON.stringify(toHar(browserHar)), { type: "har", source: "browser", contentType: "application/json" }, "browser.har"));
  }

  // Pricing: prefer a pricing-looking path, else the page with the most plans.
  const grids = pages.flatMap((p) => {
    const grid = extractPricing(crawl.roots.get(p.url)!);
    return grid ? [{ path: p.path, grid }] : [];
  });
  const pricing = grids.find((g) => looksLikePricingPath(g.path))?.grid ?? [...grids].sort((a, b) => b.grid.plans.length - a.grid.plans.length)[0]?.grid ?? null;

  let archive = null;
  if (o.archive !== false) {
    const opts = typeof o.archive === "object" ? o.archive : {};
    const a = await fetchArchiveHistory(f, start.host, opts);
    archive = a.history;
    artifacts.push(...a.artifacts);
  }

  let themes = [] as ScoutAnalysis["themes"];
  if (o.reviewUrls?.length) {
    const texts: string[] = [];
    for (const u of o.reviewUrls) {
      const r = f.sameSite(u) ? await f.get(u, "asset") : await f.getExternal(u);
      if (r && r.status === 200) texts.push(/html/.test(r.contentType) ? htmlToText(r.text) : r.text);
    }
    themes = o.llm ? await llmReviewThemes(o.llm, texts) : reviewThemes(texts);
  }

  const jobs = dedupe(pages.flatMap((p) => p.links.filter((l) => isJobLink(l.url, l.label)).map((l) => ({ url: l.url, label: l.label }))));
  const formats = mergeFormats([...pages.flatMap((p) => formatsInPage(crawl.roots.get(p.url)!)), ...fileFormats]);
  const oss = findOss(
    jsTexts.flatMap((b) => [b.text, ...b.mapped]),
    jsTexts.flatMap((b) => b.mapSources),
  );

  artifacts.push(scoutArtifact("har", JSON.stringify(toHar(f.har)), { type: "har", source: "fetch", contentType: "application/json" }, "scout.har"));

  const analysis: ScoutAnalysis = {
    startUrl: start.toString(),
    host: start.host,
    observedAt: o.now().toISOString(),
    pages,
    bundles: bundles.infos,
    apis: mergeApis(observed),
    entities: entitiesFromResponses(samples),
    flows: mapFlows(pages, start.toString()),
    pricing,
    archive,
    jobs,
    themes,
    oss,
    formats,
    sitemaps: maps.sitemaps,
    robots: { found: robots.robots.found, crawlDelayMs: robots.robots.crawlDelayMs },
    screenshots,
    har: [...f.har, ...browserHar],
  };
  return { artifacts, analysis, stops: [...f.stops], targetHosts: [start.host] };
}

function dedupe<T extends { url: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

function toHar(entries: ScoutAnalysis["har"]) {
  return {
    log: {
      version: "1.2",
      creator: { name: "AnonymoScout", version: "1.0" },
      entries: entries.map((e) => ({
        startedDateTime: e.startedAt,
        time: e.timeMs,
        request: { method: e.method, url: e.url, headers: [{ name: "User-Agent", value: SCOUT_USER_AGENT }], ...(e.requestBody ? { postData: { text: e.requestBody } } : {}) },
        response: { status: e.status, content: { mimeType: e.mimeType, size: e.bytes, ...(e.responseBody ? { text: e.responseBody } : {}) } },
        ...(e.resourceType ? { _resourceType: e.resourceType } : {}),
      })),
    },
  };
}

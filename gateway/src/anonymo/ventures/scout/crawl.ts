// WS11 · Scout: the logged-out crawler (Ventures Backend spec, PART 4 and Law 4).
//
// Every request goes through one polite fetcher: same-site only, the never-list checked before the request, robots.txt
// checked before the request, a fixed honest User-Agent, a politeness gap, a page budget and a byte budget. Redirects are
// followed by hand so a redirect into /login is caught before it is requested. The fetcher also writes the HAR.

import { createHash } from "node:crypto";
import type { ArtifactKind } from "../types.ts";
import { detectCaptcha, detectPaywall, guardUrl, hasPasswordField } from "./guards.ts";
import { parseHtml, type HtmlNode } from "./html.ts";
import { analysePage, isSubmittableSearch, resolveUrl } from "./page.ts";
import { allowAllRobots, denyAllRobots, parseRobots, type Robots } from "./robots.ts";
import { SCOUT_USER_AGENT, type FetchLike, type HarEntry, type PageInfo, type ScoutArtifact, type ScoutLimits, type Stop } from "./types.ts";

export const sha256Hex = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");

export function scoutArtifact(kind: ArtifactKind, body: Uint8Array | string, meta: Record<string, unknown>, name?: string): ScoutArtifact {
  return { ref: { sha256: sha256Hex(body), kind, zone: "SCOUT", ...(name ? { name } : {}) }, body, meta };
}

export const siteKey = (host: string) => host.toLowerCase().replace(/^www\./, "");

export type Fetched = { url: string; status: number; contentType: string; bytes: Uint8Array; text: string; headers: Headers };
export type GetKind = "page" | "asset" | "api" | "robots";

export type FetcherOptions = {
  origin: string;
  fetch: FetchLike;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  limits: ScoutLimits;
};

export type Fetcher = ReturnType<typeof createFetcher>;

export function createFetcher(o: FetcherOptions) {
  const site = siteKey(new URL(o.origin).host);
  const stops: Stop[] = [];
  const stopped = new Set<string>();
  const har: HarEntry[] = [];
  const lastAt = new Map<string, number>();
  let robots: Robots = allowAllRobots();
  let bytesUsed = 0;
  let pages = 0;
  let probes = 0;
  let exhausted: string | null = null;

  const stop = (url: string, reason: string) => {
    const key = `${url} ${reason}`;
    if (stopped.has(key)) return;
    stopped.add(key);
    stops.push({ url, reason });
  };
  const sameSite = (url: string) => {
    try {
      return siteKey(new URL(url).host) === site;
    } catch {
      return false;
    }
  };
  const delayMs = () => Math.max(o.limits.delayMs, robots.crawlDelayMs ?? 0);

  /** Every check that must pass before a target URL may be requested. Returns the stop reason, or null. */
  function precheck(url: string, kind: GetKind, label = ""): string | null {
    if (!sameSite(url)) return "off-site";
    const g = guardUrl(url, label);
    if (g) return `guard:${g}`;
    if (kind !== "robots") {
      const u = new URL(url);
      if (!robots.allowed(u.pathname + u.search)) return "robots";
    }
    return null;
  }

  async function polite(host: string) {
    const last = lastAt.get(host);
    const gap = delayMs();
    if (last !== undefined && gap > 0) {
      const wait = gap - (o.now().getTime() - last);
      if (wait > 0) await o.sleep(wait);
    }
    lastAt.set(host, o.now().getTime());
  }

  async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
    const len = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(len) && len > cap) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }

  /** One raw request (no site checks): used by `get` and, for public archives and review pages, by `getExternal`. */
  async function request(url: string, accept: string): Promise<Fetched | null> {
    if (exhausted) return null;
    await polite(new URL(url).host);
    const started = o.now();
    let res: Response;
    try {
      res = await o.fetch(url, { method: "GET", redirect: "manual", headers: { "user-agent": SCOUT_USER_AGENT, accept } });
    } catch (e) {
      stop(url, `network:${(e as Error).name || "error"}`);
      return null;
    }
    const bytes = await readCapped(res, o.limits.maxBytes - bytesUsed);
    if (!bytes) {
      exhausted = "max-bytes";
      stop(url, "max-bytes");
      return null;
    }
    bytesUsed += bytes.byteLength;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const text = new TextDecoder().decode(bytes);
    const entry: HarEntry = { method: "GET", url, status: res.status, mimeType: contentType, bytes: bytes.byteLength, startedAt: started.toISOString(), timeMs: Math.max(0, o.now().getTime() - started.getTime()) };
    if (/json/.test(contentType) && bytes.byteLength <= 64_000) entry.responseBody = text;
    har.push(entry);
    return { url, status: res.status, contentType, bytes, text, headers: res.headers };
  }

  /** A same-site GET with every guard applied; follows up to five redirects, re-checking each hop. */
  async function get(url: string, kind: GetKind, label = ""): Promise<Fetched | null> {
    let cur = url;
    for (let hop = 0; hop < 6; hop++) {
      const why = precheck(cur, kind, hop === 0 ? label : "");
      if (why) {
        if (why !== "off-site" || hop > 0) stop(cur, why);
        return null;
      }
      if (kind === "page") {
        if (pages >= o.limits.maxPages) {
          stop(cur, "max-pages");
          return null;
        }
        pages++;
      }
      if (kind === "api") {
        if (probes >= o.limits.maxApiProbes) {
          stop(cur, "max-api-probes");
          return null;
        }
        probes++;
      }
      const accept = kind === "page" ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" : kind === "api" ? "application/json" : "*/*";
      const r = await request(cur, accept);
      if (!r) return null;
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        const next = loc ? resolveUrl(loc, cur) : null;
        if (!next) return r;
        if (kind === "page") pages--;
        cur = next;
        continue;
      }
      return r;
    }
    stop(cur, "redirect-loop");
    return null;
  }

  /** A GET to a public, non-target host the caller chose (web archive, review pages): UA, delay and byte budget apply. */
  async function getExternal(url: string): Promise<Fetched | null> {
    const g = guardUrl(url);
    if (g) {
      stop(url, `guard:${g}`);
      return null;
    }
    return request(url, "*/*");
  }

  return {
    get,
    getExternal,
    precheck,
    stop,
    sameSite,
    stops,
    har,
    get robots() {
      return robots;
    },
    setRobots(r: Robots) {
      robots = r;
    },
    get bytesUsed() {
      return bytesUsed;
    },
  };
}

export async function loadRobots(f: Fetcher, origin: string): Promise<{ robots: Robots; artifact: ScoutArtifact | null }> {
  const url = new URL("/robots.txt", origin).toString();
  const r = await f.get(url, "robots");
  if (!r) return { robots: denyAllRobots(), artifact: null };
  if (r.status >= 500) return { robots: denyAllRobots(), artifact: null };
  if (r.status >= 400 || r.status >= 300) return { robots: allowAllRobots(), artifact: null };
  return { robots: parseRobots(r.text), artifact: scoutArtifact("page", r.text, { type: "robots", url, contentType: "text/plain" }, "robots.txt") };
}

export async function loadSitemaps(f: Fetcher, origin: string, robots: Robots): Promise<{ urls: string[]; sitemaps: string[]; artifacts: ScoutArtifact[] }> {
  const queue = robots.sitemaps.length ? [...robots.sitemaps] : [new URL("/sitemap.xml", origin).toString()];
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const artifacts: ScoutArtifact[] = [];
  for (let i = 0; i < queue.length && i < 5; i++) {
    const r = await f.get(queue[i], "asset");
    if (!r || r.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(r.text)) continue;
    sitemaps.push(queue[i]);
    artifacts.push(scoutArtifact("page", r.text, { type: "sitemap", url: queue[i], contentType: "application/xml" }, new URL(queue[i]).pathname));
    const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex\b/i.test(r.text)) queue.push(...locs);
    else urls.push(...locs);
  }
  return { urls, sitemaps, artifacts };
}

export type CrawlResult = {
  pages: PageInfo[];
  roots: Map<string, HtmlNode>;
  artifacts: ScoutArtifact[];
  csvLinks: string[];
  searchProbes: string[];
};

export const SEARCH_PROBE = "export";

/** Breadth-first crawl of public HTML pages. Guarded and disallowed links are noted as stops and never requested. */
export async function crawlPages(f: Fetcher, start: string, seeds: string[]): Promise<CrawlResult> {
  const pages: PageInfo[] = [];
  const roots = new Map<string, HtmlNode>();
  const artifacts: ScoutArtifact[] = [];
  const csvLinks = new Set<string>();
  const searchProbes: string[] = [];
  const seen = new Set<string>();
  const searched = new Set<string>();
  const queue: { url: string; label: string }[] = [{ url: start, label: "" }, ...seeds.map((url) => ({ url, label: "" }))];

  const enqueue = (url: string, label: string) => {
    const norm = resolveUrl(url, start);
    if (!norm || seen.has(norm)) return;
    if (/\.(png|jpe?g|gif|svg|webp|ico|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|zip|pdf|js|css|map)(\?|$)/i.test(new URL(norm).pathname)) return;
    if (/\.(csv|tsv)$/i.test(new URL(norm).pathname)) {
      if (!f.precheck(norm, "asset")) csvLinks.add(norm);
      return;
    }
    const why = f.precheck(norm, "page", label);
    if (why) {
      seen.add(norm);
      if (why !== "off-site") f.stop(norm, why);
      return;
    }
    queue.push({ url: norm, label });
  };

  while (queue.length) {
    const { url, label } = queue.shift()!;
    const norm = resolveUrl(url, start);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const r = await f.get(norm, "page", label);
    if (!r) {
      if (f.stops.some((s) => s.reason === "max-pages" || s.reason === "max-bytes")) break;
      continue;
    }
    const pay = detectPaywall(r.status, r.text);
    if (r.status === 402 || (pay && r.status < 400)) {
      f.stop(norm, `paywall:${pay ?? "402"}`);
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      f.stop(norm, `auth-required:${r.status}`);
      continue;
    }
    if (r.status >= 400) {
      f.stop(norm, `http:${r.status}`);
      continue;
    }
    if (!/html/.test(r.contentType)) continue;
    const captcha = detectCaptcha(r.text);
    if (captcha) {
      f.stop(norm, `captcha:${captcha}`);
      continue;
    }
    if (hasPasswordField(r.text)) {
      f.stop(norm, "password-field");
      continue;
    }
    const art = scoutArtifact("page", r.text, { type: "html", url: norm, status: r.status, contentType: r.contentType }, new URL(norm).pathname);
    artifacts.push(art);
    const root = parseHtml(r.text);
    const page = analysePage(norm, root, art.ref.sha256);
    pages.push(page);
    roots.set(norm, root);
    for (const l of page.links) enqueue(l.url, l.label);
    for (const form of page.forms) {
      if (!isSubmittableSearch(form) || searched.has(form.action)) continue;
      searched.add(form.action);
      const probe = new URL(form.action);
      probe.search = "";
      probe.searchParams.set(form.fields[0].name, SEARCH_PROBE);
      searchProbes.push(probe.toString());
      enqueue(probe.toString(), form.submitLabel ?? "Search");
    }
  }
  return { pages, roots, artifacts, csvLinks: [...csvLinks], searchProbes };
}

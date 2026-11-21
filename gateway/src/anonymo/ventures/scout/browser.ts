// WS11 · Scout: the optional browser driver (Ventures Backend spec, PART 4: "records HAR (network calls) ... screenshots
// at 3 viewports").
//
// playwright-core is not a gateway dependency. `loadPlaywrightDriver` imports it at run time and returns null when it
// (or a Chromium build) is missing, so Scout runs fetch-only. Every browser request passes the same `allow` check the
// fetcher uses (same-site, never-list, robots); anything else is aborted. The driver only loads pages; it never types,
// clicks or submits.

import type { HarEntry } from "./types.ts";

export const SCREENSHOT_WIDTHS = [375, 768, 1440] as const;

export type BrowserCapture = { har: HarEntry[]; screenshots: { width: number; png: Uint8Array }[] };

export interface BrowserDriver {
  capture(url: string, opts: { widths: readonly number[]; allow: (url: string) => boolean; userAgent: string }): Promise<BrowserCapture>;
  close(): Promise<void>;
}

// Minimal local shapes of the parts of playwright-core used here (its types are not installed).
type PwRequest = { method(): string; url(): string; postData(): string | null; resourceType(): string };
type PwResponse = { url(): string; status(): number; headers(): Record<string, string>; request(): PwRequest; text(): Promise<string> };
type PwRoute = { request(): PwRequest; continue(): Promise<void>; abort(): Promise<void> };
type PwPage = {
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  on(event: "response", handler: (r: PwResponse) => unknown): void;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  screenshot(opts: { fullPage: boolean; type: "png" }): Promise<Uint8Array>;
  close(): Promise<void>;
};
type PwContext = { newPage(): Promise<PwPage>; close(): Promise<void> };
type PwBrowser = { newContext(opts: { userAgent: string; javaScriptEnabled: boolean; acceptDownloads: boolean }): Promise<PwContext>; close(): Promise<void> };
type PwModule = { chromium: { launch(opts: { headless: boolean }): Promise<PwBrowser> } };

export async function loadPlaywrightDriver(importer: (specifier: string) => Promise<unknown> = (s) => import(s)): Promise<BrowserDriver | null> {
  let pw: PwModule;
  try {
    const mod = (await importer("playwright-core")) as { default?: PwModule } & Partial<PwModule>;
    pw = (mod.chromium ? mod : mod.default) as PwModule;
    if (!pw?.chromium) return null;
  } catch {
    return null;
  }
  let browser: PwBrowser;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch {
    return null;
  }
  return {
    async capture(url, { widths, allow, userAgent }) {
      const ctx = await browser.newContext({ userAgent, javaScriptEnabled: true, acceptDownloads: false });
      const page = await ctx.newPage();
      const har: HarEntry[] = [];
      const seen = new Set<string>();
      await page.route("**/*", (route) => (allow(route.request().url()) ? route.continue() : route.abort()));
      page.on("response", async (r) => {
        const req = r.request();
        const key = `${req.method()} ${r.url()}`;
        if (seen.has(key)) return;
        seen.add(key);
        const mimeType = (r.headers()["content-type"] ?? "").split(";")[0].trim();
        const entry: HarEntry = { method: req.method(), url: r.url(), status: r.status(), mimeType, bytes: 0, startedAt: new Date(0).toISOString(), timeMs: 0, resourceType: req.resourceType() };
        const post = req.postData();
        if (post) entry.requestBody = post.slice(0, 16_000);
        if (/json/.test(mimeType)) entry.responseBody = (await r.text().catch(() => "")).slice(0, 64_000);
        har.push(entry);
      });
      const screenshots: BrowserCapture["screenshots"] = [];
      try {
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
          screenshots.push({ width, png: await page.screenshot({ fullPage: true, type: "png" }) });
        }
      } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
      return { har, screenshots };
    },
    close: () => browser.close(),
  };
}

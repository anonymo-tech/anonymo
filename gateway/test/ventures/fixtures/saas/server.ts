// WS11 test fixture: "Ledgerly", a fictional invoicing SaaS served on 127.0.0.1 (Ventures Backend spec, PART 13 test 1).
//
// Every request is logged (method, path, user agent) so tests can prove Scout never asked for /login, /signup, robots-
// disallowed paths or pages behind a captcha. The fixture also stands in for the public web archive under /__wayback.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const file = (p: string) => readFileSync(join(DIR, p), "utf8");

export type FixtureRequest = { method: string; path: string; ua: string };
export type FixtureSite = { origin: string; host: string; log: FixtureRequest[]; stop: () => void };

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export function startFixtureSite(): FixtureSite {
  const log: FixtureRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      const path = u.pathname + u.search;
      log.push({ method: req.method, path, ua: req.headers.get("user-agent") ?? "" });
      const origin = `http://${u.host}`;
      switch (u.pathname) {
        case "/robots.txt":
          return new Response(
            ["User-agent: *", "Disallow: /private", "", "User-agent: AnonymoScout", "Disallow: /internal", "Crawl-delay: 0.01", "", `Sitemap: ${origin}/sitemap.xml`].join("\n"),
            { headers: { "content-type": "text/plain" } },
          );
        case "/sitemap.xml":
          return new Response(
            `<?xml version="1.0"?><urlset>${["/", "/features", "/pricing", "/docs", "/private/roadmap"].map((p) => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        case "/":
          return html(file("index.html"));
        case "/features":
          return html(file("features.html"));
        case "/pricing":
          return html(file("pricing.html"));
        case "/docs":
          return html(file("docs.html"));
        case "/docs/settings":
          return html(file("docs/settings.html"));
        case "/docs/sample-export.csv":
          return new Response(file("docs/sample-export.csv"), { headers: { "content-type": "text/csv" } });
        case "/contact":
          return html(file("contact.html"));
        case "/search":
          return html(file("search.html"));
        case "/beta":
          return html(file("beta.html"));
        case "/beta/secret":
          return html("<h1>Secret beta</h1>");
        case "/login":
          return html(file("login.html"));
        case "/signup":
          return html(file("signup.html"));
        case "/app":
          return new Response(null, { status: 302, headers: { location: "/login?next=/app" } });
        case "/guides/pro":
          return html("<h1>Pro guide</h1><p>Payment required.</p>", 402);
        case "/guides/members":
          return html('<h1>Members guide</h1><div class="gate">Subscribe to continue reading this guide.</div>');
        case "/private/roadmap":
        case "/internal/status":
          return html("<h1>Not for crawlers</h1>");
        case "/reviews-feed":
          return new Response(file("reviews-feed.txt"), { headers: { "content-type": "text/plain" } });
        case "/static/app.min.js":
          return new Response(file("static/app.min.js"), { headers: { "content-type": "text/javascript" } });
        case "/static/app.min.js.map":
          return new Response(file("static/app.min.js.map"), { headers: { "content-type": "application/json" } });
        case "/static/widgets.min.js":
          return new Response(file("static/widgets.min.js"), { headers: { "content-type": "text/javascript" } });
        case "/static/site.css":
          return new Response(file("static/site.css"), { headers: { "content-type": "text/css" } });
        case "/static/logo.svg":
          return new Response(file("static/logo.svg"), { headers: { "content-type": "image/svg+xml" } });
        case "/api/v1/invoices/123":
          return new Response(file("invoice-123.json"), { headers: { "content-type": "application/json" } });
        case "/__wayback/cdx/search/cdx": {
          const target = `http://${u.searchParams.get("url")}`;
          return Response.json([
            ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
            ["test,fixture)/pricing", "20250115000000", target, "text/html", "200", "DIGESTA", "900"],
            ["test,fixture)/pricing", "20250601000000", target, "text/html", "200", "DIGESTA", "900"],
            ["test,fixture)/pricing", "20251201000000", target, "text/html", "404", "DIGESTX", "100"],
            ["test,fixture)/pricing", "20260301000000", target, "text/html", "200", "DIGESTB", "1200"],
          ]);
        }
      }
      if (u.pathname.startsWith("/__wayback/web/2025")) return html(file("archive-pricing-2025.html"));
      if (u.pathname.startsWith("/__wayback/web/")) return html(file("pricing.html"));
      return html("<h1>Not found</h1>", 404);
    },
  });
  const host = `127.0.0.1:${server.port}`;
  return { origin: `http://${host}`, host, log, stop: () => server.stop(true) };
}

/** A fetch that serves the public web archive from the fixture; everything else goes to the network stack as-is. */
export function fixtureFetch(origin: string, seen: string[] = []) {
  return (input: string, init?: RequestInit) => {
    seen.push(input);
    const u = new URL(input);
    if (u.host === "web.archive.org") return fetch(`${origin}/__wayback${u.pathname}${u.search}`, init);
    if (!u.host.startsWith("127.0.0.1")) return Promise.reject(new Error("no internet in tests"));
    return fetch(input, init);
  };
}

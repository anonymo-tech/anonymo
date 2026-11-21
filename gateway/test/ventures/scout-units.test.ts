// WS11 · Scout building blocks (Ventures Backend spec, PART 4): robots, guards, bundle reading, API shapes, pricing,
// archive, OSS markers and file formats.
import { expect, test } from "bun:test";
import { entityName, evalUrlExpr, findBundleCalls, generalisePath, inferFields, objectLiteralFields } from "../../src/anonymo/ventures/scout/apis.ts";
import { cdxUrl, parseCdx } from "../../src/anonymo/ventures/scout/archive.ts";
import { prettyPrintJs, readSourceMap, sourceMapUrl } from "../../src/anonymo/ventures/scout/bundles.ts";
import { csvHeader } from "../../src/anonymo/ventures/scout/formats.ts";
import { detectCaptcha, detectPaywall, guardUrl, hasPasswordField } from "../../src/anonymo/ventures/scout/guards.ts";
import { parseHtml } from "../../src/anonymo/ventures/scout/html.ts";
import { licenceHeaders, packageMarkers, sourceMapPackages } from "../../src/anonymo/ventures/scout/oss.ts";
import { analysePage, isSubmittableSearch } from "../../src/anonymo/ventures/scout/page.ts";
import { extractPricing, parsePrice } from "../../src/anonymo/ventures/scout/pricing.ts";
import { reviewThemes } from "../../src/anonymo/ventures/scout/reviews.ts";
import { parseRobots } from "../../src/anonymo/ventures/scout/robots.ts";

test("robots: both the * group and the AnonymoScout group bind; longest match wins; Allow wins a tie", () => {
  const r = parseRobots(["User-agent: *", "Disallow: /private", "Allow: /private/press", "", "User-agent: AnonymoScout", "Disallow: /internal", "Disallow: /*.pdf$", "Crawl-delay: 2", "Sitemap: https://ledgerly.test/sitemap.xml"].join("\n"));
  expect(r.allowed("/")).toBe(true);
  expect(r.allowed("/private/roadmap")).toBe(false);
  expect(r.allowed("/private/press/kit")).toBe(true);
  expect(r.allowed("/internal/status")).toBe(false);
  expect(r.allowed("/docs/guide.pdf")).toBe(false);
  expect(r.allowed("/docs/guide.pdf?x=1")).toBe(true);
  expect(r.crawlDelayMs).toBe(2000);
  expect(r.sitemaps).toEqual(["https://ledgerly.test/sitemap.xml"]);
  expect(parseRobots("User-agent: OtherBot\nDisallow: /").allowed("/anything")).toBe(true);
  expect(parseRobots("User-agent: anonymoscout\nDisallow: /").allowed("/anything")).toBe(false);
});

test("guards: login, signup, account and checkout URLs (and labels) are refused before any request", () => {
  for (const u of ["https://ledgerly.test/login", "https://ledgerly.test/sign-in?next=/", "https://ledgerly.test/signup?plan=pro", "https://ledgerly.test/register", "https://ledgerly.test/account/settings", "https://ledgerly.test/checkout", "https://ledgerly.test/billing/", "https://auth.ledgerly.test/", "https://ledgerly.test/logout"])
    expect(guardUrl(u)).not.toBeNull();
  expect(guardUrl("https://ledgerly.test/start", "Sign up")).toBe("signup");
  expect(guardUrl("https://ledgerly.test/x", "Log in")).toBe("login");
  for (const u of ["https://ledgerly.test/", "https://ledgerly.test/pricing", "https://ledgerly.test/docs/settings", "https://ledgerly.test/features", "https://ledgerly.test/join-us"]) expect(guardUrl(u)).toBeNull();
  expect(detectCaptcha('<div class="g-recaptcha"></div>')).toBe("recaptcha");
  expect(detectCaptcha('<script src="https://hcaptcha.com/1/api.js"></script>')).toBe("hcaptcha");
  expect(detectCaptcha('<div class="cf-turnstile"></div>')).toBe("turnstile");
  expect(detectCaptcha("<p>plain page</p>")).toBeNull();
  expect(detectPaywall(402, "")).toBe("402");
  expect(detectPaywall(200, "<p>Subscribe to continue reading</p>")).toBe("marker");
  expect(detectPaywall(200, "<p>open</p>")).toBeNull();
  expect(hasPasswordField('<input name="p" type="password">')).toBe(true);
});

test("only a single-input GET search form may be submitted", () => {
  const page = (body: string) => analysePage("https://ledgerly.test/", parseHtml(body), "x");
  const search = page('<form action="/search" method="get" role="search"><input type="search" name="q"></form>').forms[0];
  expect(search.role).toBe("search");
  expect(isSubmittableSearch(search)).toBe(true);
  expect(isSubmittableSearch(page('<form action="/search" method="post"><input name="q"></form>').forms[0])).toBe(false);
  expect(isSubmittableSearch(page('<form action="/search"><input name="q"><input name="from"></form>').forms[0])).toBe(false);
  const login = page('<form action="/session"><input name="email"><input type="password" name="pw"></form>').forms[0];
  expect(login.role).toBe("login");
  expect(isSubmittableSearch(login)).toBe(false);
});

test("bundles: source map reference, map reduced to sources and content, pretty-printer", () => {
  expect(sourceMapUrl("a();\n//# sourceMappingURL=app.min.js.map\n", "https://ledgerly.test/static/app.min.js")).toBe("https://ledgerly.test/static/app.min.js.map");
  expect(sourceMapUrl("a();\n//# sourceMappingURL=data:application/json;base64,e30=", "https://ledgerly.test/a.js")).toBeNull();
  expect(readSourceMap('{"version":3,"sources":["a.ts"],"sourcesContent":["x"],"mappings":"AAAA","names":["n"]}')).toEqual({ sources: ["a.ts"], sourcesContent: ["x"] });
  const pretty = prettyPrintJs('!function(){var s="a;{b}";for(var i=0;i<3;i++){s+=i}if(/;}/.test(s)){return s}}();');
  expect(pretty.split("\n").length).toBeGreaterThan(4);
  expect(pretty).toContain('"a;{b}"');
  expect(pretty).toContain("for(var i=0;i<3;i++)");
  expect(pretty).toContain("/;}/.test(s)");
});

test("API shapes: fetch, axios, XHR and $.ajax call sites; ids generalised to :id", () => {
  expect(generalisePath("/api/v1/invoices/123")).toBe("/api/v1/invoices/:id");
  expect(generalisePath("/api/v1/invoices/3f2b8c1e-1d2a-4c55-9a77-0123456789ab/lines?x=1")).toBe("/api/v1/invoices/:id/lines");
  expect(generalisePath("/api/v1/invoices/INV-0042")).toBe("/api/v1/invoices/:id");
  expect(generalisePath("/api/v1/users")).toBe("/api/v1/users");
  expect(evalUrlExpr('"/a/"+id')).toBe("/a/\u0000");
  expect(evalUrlExpr("`/a/${id}/b`")).toBe("/a/\u0000/b");
  expect(objectLiteralFields('{customerId:n.c,amountCents:5,dueDate:d,paid:!0,"tags":[],note}')).toEqual([
    { name: "customerId", type: "id" },
    { name: "amountCents", type: "number" },
    { name: "dueDate", type: "date" },
    { name: "paid", type: "boolean" },
    { name: "tags", type: "array" },
    { name: "note", type: "string" },
  ]);
  const calls = findBundleCalls(
    `fetch('/api/v1/invoices/123');fetch("/api/v1/invoices",{method:"POST",body:JSON.stringify({customerId:c,amountCents:a})});axios.get("/api/v1/customers?search="+q);x.open("DELETE","/api/v1/invoices/"+n);$.ajax({url:"/api/v1/reports/summary",type:"GET"});window.open("https://elsewhere.test/");fetch("/static/logo.svg");axios.post("/api/v1/clients",{name:n,email:e})`,
    "https://ledgerly.test",
  );
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/invoices/:id", "POST /api/v1/invoices", "GET /api/v1/customers", "DELETE /api/v1/invoices/:id", "GET /api/v1/reports/summary", "POST /api/v1/clients"]);
  expect(calls[0].concrete).toBe("/api/v1/invoices/123");
  expect(calls[1].request.map((f) => f.name)).toEqual(["customerId", "amountCents"]);
  expect(calls[2].request).toEqual([{ name: "search", type: "string" }]);
  expect(calls[5].request.map((f) => f.name)).toEqual(["name", "email"]);
  expect(inferFields({ id: "1", total: 3, createdAt: "2026-01-02T00:00:00Z", paid: false, lines: [], meta: {} })).toEqual([
    { name: "id", type: "id" },
    { name: "total", type: "number" },
    { name: "createdAt", type: "date" },
    { name: "paid", type: "boolean" },
    { name: "lines", type: "array" },
    { name: "meta", type: "object" },
  ]);
  expect(entityName("/api/v1/invoices/:id")).toBe("Invoice");
  expect(entityName("/api/v1/line-items")).toBe("LineItem");
});

test("pricing: cards and comparison tables, monthly prices, limits split from features", () => {
  expect(parsePrice("$19/month")).toEqual({ amount: 19, currency: "USD", perUser: false });
  expect(parsePrice("$120 per year")).toEqual({ amount: 10, currency: "USD", perUser: false });
  expect(parsePrice("€9 per user / month")).toEqual({ amount: 9, currency: "EUR", perUser: true });
  expect(parsePrice("Contact sales")).toEqual({ amount: null, currency: "USD", perUser: false });
  const cards = extractPricing(parseHtml('<div><section><h3>Free</h3><p>$0</p><ul><li>1 user</li><li>Exports</li></ul></section><section><h3>Pro</h3><p>$29/month</p><ul><li>Unlimited users</li></ul></section></div>'));
  expect(cards?.plans).toEqual([
    { name: "Free", priceUsdMonthly: 0, limits: ["1 user"], features: ["Exports"] },
    { name: "Pro", priceUsdMonthly: 29, limits: ["Unlimited users"], features: [] },
  ]);
  const table = extractPricing(parseHtml("<table><tr><th></th><th>Basic</th><th>Team</th></tr><tr><td>Price</td><td>$10/mo</td><td>$30/mo</td></tr><tr><td>Seats</td><td>1</td><td>10</td></tr><tr><td>SSO</td><td>—</td><td>✓</td></tr></table>"));
  expect(table?.plans).toEqual([
    { name: "Basic", priceUsdMonthly: 10, limits: ["Seats: 1"], features: [] },
    { name: "Team", priceUsdMonthly: 30, limits: ["Seats: 10"], features: ["SSO"] },
  ]);
});

test("archive: CDX query shape, captures de-duplicated by digest, non-200 dropped", () => {
  expect(cdxUrl("ledgerly.test")).toBe("https://web.archive.org/cdx/search/cdx?url=ledgerly.test/pricing&output=json&limit=50");
  const caps = parseCdx(
    JSON.stringify([
      ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
      ["k", "20250601000000", "https://ledgerly.test/pricing", "text/html", "200", "A", "1"],
      ["k", "20250101000000", "https://ledgerly.test/pricing", "text/html", "200", "B", "1"],
      ["k", "20250701000000", "https://ledgerly.test/pricing", "text/html", "200", "A", "1"],
      ["k", "20250801000000", "https://ledgerly.test/pricing", "text/html", "301", "C", "1"],
    ]),
  );
  expect(caps.map((c) => c.timestamp)).toEqual(["20250101000000", "20250601000000"]);
  expect(parseCdx("not json")).toEqual([]);
});

test("OSS: licence headers, @license blocks, package markers and node_modules sources", () => {
  expect(licenceHeaders("/*! tinychart v2.1.0 | MIT */\n/** @license minidate 0.9.1\n * Released under the ISC license */\n/* plain */")).toEqual([
    { name: "tinychart", version: "2.1.0", licence: "MIT", source: "licence-header" },
    { name: "minidate", version: "0.9.1", licence: "ISC", source: "licence-header" },
  ]);
  expect(packageMarkers('var p={"name":"tinytable","version":"1.0.3"}')).toEqual([{ name: "tinytable", version: "1.0.3", licence: null, source: "package-marker" }]);
  expect(sourceMapPackages(["webpack://app/./node_modules/@scope/kit/index.js"]).map((m) => m.name)).toEqual(["@scope/kit"]);
});

test("formats and review themes", () => {
  expect(csvHeader("invoice_number,customer,amount\nINV-1,Sample,1.00")).toEqual({ fields: ["invoice_number", "customer", "amount"], extension: "csv" });
  expect(csvHeader("Just a sentence, with a comma, in it.\nand more")).toBeNull();
  const themes = reviewThemes(["Support is slow. The price is too expensive. Lovely design.", "No CSV import at all."]);
  expect(themes.map((t) => t.id)).toEqual(expect.arrayContaining(["price", "support", "speed", "import-export"]));
  expect(themes.every((t) => t.weight > 0 && t.weight <= 1)).toBe(true);
});

// WS11 · Spec Filter rules and leakage scan in isolation (Ventures Backend spec, PART 4 "Spec Filter (the firewall)").
import { expect, test } from "bun:test";
import { scoutArtifact } from "../../src/anonymo/ventures/scout/crawl.ts";
import type { ScoutAnalysis } from "../../src/anonymo/ventures/scout/types.ts";
import { buildIndex, canonicalJson, cleanLabel, filterSpec, findSharedSpans, labelViolation, LeakageError, scoutIndex, secondPass } from "../../src/anonymo/ventures/spec/index.ts";
import { emptySpec } from "../../src/anonymo/ventures/types.ts";

test("rules: short labels stay; long copy, CSS, colours, fonts, classes, assets, logos, legal text and code go", () => {
  for (const ok of ["Checkout", "Plans", "CSV export", "Up to 25 clients", "500 invoices per month", "CSV import available", "New invoice", "Two-factor login", "message (required, max 1000)"]) expect(labelViolation(ok)).toBeNull();
  const cases: [string, string][] = [
    ["Ledgerly turns every unpaid invoice into a friendly nudge so studios", "copy-length"],
    ["Accent #3a7bd5", "colour"],
    ["rgb(10, 20, 30)", "colour"],
    ["padding: 24px", "css"],
    [".hero { color: red }", "css"],
    ["Inter", "font"],
    ["btn-primary-lg", "class-name"],
    ["/static/logo.svg", "asset-url"],
    ["https://ledgerly.test/pricing", "asset-url"],
    ["Company logo", "branding"],
    ["© 2026 Sample Inc", "legal"],
    ["All rights reserved", "legal"],
    ["Terms of service", "legal"],
    ["Prices exclude VAT", "legal"],
    ["fetch('/api').then(r => r.json())", "code"],
    ["const x = 1", "code"],
    ["", "empty"],
  ];
  for (const [s, hit] of cases) expect([s, labelViolation(s)]).toEqual([s, hit]);
  expect(cleanLabel("  ✓ Payment reminders  ")).toBe("Payment reminders");
  expect(cleanLabel("Gentle reminders go out on a schedule you pick")).toBeNull();
});

test("leakage: 12-token spans are found across markup and case; shorter overlaps are not", () => {
  const index = scoutIndex([scoutArtifact("page", "<p>Every client gets a <b>tidy</b> page with open invoices, past receipts and a single button.</p>", { contentType: "text/html" })]);
  expect(findSharedSpans("EVERY client gets a tidy page with open invoices, past receipts and a single button!", index)).toEqual([
    { start: 0, end: 15, length: 15, text: "every client gets a tidy page with open invoices past receipts and a single button" },
  ]);
  expect(findSharedSpans("every client gets a tidy page with open invoices past receipts", index)).toEqual([]);
  expect(buildIndex(["a b c"], 2).grams).toEqual(new Set(["a b", "b c"]));
});

test("a plan list copied in page order is rewritten (reordered), not lost; the result is clean", async () => {
  const items = ["Unlimited clients and projects", "Unlimited invoices every month", "Five team seats included", "Priority email support"];
  const page = `<html><body><section><h2>Team</h2><p>$30/month</p><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul></section></body></html>`;
  const analysis: ScoutAnalysis = {
    startUrl: "https://ledgerly.test/",
    host: "ledgerly.test",
    observedAt: "2026-11-20T00:00:00.000Z",
    pages: [],
    bundles: [],
    apis: [],
    entities: [],
    flows: [],
    pricing: { currency: "USD", plans: [{ name: "Team", priceUsdMonthly: 30, limits: [], features: items }] },
    archive: null,
    jobs: [],
    themes: [],
    oss: [],
    formats: [],
    sitemaps: [],
    robots: { found: true, crawlDelayMs: null },
    screenshots: 0,
    har: [],
  };
  const r = await filterSpec(analysis, [scoutArtifact("page", page, { contentType: "text/html" })], { now: new Date("2026-11-20T00:00:00Z") });
  expect(r.leakageScan.spans).toBeGreaterThan(0);
  expect(r.leakageScan.removed.some((x) => x.startsWith("pricing.plans[0].features: ") && x.endsWith("reordered"))).toBe(true);
  expect([...r.spec.pricing.plans[0].features].sort()).toEqual([...items].sort());
  expect(findSharedSpans(canonicalJson(r.spec), scoutIndex([scoutArtifact("page", page, { contentType: "text/html" })]))).toEqual([]);
});

test("a span the filter cannot remove makes it throw instead of passing a dirty Spec", () => {
  const spec = emptySpec();
  const index = buildIndex(["apis complaints dataModels features findings flows formats oss pricing currency USD plans"]);
  expect(() => secondPass(spec, index)).toThrow(LeakageError);
});

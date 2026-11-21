import { describe, expect, test } from "bun:test";
import { toCss } from "../../src/anonymo/ventures/design/css.ts";
import { citedRows, renderComparison, renderDesignPreview, renderLanding, safeHref, type ComparisonContent, type LandingContent } from "../../src/anonymo/ventures/design/pages.ts";
import { generateDesignSystem } from "../../src/anonymo/ventures/design/tokens.ts";

// Designer Mo's pages (Ventures Overview §2): standalone HTML with every text escaped, no scripts, fonts as the only
// external request, and a comparison page where only dated, cited rows about the rival appear, each footnoted.

const ds = generateDesignSystem("pages-demo", "bold");

const landing: LandingContent = {
  brand: "Brightfold",
  tagline: "Invoices that pay you back in minutes",
  subhead: "Send a link, get paid in dollars or stablecoins.",
  cta: "Start free",
  features: [
    { title: "One-link invoices", body: "Clients pay without an account.", icon: "bolt" },
    { title: "Private by default", body: "No tracking pixels.", icon: "not-an-icon" },
    { title: "Exports", body: "CSV and PDF by quarter." },
  ],
  steps: [{ title: "Create", body: "Add a client." }, { title: "Send", body: "Share the link." }],
  pricing: [
    { name: "Starter", priceUsdMonthly: 0, features: ["5 invoices"] },
    { name: "Pro", priceUsdMonthly: 12, features: ["Unlimited invoices"], highlight: true },
    { name: "Studio", priceUsdMonthly: null, features: ["Custom terms"] },
  ],
  stats: [{ label: "median time to paid", value: "4 min" }],
  faq: [{ q: "Do clients need an account?", a: "No." }],
  footerNote: "Sample page.",
};

const comparison: ComparisonContent = {
  brand: "Brightfold",
  rival: "Ledgerly",
  cta: { label: "Switch now", href: "/start" },
  switchOffer: "Import your clients in one step.",
  rows: [
    { feature: "Pay by stablecoin", us: true, them: false, source: { fact: "Payment page lists card and bank transfer only.", observedAt: "2026-11-02T10:00:00Z" } },
    { feature: "Payout speed", us: "Instant", them: "2-3 business days", source: { fact: "Help centre states two to three business days.", observedAt: "2026-11-05" } },
    { feature: "Uncited row", us: true, them: false },
    { feature: "Undated row", us: true, them: false, source: { fact: "Something.", observedAt: "not a date" } },
  ],
};

const pages = () => [renderLanding(ds, landing), renderComparison(ds, comparison), renderDesignPreview(ds)];

describe("all pages", () => {
  test("are standalone documents with no scripts and only the fonts as external requests", () => {
    for (const html of pages()) {
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]).host);
      expect(new Set(external)).toEqual(new Set(["fonts.googleapis.com", "fonts.gstatic.com"]));
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    }
  });

  test("the stylesheet themes light and dark and ships the component library", () => {
    const css = toCss(ds);
    expect(css).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme="light"])');
    expect(css).toContain('[data-theme="dark"]{');
    expect(css).toContain(`--primary:${ds.palette.light.primary};`);
    expect(css).toContain(`--primary:${ds.palette.dark.primary};`);
    for (const cls of [".btn-primary", ".btn-secondary", ".btn-ghost", ".input", ".card", ".nav", ".hero", ".grid", ".pricing", ".plan.highlight", ".compare", ".stats", ".faq summary", ".cta-band", ".footer", ".badge", "prefers-reduced-motion", "feTurbulence"]) {
      expect(css).toContain(cls);
    }
    expect(css).not.toContain("undefined");
  });
});

describe("renderLanding", () => {
  test("escapes every piece of content", () => {
    const evil = '<script>alert("x")</script>';
    const html = renderLanding(ds, {
      ...landing,
      brand: `Bright ${evil}`,
      tagline: `Fast ${evil} pay`,
      features: [{ title: evil, body: `a & b ${evil}` }],
      faq: [{ q: evil, a: evil }],
      pricing: [{ name: evil, priceUsdMonthly: 5, features: [evil] }],
      cta: { label: evil, href: "javascript:alert(1)" },
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).not.toContain("javascript:");
  });

  test("renders sections, the highlighted plan and prices", () => {
    const html = renderLanding(ds, landing);
    for (const id of ['id="features"', 'id="how"', 'id="pricing"', 'id="faq"', 'id="start"']) expect(html).toContain(id);
    expect(html.match(/class="card plan highlight"/g)).toHaveLength(1);
    expect(html).toContain("Most popular");
    expect(html).toContain("<b>$12</b>");
    expect(html).toContain("<b>Custom</b>");
    expect(html).toContain("Free plan available");
    expect(html.match(/<details/g)).toHaveLength(1);
  });

  test("safeHref keeps anchors, paths and web links only", () => {
    expect(safeHref("#pricing")).toBe("#pricing");
    expect(safeHref("/start")).toBe("/start");
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("//evil.example")).toBe("#");
    expect(safeHref("data:text/html,x")).toBe("#");
  });
});

describe("renderComparison", () => {
  test("shows only cited rows, each footnoted with its source date", () => {
    const html = renderComparison(ds, comparison);
    const { cited, dropped } = citedRows(comparison.rows);
    expect(cited.map((r) => r.feature)).toEqual(["Pay by stablecoin", "Payout speed"]);
    expect(dropped).toHaveLength(2);
    expect(html).not.toContain("Uncited row");
    expect(html).not.toContain("Undated row");
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g)).toHaveLength(2);
    expect(html.match(/<sup class="cite">/g)).toHaveLength(2);
    expect(html).toContain('<li id="src-1">Payment page lists card and bank transfer only. Observed 2026-11-02.');
    expect(html).toContain('<li id="src-2">Help centre states two to three business days. Observed 2026-11-05.');
    expect(html).toContain('href="#src-1"');
    expect(html).toContain('href="#src-2"');
  });

  test("carries the neutral disclaimer dated by the latest source, and the switch offer", () => {
    const html = renderComparison(ds, comparison);
    expect(html).toContain("Compared on 2026-11-05 from public information. Ledgerly is a trademark of its owner; no affiliation.");
    expect(html).toContain("<title>Brightfold vs Ledgerly</title>");
    expect(html).toContain("Switching from Ledgerly?");
    expect(html).toContain('href="/start"');
    expect(renderComparison(ds, { ...comparison, comparedOn: "2026-11-20" })).toContain("Compared on 2026-11-20 from public information.");
  });

  test("escapes rival and row text", () => {
    const html = renderComparison(ds, { ...comparison, rival: "<img src=x>", rows: [{ feature: "<i>f</i>", us: "<b>", them: true, source: { fact: "<script>", observedAt: "2026-01-01" } }] });
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;img src=x&gt; is a trademark of its owner");
  });
});

describe("renderDesignPreview", () => {
  test("shows every swatch with hex and contrast in both themes, the scale and the fonts", () => {
    const html = renderDesignPreview(ds);
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('data-theme="dark"');
    for (const theme of ["light", "dark"] as const) for (const hex of Object.values(ds.palette[theme])) expect(html).toContain(`<code>${hex}</code>`);
    expect(html).toMatch(/text on bg \d+\.\d\d:1 · AAA/);
    expect(html).toContain(ds.fonts.display.family);
    expect(html).toContain("OFL-1.1");
    for (const size of Object.values(ds.scale.sizes)) expect(html).toContain(size);
  });
});

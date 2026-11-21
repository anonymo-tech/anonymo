// WS11 · Spec Filter on a Build Better run against the "Ledgerly" fixture (Ventures Backend spec, PART 4 "Spec Filter",
// Law 4, PART 13 acceptance test 1: "A Build Better run on a fixture SaaS site produces a Spec with no 12+ token span
// from Scout artifacts").
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { scriptedLlm } from "../../src/anonymo/ventures/llm.ts";
import { scoutSite, type ScoutArtifact, type ScoutResult } from "../../src/anonymo/ventures/scout/index.ts";
import { canonicalJson, filterSpec, type FilterResult } from "../../src/anonymo/ventures/spec/index.ts";
import type { Spec } from "../../src/anonymo/ventures/types.ts";
import { fixtureFetch, startFixtureSite, type FixtureSite } from "./fixtures/saas/server.ts";

const NOW = () => new Date("2026-11-20T12:00:00Z");
let site: FixtureSite;
let run: ScoutResult;
let out: FilterResult;

const scout = (s: FixtureSite) =>
  scoutSite({ url: `${s.origin}/`, fetch: fixtureFetch(s.origin), now: NOW, limits: { delayMs: 0 }, sleep: async () => {}, reviewUrls: [`${s.origin}/reviews-feed`] });

beforeAll(async () => {
  site = startFixtureSite();
  run = await scout(site);
  out = await filterSpec(run.analysis, run.artifacts, { now: NOW });
});
afterAll(() => site?.stop());

// ---- an independent 12-gram check (deliberately not reusing spec/leakage.ts) ------------------------------------------

const toks = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function scoutGrams(artifacts: ScoutArtifact[]): Set<string> {
  const grams = new Set<string>();
  const add = (s: string) => {
    const t = toks(s);
    for (let i = 0; i + 12 <= t.length; i++) grams.add(t.slice(i, i + 12).join(" "));
  };
  const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
  for (const a of artifacts) {
    if (a.ref.kind === "screenshot") continue;
    const raw = typeof a.body === "string" ? a.body : new TextDecoder().decode(a.body);
    add(raw);
    add(raw.replace(/<[^>]*>/g, " "));
    add(raw.replace(/<[^>]*>/g, ""));
    try {
      for (const s of strings(JSON.parse(raw))) add(s.replace(/<[^>]*>/g, " "));
    } catch {
      /* not JSON */
    }
  }
  return grams;
}
function leaked(spec: Spec, grams: Set<string>): string[] {
  const texts = [canonicalJson(spec), JSON.stringify(spec), JSON.stringify(spec, null, 2), spec.features.map((f) => f.name).join(" "), spec.features.map((f) => f.description).join(" "), spec.findings.map((f) => f.fact).join(" "), ...spec.flows.map((f) => f.steps.map((s) => s.name).join(" "))];
  const hits: string[] = [];
  for (const t of texts) {
    const k = toks(t);
    for (let i = 0; i + 12 <= k.length; i++) if (grams.has(k.slice(i, i + 12).join(" "))) hits.push(k.slice(i, i + 12).join(" "));
  }
  return hits;
}

test("acceptance 1: the Spec from a Build Better run shares no 12+ token span with any Scout artifact", () => {
  expect(out.leakageScan.clean).toBe(true);
  expect(out.leakageScan.scannedTokens).toBeGreaterThan(500);
  expect(out.leakageScan.indexedTokens).toBeGreaterThan(out.leakageScan.scannedTokens);
  expect(leaked(out.spec, scoutGrams(run.artifacts))).toEqual([]);
});

test("long marketing copy, CSS, colours, fonts, class names, images, legal text and the brand name are gone", () => {
  const json = canonicalJson(out.spec).toLowerCase();
  for (const banned of ["friendly nudge", "unpaid invoice into", "gentle reminders go out", "#3a7bd5", "#ff6a3d", '"inter"', "btn-primary", "plan--", "logo", ".svg", "all rights reserved", "trademark", "terms of service", "vat", "ledgerly", "sprout", "font", "padding"])
    expect(json).not.toContain(banned);
  const strings = JSON.stringify(out.spec).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  for (const s of strings) expect(s.trim().split(/\s+/).length).toBeLessThanOrEqual(8);
});

test("the plan grid keeps generic plan names, generalises the rest, and keeps prices and limits", () => {
  expect(out.spec.pricing).toEqual({
    currency: "USD",
    plans: [
      { name: "Free", priceUsdMonthly: 0, limits: ["Up to 3 clients", "20 invoices per month"], features: ["CSV export"] },
      { name: "Tier 2", priceUsdMonthly: 19, limits: ["Up to 25 clients", "500 invoices per month"], features: ["Payment reminders", "CSV export"] },
      { name: "Business", priceUsdMonthly: 49, limits: ["Unlimited clients", "Unlimited invoices", "5 team seats"], features: ["Priority support", "API access"] },
    ],
  });
});

test("API shapes: GET /api/v1/invoices/:id with its response fields, POST with request fields; no code kept", () => {
  const get = out.spec.apis.find((a) => a.method === "GET" && a.path === "/api/v1/invoices/:id")!;
  expect(get.response).toEqual(expect.arrayContaining([{ name: "id", type: "id" }, { name: "amountCents", type: "number" }, { name: "issuedAt", type: "date" }, { name: "paid", type: "boolean" }]));
  const post = out.spec.apis.find((a) => a.method === "POST" && a.path === "/api/v1/invoices")!;
  expect(post.request).toEqual([{ name: "customerId", type: "id" }, { name: "amountCents", type: "number" }, { name: "dueDate", type: "date" }, { name: "currency", type: "string" }, { name: "sendReminder", type: "boolean" }]);
  expect(out.spec.apis.map((a) => `${a.method} ${a.path}`)).toEqual(expect.arrayContaining(["DELETE /api/v1/invoices/:id", "GET /api/v1/customers", "GET /api/v1/customers/:id/invoices", "GET /api/v1/reports/summary"]));
  const json = canonicalJson(out.spec);
  for (const code of ["fetch(", "JSON.stringify", "=>", "function", "axios", "XMLHttpRequest", "127.0.0.1"]) expect(json).not.toContain(code);
});

test("data models, file formats, OSS in use, flows with validation rules", () => {
  expect(out.spec.dataModels.map((d) => d.name)).toEqual(["Invoice", "ContactForm"]);
  expect(out.spec.dataModels[1].fields.find((f) => f.name === "topic")).toEqual({ name: "topic", type: "enum", values: ["sales", "support"] });
  expect(out.spec.formats).toEqual([{ name: "CSV export", extension: "csv", fields: ["invoice_number", "customer", "amount", "currency", "status", "issued_at", "due_date"] }]);
  expect(out.spec.oss).toEqual([{ name: "minidate", licence: "ISC" }, { name: "tinychart", licence: "MIT" }, { name: "tinytable", licence: null }]);
  const flow = (n: string) => out.spec.flows.find((f) => f.name === n)!;
  expect(flow("Checkout").steps).toEqual([{ name: "Home", kind: "page" }, { name: "Pricing", kind: "choice" }, { name: "Sign up", kind: "action" }]);
  expect(flow("Settings").steps.map((s) => s.name)).toEqual(["Home", "Docs", "Docs settings", "Open settings"]);
  expect(flow("Contact").steps[1].fields).toEqual(["name (required, max 80)", "email (email, required)", "topic (select)", "message (required, max 1000)"]);
  expect(flow("Search").steps[0]).toEqual({ name: "Search", kind: "form", fields: ["q"] });
  expect(out.spec.features.map((f) => f.name)).toEqual(expect.arrayContaining(["Smart reminders", "Invoices", "Recurring invoices", "Reports", "Webhooks", "Tax rates", "API access"]));
  expect(out.spec.complaints.map((c) => c.theme)).toEqual(expect.arrayContaining(["Price", "Support", "Import and export"]));
});

test("findings are dated functional facts for the claim checker", () => {
  const facts = (src: string) => out.spec.findings.filter((f) => f.source === src).map((f) => `${f.observedAt} ${f.fact}`);
  expect(facts("pricing")).toEqual(expect.arrayContaining(["2026-11-20 Top plan costs $49/month", "2026-11-20 Entry plan is free", "2026-11-20 Tier 2 plan: Up to 25 clients"]));
  expect(facts("feature")).toEqual(expect.arrayContaining(["2026-11-20 No CSV import seen on public pages", "2026-11-20 CSV export available", "2026-11-20 No SSO seen on public pages"]));
  expect(facts("archive")).toEqual(expect.arrayContaining(["2025-01-15 Top plan cost $39/month", "2025-01-15 Tier 2 plan cost $15/month", "2026-03-01 Top plan cost $49/month"]));
  expect(facts("oss")).toEqual(expect.arrayContaining(["2026-11-20 Uses tinychart (MIT)"]));
  expect(facts("reviews").length).toBeGreaterThan(0);
  expect(facts("jobs")).toEqual(["2026-11-20 Job board linked from public pages"]);
  expect(new Set(out.spec.findings.map((f) => f.id)).size).toBe(out.spec.findings.length);
});

test("the spec hash is sha256 of canonical JSON, stable for the same input (even from a fresh run on another port)", async () => {
  expect(out.specHash).toBe(createHash("sha256").update(canonicalJson(out.spec)).digest("hex"));
  expect(out.ref).toEqual({ sha256: out.specHash, kind: "spec", zone: "CLEAN", name: "spec.json" });
  const again = await filterSpec(run.analysis, run.artifacts, { now: NOW });
  expect(again.specHash).toBe(out.specHash);
  const other = startFixtureSite();
  try {
    const rerun = await scout(other);
    expect((await filterSpec(rerun.analysis, rerun.artifacts, { now: NOW })).specHash).toBe(out.specHash);
  } finally {
    other.stop();
  }
  const later = await filterSpec(run.analysis, run.artifacts, { now: new Date("2026-12-01T00:00:00Z") });
  expect(later.specHash).not.toBe(out.specHash);
});

test("an Llm that smuggles copied sentences is caught by the leakage scan; its honest output is kept", async () => {
  const llm = scriptedLlm([
    {
      when: (c) => c.json === true,
      reply: () =>
        "```json\n" +
        JSON.stringify({
          features: [
            // hyphen-joined copy is refused by the rules already (it reads as a class name)
            { name: "turns-every-unpaid-invoice-into-a-friendly-nudge-so-small-studios-get-paid", area: "Billing", description: "Automatic reminders" },
            // one "word" of 14 tokens: passes every rule, caught only by the n-gram scan
            { name: "every/unpaid/invoice/into/a/friendly/nudge/so/small/studios/get/paid/on/time", area: "Billing", description: "Automatic reminders" },
            // a sentence split across consecutive feature names
            { name: "Gentle reminders go out", area: "Reminders", description: "on a schedule you" },
            { name: "pick and they stop", area: "Reminders", description: "the moment a client" },
            { name: "the moment a client", area: "Reminders", description: "settles the balance in full" },
            { name: "settles the balance in full", area: "Reminders", description: "Short" },
            // long copy in the description, under the word limit by hyphenation
            { name: "Bank feed matching", area: "Payments", description: "connect_your_bank_feed_and_your_accounting_tool_so_payments_are_matched_to_invoices" },
            { name: "Late fee rules", area: "Billing", description: "Adds fees to overdue invoices" },
            { name: "Draft a polished invoice in under a minute with saved line items", area: "x", description: "y" },
            { name: "Uses #ff6a3d accents", area: "Design", description: "Brand colour" },
          ],
          complaints: [{ theme: "Slow support replies", weight: 0.7 }],
        }) +
        "\n```",
    },
  ]);
  const r = await filterSpec(run.analysis, run.artifacts, { now: NOW, llm });
  expect(llm.calls.length).toBe(1);
  expect(r.leakageScan.clean).toBe(true);
  expect(r.leakageScan.spans).toBeGreaterThanOrEqual(3);
  expect(r.leakageScan.removed.filter((x) => x.includes("leak:")).length).toBeGreaterThanOrEqual(3);
  expect(r.leakageScan.removed.join("\n")).not.toContain("friendly");
  const names = r.spec.features.map((f) => f.name);
  expect(names).toContain("Late fee rules");
  expect(names).toContain("Bank feed matching");
  expect(names.some((n) => n.includes("unpaid"))).toBe(false);
  expect(names.some((n) => n.startsWith("Draft a polished"))).toBe(false);
  expect(names.some((n) => n.includes("#ff6a3d"))).toBe(false);
  expect(r.spec.features.find((f) => f.name === "Bank feed matching")!.description).not.toContain("connect");
  expect(r.spec.features.find((f) => f.name === "Late fee rules")!.evidence).toEqual(["llm"]);
  expect(r.spec.complaints.map((c) => c.theme)).toContain("Slow support replies");
  expect(leaked(r.spec, scoutGrams(run.artifacts))).toEqual([]);
  expect(r.specHash).not.toBe(out.specHash);
});

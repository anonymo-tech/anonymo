// WS11 · Spec Filter, the firewall between SCOUT and CLEAN (Ventures Backend spec, PART 4 "Spec Filter", Law 4, PART 13
// test 1).
//
// filterSpec turns Scout's analysis into a functional Spec: features, flows, data models, API shapes, the plan grid,
// complaint themes, file formats, OSS in use and dated findings. It drops protected expression: copy longer than 8
// words, CSS, class names, colours, fonts, images, icons, logos, legal text and code. A second pass re-checks every
// string with the same rules and scans the Spec against an n-gram index of all Scout artifact text; any 12+ token span
// found is removed or rewritten and the Spec is scanned again. The result must end clean, or filterSpec throws. Only
// the Spec's hash (sha256 of canonical JSON) crosses into the CLEAN zone.

import { createHash } from "node:crypto";
import type { Llm } from "../llm.ts";
import { parseJsonReply } from "../llm.ts";
import type { ArtifactRef, EntitySpec, FeatureSpec, FieldSpec, FileFormat, Finding, FlowSpec, Plan, Spec, Theme } from "../types.ts";
import { generalisePath } from "../scout/apis.ts";
import { archiveDate } from "../scout/archive.ts";
import type { FormField, ScoutAnalysis, ScoutArtifact } from "../scout/types.ts";
import { SPAN_TOKENS, scoutIndex, sharedSpansInTokens, tokenizeAt, type NgramIndex } from "./leakage.ts";
import { HTTP_METHOD, ISO_DATE, PATH_PATTERN, cleanLabel, isColumn, isGenericPlanName, isIdentifier, labelViolation, stripBrand, wordCount } from "./rules.ts";

export type LeakageReport = { spans: number; removed: string[]; clean: true; scannedTokens: number; indexedTokens: number };
export type FilterOptions = { llm?: Llm; now: Date | (() => Date); model?: string };
export type FilterResult = { spec: Spec; specHash: string; ref: ArtifactRef; leakageScan: LeakageReport };

export class LeakageError extends Error {
  constructor(
    readonly spans: number,
    readonly remaining: string[],
  ) {
    super(`spec filter could not remove ${remaining.length} protected span(s)`);
  }
}

// ---- canonical JSON and hash ---------------------------------------------------------------------------------------

type Path = (string | number)[];
type Leaf = { path: Path; start: number; end: number; removable: boolean };

function writeCanon(v: unknown, path: Path, st: { s: string; leaves: Leaf[] }) {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") {
    const s = JSON.stringify(v ?? null) ?? "null";
    st.leaves.push({ path, start: st.s.length, end: st.s.length + s.length, removable: false });
    st.s += s;
  } else if (typeof v === "string") {
    const s = JSON.stringify(v);
    st.leaves.push({ path, start: st.s.length, end: st.s.length + s.length, removable: true });
    st.s += s;
  } else if (Array.isArray(v)) {
    st.s += "[";
    v.forEach((x, i) => {
      if (i) st.s += ",";
      writeCanon(x, [...path, i], st);
    });
    st.s += "]";
  } else {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    st.s += "{";
    keys.forEach((k, i) => {
      if (i) st.s += ",";
      const ks = JSON.stringify(k);
      st.leaves.push({ path: [...path, `#key:${k}`], start: st.s.length, end: st.s.length + ks.length, removable: false });
      st.s += ks + ":";
      writeCanon(obj[k], [...path, k], st);
    });
    st.s += "}";
  }
}

function canonWithLeaves(v: unknown) {
  const st = { s: "", leaves: [] as Leaf[] };
  writeCanon(v, [], st);
  return st;
}

/** JSON with object keys sorted at every level and no whitespace. */
export const canonicalJson = (v: unknown): string => canonWithLeaves(v).s;

export const specHashOf = (spec: Spec): string => createHash("sha256").update(canonicalJson(spec)).digest("hex");

// ---- small helpers -------------------------------------------------------------------------------------------------

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function slug(s: string, words = 6): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .slice(0, words)
      .join("-") || "x"
  );
}

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6);
const idFor = (prefix: string, name: string) => `${prefix}-${slug(name, 4)}-${shortHash(name)}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function pathLabel(id: string): string {
  const segs = id.split(/[?#]/)[0].split("/").filter(Boolean);
  if (!segs.length) return "Home";
  return cap(segs.join(" ").replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim());
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
const money = (n: number, currency: string) => `${SYMBOL[currency] ?? `${currency} `}${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function brandTerms(a: ScoutAnalysis): string[] {
  const out = new Set<string>();
  const home = a.pages.find((p) => new URL(p.url).pathname === "/") ?? a.pages[0];
  const site = home?.siteName ?? home?.title?.split(/\s+[|–—:·-]\s+/)[0] ?? null;
  if (site && wordCount(site) <= 3 && site.trim().length >= 3) out.add(site.trim());
  const host = a.host.split(":")[0];
  if (!/^[\d.]+$|^\[|^localhost$/i.test(host)) {
    const labels = host.split(".").filter((l) => l !== "www");
    const name = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    if (name && name.length >= 3) out.add(name);
  }
  return [...out];
}

// ---- building the Spec ---------------------------------------------------------------------------------------------

const GENERIC_HEADING = /^(features?|pricing|plans?|faqs?|frequently asked questions|contact( us)?|about( us)?|blog|docs|documentation|overview|home|results|search results|testimonials|customers|resources|company|product|legal|support|get started|why\b.*|what (people|customers) say\b.*)$/i;
const FIELD_TYPES = new Set(["string", "number", "boolean", "date", "id", "enum", "object", "array"]);
const STEP_KINDS = new Set(["page", "form", "action", "choice"]);
const FINDING_SOURCES = new Set(["pricing", "flow", "feature", "api", "reviews", "archive", "jobs", "oss"]);
const DESCRIPTOR = /^[A-Za-z_$][\w$.-]{0,63}( \([A-Za-z0-9 ,.:_-]{1,80}\))?$/;
const GUARD_STEP: Record<string, string> = { login: "Log in", signup: "Sign up", account: "Account", checkout: "Checkout", logout: "Log out" };

type Ctx = { brands: string[]; planNames: Map<string, string> };

function makeLabel(ctx: Ctx) {
  return (s: string | null | undefined, maxWords?: number): string | null => {
    if (typeof s !== "string") return null;
    const unbranded = stripBrand(s, ctx.brands);
    if (!unbranded) return null;
    let t = unbranded;
    for (const [orig, gen] of ctx.planNames) {
      if (orig.toLowerCase() === gen.toLowerCase()) continue;
      t = t.replace(new RegExp(`\\b${orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), gen);
    }
    return cleanLabel(t, maxWords);
  };
}

function planNameMap(a: ScoutAnalysis): Map<string, string> {
  const out = new Map<string, string>();
  (a.pricing?.plans ?? []).forEach((p, i) => {
    const name = cleanLabel(p.name, 3);
    out.set(p.name, name && isGenericPlanName(name) ? name : `Tier ${i + 1}`);
  });
  return out;
}

function formFieldType(f: FormField): FieldSpec["type"] {
  if (/^(number|range)$/.test(f.type)) return "number";
  if (/^(date|datetime-local|month|week|time)$/.test(f.type)) return "date";
  if (f.type === "checkbox") return "boolean";
  if (/^(select|radio)$/.test(f.type)) return "enum";
  return "string";
}

function buildPricing(a: ScoutAnalysis, ctx: Ctx, label: ReturnType<typeof makeLabel>): Spec["pricing"] {
  const grid = a.pricing;
  if (!grid) return { currency: "USD", plans: [] };
  const plans: Plan[] = grid.plans.map((p) => ({
    name: ctx.planNames.get(p.name) ?? "Tier",
    priceUsdMonthly: typeof p.priceUsdMonthly === "number" && Number.isFinite(p.priceUsdMonthly) ? p.priceUsdMonthly : null,
    limits: uniq(p.limits.map((l) => label(l)).filter((x): x is string => !!x)),
    features: uniq(p.features.map((l) => label(l)).filter((x): x is string => !!x)),
  }));
  return { currency: /^[A-Z]{3}$/.test(grid.currency) ? grid.currency : "USD", plans };
}

const uniq = (xs: string[]) => [...new Set(xs)];

function buildFeatures(a: ScoutAnalysis, pricing: Spec["pricing"], label: ReturnType<typeof makeLabel>): FeatureSpec[] {
  const out: FeatureSpec[] = [];
  const seen = new Set<string>();
  const planOriginals = new Set((a.pricing?.plans ?? []).map((p) => p.name.trim().toLowerCase()));
  const add = (name: string, area: string, description: string, evidence: string) => {
    const k = name.toLowerCase();
    if (seen.has(k) || out.length >= 80) return;
    seen.add(k);
    out.push({ id: idFor("feat", name), name, area, description, evidence: [evidence] });
  };
  for (const p of a.pages) {
    const path = new URL(p.url).pathname;
    if (/\/(pricing|plans|search)(\/|$)/i.test(path)) continue;
    const area = label(pathLabel(path), 3) ?? "General";
    for (const h of p.headings) {
      if (h.level < 2 || h.level > 3 || planOriginals.has(h.text.trim().toLowerCase())) continue;
      const name = label(h.text, 6);
      if (!name || GENERIC_HEADING.test(name)) continue;
      add(name, area, `Listed under ${area}`, "heading");
    }
  }
  const inPlans = new Map<string, string[]>();
  for (const p of pricing.plans) for (const f of p.features) inPlans.set(f, [...(inPlans.get(f) ?? []), p.name]);
  for (const [f, names] of inPlans) add(f, "Plans", names.length <= 3 ? `Included in ${names.join(", ")}` : `Included in ${names.length} plans`, "plan");
  return out;
}

function buildFlows(a: ScoutAnalysis, label: ReturnType<typeof makeLabel>): FlowSpec[] {
  return a.flows
    .map((f) => ({
      id: `flow-${slug(f.name)}`,
      name: cap(f.name),
      steps: f.states.map((s, i) => {
        const name = (s.visited && s.id.startsWith("/") ? label(pathLabel(s.id), 6) : label(s.label, 6)) ?? (s.guard ? GUARD_STEP[s.guard] : null) ?? `Step ${i + 1}`;
        const fields = (s.fields ?? []).filter((d) => DESCRIPTOR.test(d));
        return { name, kind: s.kind, ...(fields.length ? { fields } : {}) };
      }),
    }))
    .filter((f) => f.steps.length >= 2);
}

function buildDataModels(a: ScoutAnalysis, label: ReturnType<typeof makeLabel>, brands: string[]): EntitySpec[] {
  const out: EntitySpec[] = [];
  const add = (e: EntitySpec) => {
    if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(e.name) || out.some((x) => x.name === e.name) || stripBrand(e.name, brands) === null) return;
    const fields = e.fields.filter((f) => isIdentifier(f.name) && FIELD_TYPES.has(f.type));
    if (fields.length) out.push({ name: e.name, fields });
  };
  for (const e of a.entities) add({ name: e.name, fields: e.fields.map((f) => ({ name: f.name, type: f.type, ...(f.required ? { required: true } : {}) })) });
  for (const p of a.pages)
    for (const form of p.forms) {
      if (form.role !== "other" || form.hasPassword || form.fields.length < 2) continue;
      const base = pathLabel(new URL(form.action).pathname === "/" ? new URL(p.url).pathname : new URL(form.action).pathname).replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase());
      add({
        name: `${cap(base.replace(/[^A-Za-z0-9]/g, ""))}Form`,
        fields: form.fields.map((f) => {
          const values = (f.options ?? []).map((o) => (isIdentifier(o) ? o : label(o, 3))).filter((x): x is string => !!x);
          return { name: f.name, type: formFieldType(f), ...(f.required ? { required: true } : {}), ...(values.length ? { values } : {}) };
        }),
      });
    }
  return out;
}

function buildApis(a: ScoutAnalysis): Spec["apis"] {
  const seen = new Set<string>();
  const fields = (fs: FieldSpec[] | undefined) => (fs ?? []).filter((f) => isIdentifier(f.name) && FIELD_TYPES.has(f.type)).map((f) => ({ name: f.name, type: f.type }));
  return a.apis.flatMap((o) => {
    const method = o.method.toUpperCase();
    const path = generalisePath(o.path);
    const k = `${method} ${path}`;
    if (!HTTP_METHOD.test(method) || !PATH_PATTERN.test(path) || seen.has(k)) return [];
    seen.add(k);
    const request = fields(o.request);
    const response = fields(o.response);
    return [{ method, path, ...(request.length ? { request } : {}), ...(response.length ? { response } : {}) }];
  });
}

function buildFormats(a: ScoutAnalysis, label: ReturnType<typeof makeLabel>): FileFormat[] {
  return a.formats
    .map((f) => ({ name: label(f.name, 6) ?? `${f.extension.toUpperCase()} file`, extension: f.extension.toLowerCase(), fields: f.fields.filter(isColumn) }))
    .filter((f) => /^[a-z0-9]{1,8}$/.test(f.extension) && f.fields.length >= 2);
}

function buildOss(a: ScoutAnalysis, brands: string[]): Spec["oss"] {
  return a.oss
    .filter((o) => /^@?[a-z0-9][\w.-]*(\/[\w.-]+)?$/i.test(o.name) && stripBrand(o.name.replace(/[-_.@/]+/g, " "), brands) !== null)
    .map((o) => ({ name: o.name, licence: o.licence && /^[A-Za-z0-9.+-]{1,32}$/.test(o.licence) ? o.licence : null }));
}

function buildThemes(themes: { id?: string; theme: string; weight: number }[], label: ReturnType<typeof makeLabel>): Theme[] {
  const out: Theme[] = [];
  for (const t of themes) {
    const theme = label(t.theme, 4);
    if (!theme) continue;
    const id = `theme-${slug(theme, 4)}`;
    if (out.some((x) => x.id === id)) continue;
    const weight = Number.isFinite(t.weight) ? Math.round(Math.min(1, Math.max(0, t.weight)) * 100) / 100 : 0.5;
    out.push({ id, theme, weight });
  }
  return out;
}

export function buildFindings(spec: Spec, a: ScoutAnalysis, day: string, planNames: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  const add = (source: Finding["source"], fact: string, observedAt = day) => {
    const clean = cleanLabel(fact);
    if (!clean) return;
    const id = `finding-${source}-${slug(clean, 8)}-${shortHash(`${clean}|${observedAt}`)}`;
    if (!out.some((f) => f.id === id)) out.push({ id, fact: clean, observedAt, source });
  };
  const { plans, currency } = spec.pricing;
  if (plans.length) {
    add("pricing", `${plans.length} plans listed`);
    if (plans.some((p) => p.priceUsdMonthly === 0)) add("pricing", "Entry plan is free");
    const paid = plans.filter((p) => (p.priceUsdMonthly ?? 0) > 0);
    if (paid.length) {
      const lo = paid.reduce((x, y) => (y.priceUsdMonthly! < x.priceUsdMonthly! ? y : x));
      const hi = paid.reduce((x, y) => (y.priceUsdMonthly! > x.priceUsdMonthly! ? y : x));
      add("pricing", `Lowest paid plan costs ${money(lo.priceUsdMonthly!, currency)}/month`);
      add("pricing", `Top plan costs ${money(hi.priceUsdMonthly!, currency)}/month`);
    }
    if (plans.some((p) => p.priceUsdMonthly === null)) add("pricing", "One plan is priced by quote");
    for (const p of plans) {
      if (p.priceUsdMonthly !== null) add("pricing", `${p.name} plan costs ${money(p.priceUsdMonthly, currency)}/month`);
      for (const l of p.limits.slice(0, 6)) add("pricing", `${p.name} plan: ${l}`);
    }
  }
  const hay = [
    ...spec.features.map((f) => f.name),
    ...plans.flatMap((p) => [...p.features, ...p.limits]),
    ...spec.formats.map((f) => f.name),
    ...spec.apis.map((x) => x.path),
  ]
    .join(" \n ")
    .toLowerCase();
  add("feature", /\bimport/.test(hay) ? "CSV import available" : "No CSV import seen on public pages");
  add("feature", /\bexport/.test(hay) ? "CSV export available" : "No CSV export seen on public pages");
  add("feature", /\b(sso|saml|single sign-on)\b/.test(hay) ? "SSO available" : "No SSO seen on public pages");
  if (spec.apis.length) add("api", `Web app calls ${spec.apis.length} public API endpoints`);
  for (const x of spec.apis.slice(0, 12)) add("api", `${x.method} ${x.path} endpoint seen`);
  for (const f of spec.flows) add("flow", `${f.name} flow has ${f.steps.length} public steps`);
  for (const t of spec.complaints) add("reviews", `Reviewers raise ${t.theme.toLowerCase()} issues`);
  for (const o of spec.oss) add("oss", `Uses ${o.name}${o.licence ? ` (${o.licence})` : ""}`);
  if (a.jobs.length) add("jobs", "Job board linked from public pages");
  for (const g of a.archive?.grids ?? []) {
    const priced = g.grid.plans.filter((p) => (p.priceUsdMonthly ?? 0) > 0);
    const date = archiveDate(g.timestamp);
    if (!ISO_DATE.test(date)) continue;
    add("archive", `${g.grid.plans.length} plans listed`, date);
    if (priced.length) add("archive", `Top plan cost ${money(Math.max(...priced.map((p) => p.priceUsdMonthly!)), g.grid.currency)}/month`, date);
    for (const p of g.grid.plans) {
      const name = planNames.get(p.name) ?? (isGenericPlanName(p.name) ? p.name : null);
      if (name && p.priceUsdMonthly !== null) add("archive", `${name} plan cost ${money(p.priceUsdMonthly, g.grid.currency)}/month`, date);
    }
  }
  return out;
}

type LlmExtract = { features: { name: string; area: string; description: string }[]; complaints: { theme: string; weight: number }[] };

/** Asks the optional Llm to name features and complaint themes. The reply is untrusted: it goes through every rule. */
async function llmExtract(llm: Llm, a: ScoutAnalysis, model: string): Promise<LlmExtract> {
  const text = a.pages
    .map((p) => `# ${new URL(p.url).pathname}\n${p.headings.map((h) => h.text).join("\n")}\n${p.paragraphs.slice(0, 40).join("\n")}`)
    .join("\n\n")
    .slice(0, 16_000);
  try {
    const reply = await llm.call({
      model,
      json: true,
      maxTokens: 1200,
      messages: [
        {
          role: "system",
          content:
            'List the product\'s features and the complaint themes users raise, as a functional spec. Reply JSON {"features":[{"name":"2-5 words","area":"1-2 words","description":"at most 8 words, in your own words"}],"complaints":[{"theme":"1-3 words","weight":0.5}]}. Never copy sentences, slogans or names from the pages.',
        },
        { role: "user", content: text },
      ],
    });
    const j = parseJsonReply<Partial<LlmExtract>>(reply.text) ?? {};
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    return {
      features: (Array.isArray(j.features) ? j.features : []).map((f) => ({ name: str(f?.name), area: str(f?.area), description: str(f?.description) })),
      complaints: (Array.isArray(j.complaints) ? j.complaints : []).map((c) => ({ theme: str(c?.theme), weight: typeof c?.weight === "number" ? c.weight : 0.5 })),
    };
  } catch {
    return { features: [], complaints: [] };
  }
}

// ---- the second pass: rules and leakage ----------------------------------------------------------------------------

const pattern = (p: Path) => p.map((x) => (typeof x === "number" ? "*" : x)).join(".");
const pathStr = (p: Path) => p.map((x) => (typeof x === "number" ? `[${x}]` : `.${x}`)).join("").replace(/^\./, "");

/** Which rule a Spec string must satisfy, by where it sits. */
function leafViolation(path: Path, v: string, brands: string[]): string | null {
  const pat = pattern(path);
  const ok = (b: boolean) => (b ? null : "shape");
  switch (pat) {
    case "features.*.id":
    case "flows.*.id":
    case "complaints.*.id":
    case "findings.*.id":
      return ok(/^[a-z0-9-]{1,120}$/.test(v));
    case "features.*.evidence.*":
      return ok(/^(heading|plan|llm)$/.test(v));
    case "flows.*.steps.*.kind":
      return ok(STEP_KINDS.has(v));
    case "dataModels.*.fields.*.type":
    case "apis.*.request.*.type":
    case "apis.*.response.*.type":
      return ok(FIELD_TYPES.has(v));
    case "dataModels.*.name":
      return ok(/^[A-Z][A-Za-z0-9]{0,63}$/.test(v));
    case "dataModels.*.fields.*.name":
    case "apis.*.request.*.name":
    case "apis.*.response.*.name":
      return ok(isIdentifier(v));
    case "dataModels.*.fields.*.values.*":
      return ok(isIdentifier(v) || cleanLabel(v, 3) === v);
    case "apis.*.method":
      return ok(HTTP_METHOD.test(v));
    case "apis.*.path":
      return ok(PATH_PATTERN.test(v));
    case "pricing.currency":
      return ok(/^[A-Z]{3}$/.test(v));
    case "formats.*.extension":
      return ok(/^[a-z0-9]{1,8}$/.test(v));
    case "formats.*.fields.*":
      return ok(isColumn(v));
    case "findings.*.observedAt":
      return ok(ISO_DATE.test(v));
    case "findings.*.source":
      return ok(FINDING_SOURCES.has(v));
    case "oss.*.name":
      return ok(/^@?[a-z0-9][\w.-]*(\/[\w.-]+)?$/i.test(v));
    case "oss.*.licence":
      return ok(/^[A-Za-z0-9.+-]{1,32}$/.test(v));
    case "flows.*.steps.*.fields.*":
      return ok(DESCRIPTOR.test(v));
    default: {
      if (path[path.length - 1] === "description" && v === "") return null;
      if (stripBrand(v, brands) === null) return "branding";
      return labelViolation(v);
    }
  }
}

function leaves(v: unknown, path: Path, out: { path: Path; value: string }[]) {
  if (typeof v === "string") out.push({ path, value: v });
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...path, i], out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], out);
  return out;
}

type Stream = { tokens: string[]; owners: (Path | null)[]; container: Path | null; key: string | null };

function jsonStream(spec: Spec): Stream {
  const { s, leaves: ls } = canonWithLeaves(spec);
  const toks = tokenizeAt(s);
  const owners: (Path | null)[] = [];
  let j = 0;
  for (const t of toks) {
    while (j < ls.length && ls[j].end <= t.at) j++;
    const leaf = ls[j] && ls[j].start <= t.at && t.at < ls[j].end ? ls[j] : null;
    owners.push(leaf && leaf.removable ? leaf.path : null);
  }
  return { tokens: toks.map((t) => t.token), owners, container: null, key: null };
}

/** Prose columns read in order across list elements (feature names one after another, and so on). */
function columnStreams(spec: Spec): Stream[] {
  const cols: [Path, string][] = [
    [["features"], "name"],
    [["features"], "description"],
    [["flows"], "name"],
    [["dataModels"], "name"],
    [["pricing", "plans"], "name"],
    [["complaints"], "theme"],
    [["findings"], "fact"],
    [["formats"], "name"],
    [["oss"], "name"],
    ...spec.flows.map((_, i): [Path, string] => [["flows", i, "steps"], "name"]),
  ];
  return cols.map(([container, key]) => {
    const arr = getAt(spec, container) as Record<string, unknown>[];
    const tokens: string[] = [];
    const owners: (Path | null)[] = [];
    arr.forEach((el, i) => {
      const v = el?.[key];
      if (typeof v !== "string") return;
      for (const t of tokenizeAt(v)) {
        tokens.push(t.token);
        owners.push([...container, i, key]);
      }
    });
    return { tokens, owners, container, key };
  });
}

function getAt(root: unknown, path: Path): unknown {
  let cur = root as Record<string | number, unknown> | undefined;
  for (const k of path) cur = cur?.[k] as Record<string | number, unknown> | undefined;
  return cur;
}

const NOT_REORDERABLE = new Set(["pricing.plans", "flows.*.steps"]);

type Action = { type: "remove"; path: Path; reason: string } | { type: "reorder"; path: Path; key: string | null; reason: string };

function sortedCopy(arr: unknown[], key: string | null): unknown[] {
  const k = (x: unknown) => (typeof x === "string" ? x : key && x && typeof x === "object" && typeof (x as Record<string, unknown>)[key] === "string" ? String((x as Record<string, unknown>)[key]) : canonicalJson(x));
  return [...arr].sort((a, b) => k(a).localeCompare(k(b)));
}

function applyActions(spec: Spec, actions: Action[]) {
  const reorders = actions.filter((a): a is Extract<Action, { type: "reorder" }> => a.type === "reorder");
  const inReordered = (p: Path) => reorders.some((r) => r.path.length < p.length && r.path.every((x, i) => p[i] === x));
  for (const r of reorders) {
    const arr = getAt(spec, r.path) as unknown[];
    const sorted = sortedCopy(arr, r.key);
    arr.splice(0, arr.length, ...sorted);
  }
  const removals = actions
    .filter((a): a is Extract<Action, { type: "remove" }> => a.type === "remove" && !inReordered(a.path))
    .map((a) => {
      const p = a.path;
      const last = p[p.length - 1];
      if (last === "description") return { kind: "set" as const, path: p, value: "" };
      if (pattern(p) === "pricing.plans.*.name") return { kind: "set" as const, path: p, value: `Tier ${(p[2] as number) + 1}` };
      let idx = -1;
      for (let i = p.length - 1; i >= 0; i--)
        if (typeof p[i] === "number") {
          idx = i;
          break;
        }
      if (idx < 0) return { kind: "set" as const, path: p, value: pattern(p) === "pricing.currency" ? "USD" : "" };
      return { kind: "drop" as const, path: p.slice(0, idx + 1) };
    });
  for (const r of removals.filter((x) => x.kind === "set")) {
    const parent = getAt(spec, r.path.slice(0, -1)) as Record<string | number, unknown>;
    if (parent) parent[r.path[r.path.length - 1]] = (r as { value: string }).value;
  }
  const drops = removals
    .filter((x) => x.kind === "drop")
    .map((x) => x.path)
    .filter((p, i, all) => all.findIndex((q) => pathStr(q) === pathStr(p)) === i)
    .sort((a, b) => b.length - a.length || (b[b.length - 1] as number) - (a[a.length - 1] as number));
  for (const p of drops) {
    const arr = getAt(spec, p.slice(0, -1));
    if (Array.isArray(arr)) arr.splice(p[p.length - 1] as number, 1);
  }
}

type Scan = { spans: number; actions: Action[]; unfixable: string[]; tokens: number };

function scan(spec: Spec, index: NgramIndex, brands: string[], reordered: Set<string>): Scan {
  const actions: Action[] = [];
  const unfixable: string[] = [];
  const touched = new Set<string>();
  for (const l of leaves(spec, [], [])) {
    const why = leafViolation(l.path, l.value, brands);
    if (why && !touched.has(pathStr(l.path))) {
      touched.add(pathStr(l.path));
      actions.push({ type: "remove", path: l.path, reason: `rule:${why}` });
    }
  }
  let spans = 0;
  let tokens = 0;
  for (const st of [jsonStream(spec), ...columnStreams(spec)]) {
    tokens += st.tokens.length;
    for (const span of sharedSpansInTokens(st.tokens, index)) {
      spans++;
      const len = span.end - span.start;
      const counts = new Map<string, { path: Path; n: number }>();
      for (const o of st.owners.slice(span.start, span.end)) {
        if (!o) continue;
        const k = pathStr(o);
        counts.set(k, { path: o, n: (counts.get(k)?.n ?? 0) + 1 });
      }
      if (!counts.size) {
        unfixable.push(`${len}-token span in fixed structure`);
        continue;
      }
      const owners = [...counts.values()].sort((a, b) => b.n - a.n || pathStr(a.path).localeCompare(pathStr(b.path)));
      const reason = `leak:${len}-token span`;
      // A run of short functional strings in one list (plan limits, CSV columns) that matches the page's own order is
      // rewritten by reordering the list once. Prose read across list elements is never reordered: it is removed.
      let container: Path | null = null;
      if (!st.container && owners.length > 1) {
        const parents = owners.map((o) => o.path.slice(0, -1));
        const same = parents.every((p) => pathStr(p) === pathStr(parents[0])) && owners.every((o) => typeof o.path[o.path.length - 1] === "number");
        container = same ? parents[0] : null;
      }
      if (container && !NOT_REORDERABLE.has(pattern(container)) && !reordered.has(pathStr(container))) {
        reordered.add(pathStr(container));
        const arr = getAt(spec, container) as unknown[];
        if (canonicalJson(sortedCopy(arr, null)) !== canonicalJson(arr)) {
          actions.push({ type: "reorder", path: container, key: null, reason: `${reason}, reordered` });
          continue;
        }
      }
      const target = owners[0].path;
      if (touched.has(pathStr(target))) continue;
      touched.add(pathStr(target));
      actions.push({ type: "remove", path: target, reason });
    }
  }
  return { spans, actions, unfixable, tokens };
}

/** The second pass: rules, then the n-gram scan, repeated until clean. Mutates `spec`; throws LeakageError. */
export function secondPass(spec: Spec, index: NgramIndex, brands: string[] = []): LeakageReport {
  const removed: string[] = [];
  const reordered = new Set<string>();
  let spans = 0;
  for (let pass = 0; pass < 64; pass++) {
    const s = scan(spec, index, brands, reordered);
    spans += s.spans;
    if (!s.actions.length) {
      if (s.unfixable.length || s.spans) throw new LeakageError(spans, s.unfixable.length ? s.unfixable : ["unresolved span"]);
      return { spans, removed, clean: true, scannedTokens: s.tokens, indexedTokens: index.tokens };
    }
    for (const a of s.actions) removed.push(`${pathStr(a.path)}: ${a.reason}`);
    applyActions(spec, s.actions);
  }
  throw new LeakageError(spans, ["did not converge", ...removed.slice(-4)]);
}

// ---- entry point ---------------------------------------------------------------------------------------------------

export async function filterSpec(analysis: ScoutAnalysis, artifacts: ScoutArtifact[], opts: FilterOptions): Promise<FilterResult> {
  const now = typeof opts.now === "function" ? opts.now() : opts.now;
  const day = isoDay(now);
  const brands = brandTerms(analysis);
  const ctx: Ctx = { brands, planNames: planNameMap(analysis) };
  const label = makeLabel(ctx);
  const index = scoutIndex(artifacts, SPAN_TOKENS);

  const pricing = buildPricing(analysis, ctx, label);
  const features = buildFeatures(analysis, pricing, label);
  let complaintsIn: { theme: string; weight: number }[] = analysis.themes;
  if (opts.llm) {
    const x = await llmExtract(opts.llm, analysis, opts.model ?? "anonymo-1");
    for (const f of x.features) {
      const name = label(f.name, 6);
      if (!name || features.some((e) => e.name.toLowerCase() === name.toLowerCase())) continue;
      const area = label(f.area, 3) ?? "General";
      features.push({ id: idFor("feat", name), name, area, description: label(f.description) ?? `Listed under ${area}`, evidence: ["llm"] });
    }
    complaintsIn = [...complaintsIn, ...x.complaints];
  }
  const spec: Spec = {
    features,
    flows: buildFlows(analysis, label),
    dataModels: buildDataModels(analysis, label, brands),
    apis: buildApis(analysis),
    pricing,
    complaints: buildThemes(complaintsIn, label),
    formats: buildFormats(analysis, label),
    findings: [],
    oss: buildOss(analysis, brands),
  };
  spec.findings = buildFindings(spec, analysis, day, ctx.planNames);

  const leakageScan = secondPass(spec, index, brands);
  const specHash = specHashOf(spec);
  return { spec, specHash, ref: { sha256: specHash, kind: "spec", zone: "CLEAN", name: "spec.json" }, leakageScan };
}

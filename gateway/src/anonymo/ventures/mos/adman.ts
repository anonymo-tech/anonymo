// WS11 · Adman Mo: landing copy, ad kits, comparison pages, switch offers and head-to-head ads (Ventures Overview §2–3,
// Backend PART 11 "adman: … claim checker (every comparison claim cites a Scout finding with a date)").
//
// Everything public is linted against the "what not to say" rules (copy.ts). Rival claims are only ever built from the
// Spec's dated findings: a model proposes rows and cites finding ids; checkClaims() keeps a row only when it cites a
// real finding, and the page prints that finding's date. The model never gets to state a fact about the rival itself.

import { askJson } from "../crew/ask.ts";
import { COPY_RULES_PROMPT, lintCopy, lintDeep } from "../copy.ts";
import { generateDesignSystem, renderComparison, renderLanding, type ComparisonRow, type DesignSystem, type LandingContent } from "../design/index.ts";
import type { RoleHandler, StepContext } from "../orchestrator.ts";
import type { Finding, Spec } from "../types.ts";
import type { VenturePlan } from "./strategist.ts";

const SYSTEM = `You are Adman Mo: blunt, specific, true. Short sentences, concrete benefits, no hype words. ${COPY_RULES_PROMPT} Reply with JSON only.`;

/** Removes strings that break the copy rules from a JSON value (arrays lose the item, objects lose the field). */
export function scrub<T>(value: T): { value: T; removed: string[] } {
  const removed: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === "string") {
      if (lintCopy(v).length) {
        removed.push(path);
        return undefined;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`)).filter((x) => x !== undefined);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const w = walk(x, `${path}.${k}`);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, "$") as T, removed };
}

export type ProposedRow = { feature: string; us: boolean | string; them: boolean | string; finding?: string };

/** The claim checker: a row that says anything about the rival must cite a real finding; uncited rows are dropped. */
export function checkClaims(rows: ProposedRow[], findings: Finding[]): { rows: ComparisonRow[]; dropped: ProposedRow[] } {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const kept: ComparisonRow[] = [];
  const dropped: ProposedRow[] = [];
  for (const r of rows) {
    const f = r.finding ? byId.get(r.finding) : undefined;
    if (!f || !f.observedAt || !r.feature) {
      dropped.push(r);
      continue;
    }
    kept.push({ feature: String(r.feature).slice(0, 80), us: r.us, them: r.them, source: { fact: f.fact, observedAt: f.observedAt } });
  }
  return { rows: kept, dropped };
}

async function designOf(s: StepContext): Promise<DesignSystem> {
  const ref = s.needs.design?.find((r) => r.name === "design");
  return ref ? s.json<DesignSystem>(ref) : generateDesignSystem(s.venture.id);
}

async function planOf(s: StepContext): Promise<VenturePlan> {
  const ref = s.needs.plan?.find((r) => r.name === "plan") ?? s.needs.parity?.find((r) => r.name === "plan");
  if (!ref) throw new Error("no plan to write copy from");
  return s.json<VenturePlan>(ref);
}

export const landingCopy: RoleHandler = async (s) => {
  const plan = await planOf(s);
  const brand = s.input.brand || plan.name || "New venture";
  const { value } = await askJson<LandingContent>(
    s,
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Brand: ${brand}\nPlan:\n${JSON.stringify(plan).slice(0, 6000)}\n\nWrite the landing page. JSON: {"brand":"${brand}","eyebrow":"short kicker","tagline":"≤ 8 words","subhead":"≤ 30 words","cta":"button label","features":[{"title":"…","body":"≤ 25 words","icon":"one of: bolt, shield, chart, sparkle, layers, clock, users, lock, globe, rocket, check, code"}] (4 to 6),"steps":[{"title":"…","body":"…"}] (3),"stats":[{"label":"…","value":"…"}] (3, only facts about the product itself),"faq":[{"q":"…","a":"…"}] (4),"ctaHeadline":"…","ctaBody":"…"}`,
      },
    ],
    { maxTokens: 2000 },
  );
  const { value: clean, removed } = scrub(value);
  if (removed.length) s.log(`copy rules removed ${removed.length} line(s)`);
  const content: LandingContent = {
    ...clean,
    brand,
    tagline: clean.tagline || plan.positioning.slice(0, 60),
    subhead: clean.subhead || plan.problem.slice(0, 160),
    cta: clean.cta || "Get started",
    features: Array.isArray(clean.features) && clean.features.length ? clean.features.slice(0, 6) : plan.mvpFeatures.map((f) => ({ title: f.title, body: f.description.slice(0, 140) })),
    pricing: plan.pricing.map((p, i) => ({ name: p.name, priceUsdMonthly: p.priceUsdMonthly, features: p.features, highlight: i === 1 })),
  };
  await s.put({ kind: "copy", name: "landing-copy", mime: "application/json", body: JSON.stringify(content) });
};

export type AdKit = { hooks: string[]; ads: { channel: string; headline: string; body: string; cta: string; angle?: string }[]; posts: { channel: string; text: string }[]; emails: { subject: string; body: string; sendDay: number }[] };

export const adKit: RoleHandler = async (s) => {
  const plan = await planOf(s);
  const { value } = await askJson<AdKit>(
    s,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Plan:\n${JSON.stringify(plan).slice(0, 6000)}\n\nWrite the ad kit. JSON: {"hooks":["10 one-line hooks"],"ads":[{"channel":"x|reddit|meta|google|tiktok","headline":"…","body":"…","cta":"…","angle":"…"}] (12),"posts":[{"channel":"x|reddit|producthunt|hn","text":"…"}] (5 launch posts),"emails":[{"subject":"…","body":"…","sendDay":0}] (4-email welcome sequence)}` },
    ],
    { maxTokens: 3000 },
  );
  const { value: clean, removed } = scrub(value);
  if (removed.length) s.log(`copy rules removed ${removed.length} line(s)`);
  await s.put({ kind: "copy", name: "adkit", mime: "application/json", body: JSON.stringify(clean) });
};

async function proposeComparison(s: StepContext, spec: Spec, plan: VenturePlan, brand: string, rival: string) {
  const findings = spec.findings.map((f) => ({ id: f.id, fact: f.fact, observedAt: f.observedAt }));
  const { value } = await askJson<{ intro: string; rows: ProposedRow[]; switchOffer: string; cta: string }>(
    s,
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `We are ${brand}. The rival is ${rival}.\nOur plan:\n${JSON.stringify({ parity: plan.parity, gaps: plan.gaps, pricing: plan.pricing }).slice(0, 5000)}\nDated findings about the rival (the ONLY facts you may use about them):\n${JSON.stringify(findings).slice(0, 6000)}\n\nWrite a head-to-head comparison. Every row must cite exactly one finding id that supports what the row says about ${rival}. JSON: {"intro":"≤ 40 words","rows":[{"feature":"…","us":true|false|"short text","them":true|false|"short text","finding":"finding id"}] (6 to 14),"switchOffer":"…","cta":"…"}`,
      },
    ],
    { maxTokens: 2200 },
  );
  return value;
}

export const comparison: RoleHandler = async (s) => {
  const spec = await s.json<Spec>(s.need("spec", "spec"));
  const plan = await planOf(s);
  const ds = await designOf(s);
  const brand = s.input.brand || plan.name || "Us";
  const rival = s.input.rival || "the incumbent";
  const v = await proposeComparison(s, spec, plan, brand, rival);
  const { rows, dropped } = checkClaims(Array.isArray(v.rows) ? v.rows : [], spec.findings);
  if (dropped.length) s.log(`claim checker dropped ${dropped.length} uncited row(s)`);
  const { value: clean } = scrub({ intro: v.intro, switchOffer: v.switchOffer, cta: v.cta });
  const lintedRows = rows.filter((r) => !lintDeep([r.feature, r.us, r.them]).length);
  const html = renderComparison(ds, { brand, rival, rows: lintedRows, intro: clean.intro, switchOffer: clean.switchOffer, cta: clean.cta || "Switch now" });
  await s.put({ kind: "page", name: "comparison", mime: "text/html", body: html });
  await s.put({ kind: "copy", name: "comparison-claims", mime: "application/json", body: JSON.stringify({ rows: lintedRows, dropped: dropped.length }) });
};

/** "Switch from X": the offer, an "alternative to X" landing page, and migration notes built on their export formats. */
export const switchKit: RoleHandler = async (s) => {
  const spec = await s.json<Spec>(s.need("spec", "spec"));
  const plan = await planOf(s);
  const ds = await designOf(s);
  const brand = s.input.brand || plan.name || "Us";
  const rival = s.input.rival || "your current tool";
  const { value } = await askJson<{ offer: { title: string; body: string; cta: string }; page: LandingContent; migration: string[] }>(
    s,
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `We are ${brand}, the alternative to ${rival}. Their users complain about: ${JSON.stringify(spec.complaints.map((c) => c.theme))}. Their export formats: ${JSON.stringify(spec.formats)}.\nOur plan:\n${JSON.stringify(plan).slice(0, 4000)}\n\nJSON: {"offer":{"title":"…","body":"…","cta":"…"},"page":{"brand":"${brand}","eyebrow":"The ${rival} alternative","tagline":"…","subhead":"…","cta":"…","features":[{"title":"…","body":"…","icon":"bolt|shield|chart|sparkle|layers|clock|users|lock|globe|rocket|check|code"}],"faq":[{"q":"…","a":"…"}]},"migration":["step-by-step: how to move from ${rival} with our one-click import"]}`,
      },
    ],
    { maxTokens: 2400 },
  );
  const { value: clean, removed } = scrub(value);
  if (removed.length) s.log(`copy rules removed ${removed.length} line(s)`);
  const page = renderLanding(ds, { ...clean.page, brand, cta: clean.page?.cta || clean.offer?.cta || "Switch now", tagline: clean.page?.tagline || `The ${rival} alternative`, subhead: clean.page?.subhead || "", features: clean.page?.features ?? [] });
  await s.put({ kind: "page", name: "alternative", mime: "text/html", body: page });
  await s.put({ kind: "copy", name: "switch", mime: "application/json", body: JSON.stringify({ offer: clean.offer, migration: clean.migration ?? [] }) });
};

/** Takeover ads: 30 ads aimed at the rival's complaint themes. */
export const takeoverAds: RoleHandler = async (s) => {
  const spec = await s.json<Spec>(s.need("spec", "spec"));
  const plan = await planOf(s);
  const brand = s.input.brand || plan.name || "Us";
  const rival = s.input.rival || "the incumbent";
  const ads: AdKit["ads"] = [];
  for (let round = 0; round < 3 && ads.length < 30; round++) {
    const { value } = await askJson<{ ads: AdKit["ads"] }>(
      s,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `We are ${brand}. Write ${30 - ads.length} ads for unhappy ${rival} users. Aim each ad at one of these complaint themes: ${JSON.stringify(spec.complaints.map((c) => c.theme))}. Only claim what our plan delivers: ${JSON.stringify(plan.mvpFeatures.map((f) => f.title))}. JSON: {"ads":[{"channel":"x|reddit|meta|google|tiktok","headline":"…","body":"…","cta":"…","angle":"the complaint theme"}]}` },
      ],
      { maxTokens: 3500 },
    );
    const { value: clean } = scrub(value);
    for (const a of clean.ads ?? []) if (a?.headline && a?.body && ads.length < 30) ads.push(a);
  }
  await s.put({ kind: "copy", name: "ads", mime: "application/json", body: JSON.stringify({ ads }) });
  s.log(`${ads.length} ads`);
};

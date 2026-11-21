// WS11 · Scout: the plan grid on a public pricing page (Ventures Backend spec, PART 4: "Public data: pricing pages").
//
// Two layouts are read: plan cards (one heading and one price per card) and comparison tables (plan names across the
// header row). Card list items that carry a number or "unlimited" are limits; the rest are features.

import type { Plan, PlanGrid } from "../types.ts";
import { byTag, findAll, isNode, textOf, type HtmlNode } from "./html.ts";

const PRICE = /([$€£])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s*(?:\/|per|a)\s*(user|seat|member)?\s*\/?\s*(mo|month|monthly|yr|year|annum|annually))?/i;
const ZERO = /^\s*free\b|\$0\b/i;
const CUSTOM = /\b(custom|contact (us|sales)|talk to (us|sales)|get a quote|let'?s talk)\b/i;
const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

export type ParsedPrice = { amount: number | null; currency: string; perUser: boolean };

export function parsePrice(text: string): ParsedPrice | null {
  const m = PRICE.exec(text);
  if (m) {
    const n = Number(m[2].replace(/,/g, ""));
    const yearly = !!m[4] && /^(yr|year|annum|annually)$/i.test(m[4]);
    return { amount: yearly ? Math.round((n / 12) * 100) / 100 : n, currency: CURRENCY[m[1]] ?? "USD", perUser: !!m[3] || /per (user|seat|member)/i.test(text) };
  }
  if (ZERO.test(text)) return { amount: 0, currency: "USD", perUser: false };
  if (CUSTOM.test(text)) return { amount: null, currency: "USD", perUser: false };
  return null;
}

const isLimit = (s: string) => /\d|\bunlimited\b|\bup to\b/i.test(s);
const HEADINGS = ["h2", "h3", "h4", "h5"];

function cards(root: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = [];
  const visit = (n: HtmlNode): boolean => {
    let childQualified = false;
    for (const c of n.children) if (isNode(c) && visit(c)) childQualified = true;
    if (childQualified) return true;
    if (!["section", "div", "article", "li", "td"].includes(n.tag)) return false;
    const heads = findAll(n, byTag(...HEADINGS));
    if (heads.length !== 1) return false;
    const rest = textOf(n).replace(textOf(heads[0]), "");
    if (!parsePrice(rest) && !ZERO.test(textOf(heads[0]))) return false;
    out.push(n);
    return true;
  };
  visit(root);
  return out;
}

function planFromCard(card: HtmlNode): Plan & { currency: string } {
  const head = findAll(card, byTag(...HEADINGS))[0];
  const name = textOf(head);
  const priceText = findAll(card, (n) => /price|cost|amount/i.test(n.attrs.class ?? "")).map(textOf)[0] ?? textOf(card).replace(name, "");
  const price = parsePrice(priceText) ?? parsePrice(name) ?? { amount: null, currency: "USD", perUser: false };
  const items = findAll(card, byTag("li")).map(textOf).filter(Boolean);
  const limits = items.filter(isLimit);
  if (price.perUser) limits.unshift("Priced per user");
  return { name, priceUsdMonthly: price.amount, limits, features: items.filter((i) => !isLimit(i)), currency: price.currency };
}

function planTable(root: HtmlNode): (Plan & { currency: string })[] {
  for (const table of findAll(root, byTag("table"))) {
    const rows = findAll(table, byTag("tr")).map((tr) => findAll(tr, byTag("th", "td")).map(textOf));
    if (rows.length < 2 || rows[0].length < 3) continue;
    const names = rows[0].slice(1);
    const priceRow = rows.find((r) => r.slice(1).some((c) => PRICE.test(c)));
    if (!priceRow) continue;
    const plans = names.map((name, i) => {
      const p = parsePrice(priceRow[i + 1] ?? "") ?? { amount: null, currency: "USD", perUser: false };
      return { name, priceUsdMonthly: p.amount, limits: [] as string[], features: [] as string[], currency: p.currency };
    });
    for (const r of rows.slice(1)) {
      if (r === priceRow) continue;
      const label = r[0];
      r.slice(1).forEach((cell, i) => {
        const plan = plans[i];
        if (!plan || !label) return;
        if (/^(✓|✔|yes|included|true)$/i.test(cell)) plan.features.push(label);
        else if (cell && !/^(—|-|–|no|✗|✕|x)$/i.test(cell)) plan.limits.push(`${label}: ${cell}`);
      });
    }
    return plans;
  }
  return [];
}

/** The plan grid on a page, or null when the page shows fewer than two plans. Plan names are the page's own. */
export function extractPricing(root: HtmlNode): PlanGrid | null {
  let plans = cards(root).map(planFromCard);
  if (plans.length < 2) plans = planTable(root);
  if (plans.length < 2) return null;
  const currency = plans.find((p) => p.priceUsdMonthly !== null)?.currency ?? "USD";
  return { currency, plans: plans.map(({ currency: _c, ...p }) => p) };
}

export const looksLikePricingPath = (path: string) => /\/(pricing|plans|prices)(\/|$|\?)/i.test(path);

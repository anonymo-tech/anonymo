// WS11 · Scout: review themes and job-board links (Ventures Backend spec, PART 4: "public job boards (optional, link
// discovery only), review themes (no review text stored — only themes)").
//
// Review pages are read in memory, reduced to a fixed vocabulary of complaint themes with weights, and dropped. No
// review text is kept as an artifact or in the analysis. An optional Llm may name themes instead; its labels are cut to
// four words and still pass the Spec Filter's rules and leakage scan.

import type { Llm } from "../llm.ts";
import { parseJsonReply } from "../llm.ts";
import type { Theme } from "../types.ts";

const NEGATIVE = /\b(not|no|never|can'?t|cannot|won'?t|doesn'?t|didn'?t|isn'?t|lack|lacks|missing|wish|hard|difficult|slow|expensive|pricey|overpriced|bug|buggy|broken|crash|crashes|poor|bad|terrible|annoying|confusing|frustrat\w*|clunky|limited|fails?|failed)\b/i;

export const THEME_LEXICON: { id: string; theme: string; re: RegExp }[] = [
  { id: "price", theme: "Price", re: /\b(price|pricing|expensive|pricey|overpriced|cost|costs|cheap)\b/i },
  { id: "speed", theme: "Speed", re: /\b(slow|lag|laggy|loading|performance|sluggish)\b/i },
  { id: "support", theme: "Support", re: /\b(support|customer service|response time|help desk)\b/i },
  { id: "bugs", theme: "Bugs", re: /\b(bug|bugs|buggy|crash|crashes|glitch|broken|error)\b/i },
  { id: "import-export", theme: "Import and export", re: /\b(import|export|csv|migrat\w*)\b/i },
  { id: "integrations", theme: "Integrations", re: /\b(integration|integrations|integrate|sync|zapier|webhook)\b/i },
  { id: "mobile", theme: "Mobile", re: /\b(mobile|ios|android|phone)\b/i },
  { id: "ease-of-use", theme: "Ease of use", re: /\b(confusing|interface|ui|ux|learning curve|hard to use|clunky|unintuitive)\b/i },
  { id: "billing", theme: "Billing", re: /\b(billing|charged|refund|cancel\w*|invoice fees)\b/i },
];

/** Complaint themes in review text, weighted by the share of complaining sentences that raise each one. */
export function reviewThemes(texts: string[]): Theme[] {
  const counts = new Map<string, number>();
  let complaints = 0;
  for (const t of texts) {
    for (const sentence of t.split(/(?<=[.!?])\s+|\n+/)) {
      if (!NEGATIVE.test(sentence)) continue;
      const hits = THEME_LEXICON.filter((x) => x.re.test(sentence));
      if (!hits.length) continue;
      complaints++;
      for (const h of hits) counts.set(h.id, (counts.get(h.id) ?? 0) + 1);
    }
  }
  if (!complaints) return [];
  return THEME_LEXICON.filter((x) => counts.has(x.id))
    .map((x) => ({ id: x.id, theme: x.theme, weight: Math.round((counts.get(x.id)! / complaints) * 100) / 100 }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/** Theme labels from an Llm, cut to four words; falls back to the lexicon when the reply is unusable. */
export async function llmReviewThemes(llm: Llm, texts: string[]): Promise<Theme[]> {
  try {
    const reply = await llm.call({
      model: "anonymo-1",
      json: true,
      maxTokens: 400,
      messages: [
        { role: "system", content: 'Name the complaint themes in these reviews. Reply JSON {"themes":[{"theme":"two or three words","weight":0..1}]}. Never quote the reviews.' },
        { role: "user", content: texts.join("\n---\n").slice(0, 12_000) },
      ],
    });
    const j = parseJsonReply<{ themes?: { theme?: unknown; weight?: unknown }[] }>(reply.text);
    const themes = (j?.themes ?? [])
      .filter((t) => typeof t.theme === "string" && t.theme.trim())
      .map((t) => {
        const theme = String(t.theme).trim().split(/\s+/).slice(0, 4).join(" ");
        const w = typeof t.weight === "number" && Number.isFinite(t.weight) ? Math.min(1, Math.max(0, t.weight)) : 0.5;
        return { id: theme.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), theme, weight: Math.round(w * 100) / 100 };
      })
      .filter((t) => t.id);
    return themes.length ? themes : reviewThemes(texts);
  } catch {
    return reviewThemes(texts);
  }
}

const JOB_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|workable\.com|ashbyhq\.com|recruitee\.com|bamboohr\.com|smartrecruiters\.com|workday\.com|personio\.\w+|teamtailor\.com|wellfound\.com)$/i;

/** A public job board link (followed only when same-site; off-site boards are recorded, never crawled). */
export function isJobLink(url: string, label: string): boolean {
  try {
    const u = new URL(url);
    return JOB_HOSTS.test(u.hostname) || /\/(careers|jobs|join-us|work-with-us|hiring)(\/|$)/i.test(u.pathname) || /^(careers|jobs|we'?re hiring)$/i.test(label.trim());
  } catch {
    return false;
  }
}

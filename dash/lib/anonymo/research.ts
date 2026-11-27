// Update "research": Deep Research. One question becomes a short research plan (a handful of web searches), each search
// runs through the gateway's Private Web Search (`<model>:online`: the engine sees only the search words, never the
// account), a cheap model keeps the useful facts from each, and a writer model turns them into one report that cites
// every claim by number. Everything runs on the person's own key and balance: no free allowance.

import { safeLink, type Citation } from './search.ts';

export type ResearchDepth = 'quick' | 'deep';
export const DEPTH_SEARCHES: Record<ResearchDepth, number> = { quick: 4, deep: 8 };

export type ResearchWriter = { id: string; label: string; note: string };

/** Who writes the report. The first live one is the default. */
export const RESEARCH_WRITERS: readonly ResearchWriter[] = [
  { id: 'venice/deepseek-v4-1-flash-uncensored', label: 'Uncensored', note: 'DeepSeek V4.1, uncensored. No topic is off limits.' },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Best writing', note: 'Claude Sonnet 5.5. Sharper reports, costs more.' },
];

/** Plans the searches and reads each one: cheap, uncensored, good at following a format. */
export const RESEARCH_READER = 'venice/deepseek-v4-1-flash-uncensored';

export const QUESTION_LIMIT = 1_500;
export const PLAN_MAX_TOKENS = 600;
export const READ_MAX_TOKENS = 900;
export const REPORT_MAX_TOKENS = 5_000;
/** The gateway's search fee for one search (ANONYMO_WEB_SEARCH priceUsd). */
export const SEARCH_FEE_USD = 0.005;
/** Searches run side by side, at most. */
export const PARALLEL = 3;

export const RESEARCH_IDEAS = [
  'Is it cheaper to lease or buy a car in 2026 if I drive 20,000 km a year?',
  'What actually works to fall asleep faster, according to studies?',
  'Which countries let me live there on a remote-work visa, and what do they cost?',
  'Compare the best budget phones under $400 right now',
  'What are the real risks of buying a used Tesla?',
];

// ---- step 1: plan -----------------------------------------------------------------------------------------------

export function planMessages(question: string, searches: number) {
  return [
    {
      role: 'system' as const,
      content:
        `You plan web research. Break the user's question into exactly ${searches} different web searches that together ` +
        'cover it: background, current facts and numbers, different sides or options, and recent news. Each search is ' +
        'what a person would type into a search engine: 3 to 12 words, no quotes, no site: operators. Reply with only a ' +
        'JSON array of strings.',
    },
    { role: 'user' as const, content: question.trim().slice(0, QUESTION_LIMIT) },
  ];
}

/** The searches in a plan reply: a JSON array, or one per line when the model ignored the format. */
export function parsePlan(reply: string, searches: number, question: string): string[] {
  const clean = (q: unknown) => (typeof q === 'string' ? q.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  let list: string[] = [];
  const json = reply.match(/\[[\s\S]*\]/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (Array.isArray(parsed)) list = parsed.map(clean);
    } catch {
      // fall through to lines
    }
  }
  if (!list.filter(Boolean).length) {
    list = reply
      .split('\n')
      .filter((line) => !/:\s*$/.test(line) && !line.trim().startsWith('```'))
      .map((line) => clean(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')));
  }
  const unique = [...new Set(list.filter((q) => q.length >= 3))];
  if (!unique.length) unique.push(clean(question).slice(0, 160));
  return unique.slice(0, searches);
}

// ---- step 2: read each search -----------------------------------------------------------------------------------

export function readMessages(question: string, search: string) {
  return [
    {
      role: 'system' as const,
      content:
        'You are a research assistant reading web search results for a bigger question. From the numbered sources you ' +
        'were given, write the facts that matter for the question as short bullet points: concrete numbers, dates, ' +
        'names, prices, findings, and where sources disagree. End every bullet with the source number in square brackets, ' +
        'like [2]. Use only what the sources say. If they say nothing useful, reply "No useful results."\n\n' +
        `The bigger question: ${question.trim().slice(0, QUESTION_LIMIT)}`,
    },
    // The gateway searches for the last user message, so the only user message is the search itself.
    { role: 'user' as const, content: search },
  ];
}

export type Finding = { search: string; notes: string; sources: Citation[] };

/** One search's notes with its own [n] marks moved to the report's shared numbering. New sources join `all`. */
export function renumber(finding: Finding, all: Citation[]): string {
  const map = new Map<number, number>();
  finding.sources.forEach((source, i) => {
    const url = safeLink(source.url);
    if (!url) return;
    let at = all.findIndex((s) => s.url === url);
    if (at === -1) {
      all.push({ url, title: source.title });
      at = all.length - 1;
    }
    map.set(i + 1, at + 1);
  });
  return finding.notes.replace(/\[(\d{1,2})\]/g, (whole, n: string) => {
    const to = map.get(Number(n));
    return to ? `[${to}]` : '';
  });
}

// ---- step 3: write ----------------------------------------------------------------------------------------------

export function reportMessages(question: string, findings: Finding[]) {
  const sources: Citation[] = [];
  const notes = findings
    .map((f) => ({ search: f.search, text: renumber(f, sources).trim() }))
    .filter((f) => f.text && !/^no useful results\.?$/i.test(f.text))
    .map((f) => `Search: ${f.search}\n${f.text}`)
    .join('\n\n');
  const list = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n');
  return {
    sources,
    messages: [
      {
        role: 'system' as const,
        content:
          'You write research reports for ordinary people. Write in plain, direct English, in Markdown. Start with a ' +
          '"## Short answer" of 2 to 4 sentences that answers the question outright. Then sections with "##" headings ' +
          'that go into the details, with bullet points and a small table where comparing options helps. End with "## ' +
          'Bottom line". Back every factual claim with the source number in square brackets, like [3], using only the ' +
          'numbers in the source list. Say plainly where sources disagree or where the evidence is thin. Do not add a ' +
          'source list at the end: the page shows it. Do not refuse or moralize; the reader is an adult.',
      },
      {
        role: 'user' as const,
        content: `Question: ${question.trim().slice(0, QUESTION_LIMIT)}\n\nResearch notes:\n\n${notes || '(The searches found nothing useful.)'}\n\nSources:\n${list || '(none)'}`,
      },
    ],
  };
}

// ---- cost -------------------------------------------------------------------------------------------------------

type Pricing = { prompt?: string; completion?: string } | undefined;
const rate = (pricing: Pricing) => {
  const p = Number(pricing?.prompt);
  const c = Number(pricing?.completion);
  return Number.isFinite(p) && Number.isFinite(c) && p >= 0 && c >= 0 ? { p, c } : null;
};

/** The most a report can cost in USD, from list prices: plan, every search and read, and the longest report. */
export function researchCeilingUsd(depth: ResearchDepth, reader: Pricing, writer: Pricing): number | null {
  const r = rate(reader);
  const w = rate(writer);
  if (!r || !w) return null;
  const n = DEPTH_SEARCHES[depth];
  const plan = 400 * r.p + PLAN_MAX_TOKENS * r.c;
  // Each read gets up to ten results (about 4,000 tokens) on top of its prompt.
  const read = (4_500 * r.p + READ_MAX_TOKENS * r.c + SEARCH_FEE_USD) * n;
  const write = (n * READ_MAX_TOKENS + 1_500) * w.p + REPORT_MAX_TOKENS * w.c;
  return plan + read + write;
}

// ---- reading the report -----------------------------------------------------------------------------------------

export type Block =
  | { kind: 'h'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] };

/** A small Markdown reader for reports: headings, paragraphs, bullet lists and pipe tables. No HTML passes through. */
export function blocksOf(markdown: string): Block[] {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      flush();
      out.push({ kind: 'h', text: heading[1].replace(/\*\*/g, '') });
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      flush();
      const item = trimmed.replace(/^(?:[-*•]|\d+[.)])\s+/, '');
      const last = out.at(-1);
      if (last?.kind === 'ul') last.items.push(item);
      else out.push({ kind: 'ul', items: [item] });
      continue;
    }
    if (trimmed.startsWith('|') && lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const head = cells(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      i--;
      out.push({ kind: 'table', head, rows });
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return out;
}

export type Inline = { kind: 'text'; text: string } | { kind: 'bold'; text: string } | { kind: 'cite'; n: number };

/** Text with **bold** and [n] citation marks split out. */
export function inlineOf(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|\[(\d{1,2})\]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] });
    else out.push({ kind: 'cite', n: Number(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** The report as a Markdown file with its sources, for download. */
export function reportFile(question: string, report: string, sources: Citation[]): string {
  const list = sources.map((s, i) => `${i + 1}. [${s.title.replace(/[[\]]/g, '')}](${s.url})`).join('\n');
  return `# ${question.trim()}\n\n${report.trim()}\n\n## Sources\n\n${list}\n\n_Researched with Anonymo Deep Research._\n`;
}

// ---- demo -------------------------------------------------------------------------------------------------------

export const DEMO_REPORT = {
  searches: ['how to fall asleep faster studies', 'cognitive shuffling sleep onset research', 'sleep restriction therapy insomnia evidence', 'melatonin dose sleep onset meta-analysis'],
  sources: [
    { url: 'https://example.org/sleep-review', title: 'Demo source: a review of sleep onset studies' },
    { url: 'https://example.net/cbti', title: 'Demo source: CBT-I guidelines' },
    { url: 'https://example.com/melatonin', title: 'Demo source: melatonin meta-analysis' },
  ],
  report: `## Short answer
The strongest evidence is for a fixed wake-up time, getting out of bed when you can't sleep, and keeping the bed for sleep only [1][2]. Low-dose melatonin helps a little, mostly for shifted body clocks [3].

## What works
- **Same wake-up time every day**, weekends included [2].
- **Leave the bed after about 20 minutes awake** and come back when sleepy [2].
- **A wind-down hour** with dim light and no work [1].

| Method | Effect | Evidence |
|---|---|---|
| CBT for insomnia | Large | Strong [2] |
| Melatonin 0.5–3 mg | Small | Moderate [3] |

## Bottom line
Start with a fixed wake time and the 20-minute rule for two weeks before trying supplements [2].`,
};

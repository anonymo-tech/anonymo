// WS11 · the words (Ventures Overview §11 "What not to say" and §12 "Launch lines").
//
// lintCopy() runs on everything the crew writes for the public (ads, landing pages, comparison pages, posts, emails),
// so no output promises money, sounds like gambling, claims an endorsement, or calls the product a cloning tool.

export const LAUNCH_LINES = [
  "Point the crew at any business. Get a better one, live.",
  "Their features. Their gaps. Your version, shipped tonight.",
  "Many models. No refusals. One crew.",
  "Dupe the bestseller. Keep your brand.",
  "Every build receipted on Robinhood Chain.",
] as const;

export const SAY_INSTEAD = ["build the better version", "parity plus", "rebuild", "dupe"] as const;

export type CopyHit = { rule: string; match: string; index: number };

const RULES: { rule: string; re: RegExp }[] = [
  // Money and gambling words.
  { rule: "no-earn", re: /\bearn(?:s|ed|ing|ings)?\b/gi },
  { rule: "no-yield", re: /\byields?\b/gi },
  { rule: "no-apy", re: /\bapy\b|\bapr\b/gi },
  { rule: "no-guarantee", re: /\bguarantee(?:d|s)?\b/gi },
  { rule: "no-bet", re: /\bbet(?:s|ting)?\b/gi },
  { rule: "no-odds", re: /\bodds\b/gi },
  { rule: "no-gamble", re: /\bgambl(?:e|es|ed|ing)\b/gi },
  // Endorsement words.
  { rule: "no-partner", re: /\bpartner(?:s|ed|ship|ships)?\b/gi },
  { rule: "no-official", re: /\bofficial(?:ly)?\b/gi },
  { rule: "no-audited", re: /\baudit(?:ed)?\b/gi },
  // Cloning words.
  { rule: "no-clone-any-site", re: /\bclone\s+(?:any|every|their)\s+(?:site|app|store|website)s?\b/gi },
  { rule: "no-copy-their-code", re: /\bcopy\s+(?:their|the)\s+code\b/gi },
  { rule: "no-steal", re: /\bsteal(?:s|ing)?\s+(?:their|the)\s+(?:store|site|app|customers?|code)\b/gi },
  // Promising a venture will make money.
  { rule: "no-income-promise", re: /\b(?:make|making|made)\s+(?:you\s+)?(?:money|\$\d[\d,]*|\d+k)\b|\bpassive income\b|\bget rich\b/gi },
];

export function lintCopy(text: string): CopyHit[] {
  const hits: CopyHit[] = [];
  for (const { rule, re } of RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ rule, match: m[0], index: m.index ?? 0 });
  }
  return hits.sort((a, b) => a.index - b.index);
}

export const copyIsClean = (text: string) => lintCopy(text).length === 0;

/** Lints every string inside a JSON-like value; returns the paths that broke a rule. */
export function lintDeep(value: unknown, path = "$"): { path: string; hits: CopyHit[] }[] {
  if (typeof value === "string") {
    const hits = lintCopy(value);
    return hits.length ? [{ path, hits }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => lintDeep(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => lintDeep(v, `${path}.${k}`));
  return [];
}

/** The rules in words, for prompts: models are told up front, and their output is linted afterwards anyway. */
export const COPY_RULES_PROMPT = [
  "Never use these words: earn, yield, APY, guaranteed, bet, odds, gamble, partner, official, audited.",
  'Never say "clone any site", "copy their code" or "steal their store"; say "build the better version", "parity plus", "rebuild" or "dupe".',
  "Never promise that anyone will make money.",
  "Every claim about a rival must be true and come from the facts you are given, with their dates.",
].join(" ");

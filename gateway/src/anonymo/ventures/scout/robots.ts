// WS11 · Scout: robots.txt (Ventures Backend spec, PART 4: "Respect robots.txt").
//
// RFC 9309 matching (longest rule wins, Allow wins a tie, `*` and `$` wildcards), applied conservatively: a path is
// allowed only when BOTH the `*` group and the AnonymoScout group allow it. A robots.txt that fails with 5xx or a network
// error means "disallow everything"; a 4xx means "no rules".

import { SCOUT_UA_TOKEN } from "./types.ts";

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[]; crawlDelay: number | null };

export type Robots = {
  found: boolean;
  allowed(pathAndQuery: string): boolean;
  crawlDelayMs: number | null;
  sitemaps: string[];
};

export function parseRobots(text: string, uaToken = SCOUT_UA_TOKEN): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [], crawlDelay: null }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      if (value) cur.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
    }
  }
  const ua = uaToken.toLowerCase();
  const star = groups.filter((g) => g.agents.includes("*"));
  const ours = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const applicable = [star, ours].filter((gs) => gs.length > 0).map((gs) => gs.flatMap((g) => g.rules));
  const delays = [...star, ...ours].map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return {
    found: true,
    sitemaps,
    crawlDelayMs: delays.length ? Math.min(30_000, Math.max(...delays) * 1000) : null,
    allowed: (path) => applicable.every((rules) => allowedBy(rules, path)),
  };
}

export const allowAllRobots = (): Robots => ({ found: false, allowed: () => true, crawlDelayMs: null, sitemaps: [] });
export const denyAllRobots = (): Robots => ({ found: false, allowed: () => false, crawlDelayMs: null, sitemaps: [] });

function allowedBy(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  let bestLen = -1;
  for (const r of rules) {
    if (!matches(r.pattern, path)) continue;
    const len = r.pattern.length;
    if (len > bestLen || (len === bestLen && r.allow)) {
      best = r;
      bestLen = len;
    }
  }
  return best ? best.allow : true;
}

export function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(safeDecode(path));
}

function safeDecode(p: string) {
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

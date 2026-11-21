// WS11 · Scout: open-source projects the target ships (Ventures Backend spec, PART 4: "open-source projects the target
// uses (from bundle licence headers like `/*! name vX | MIT */`, `@license`, and package.json-style markers)").

import type { OssMarker } from "./types.ts";

const SPDX: [RegExp, string][] = [
  [/\bMIT\b/i, "MIT"],
  [/\bApache(?:[- ]License)?[- ]?(?:v|version )?2(?:\.0)?\b/i, "Apache-2.0"],
  [/\bBSD[- ]3[- ]Clause\b/i, "BSD-3-Clause"],
  [/\bBSD[- ]2[- ]Clause\b/i, "BSD-2-Clause"],
  [/\b0BSD\b/i, "0BSD"],
  [/\bISC\b/, "ISC"],
  [/\bMPL[- ]?2(?:\.0)?\b|Mozilla Public License,? (?:v|version )?2/i, "MPL-2.0"],
  [/\bLGPL[- ]?(?:v)?3/i, "LGPL-3.0"],
  [/\bLGPL/i, "LGPL"],
  [/\bAGPL/i, "AGPL-3.0"],
  [/\bGPL[- ]?(?:v)?3/i, "GPL-3.0"],
  [/\bGPL[- ]?(?:v)?2/i, "GPL-2.0"],
  [/\bCC0\b/i, "CC0-1.0"],
  [/\bUnlicense\b/i, "Unlicense"],
  [/\bBSD\b/, "BSD"],
];

export function spdxOf(text: string): string | null {
  for (const [re, id] of SPDX) if (re.test(text)) return id;
  return null;
}

const HEADER = /\/\*[!*]([\s\S]{0,600}?)\*\//g;
const NAME_VERSION = /(?:^|[\s*!])(@?[A-Za-z][\w.-]*(?:\/[\w.-]+)?)\s+v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/;
const PKG = /"name"\s*:\s*"(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)"\s*,\s*"version"\s*:\s*"(\d+\.\d+\.\d+[\w.-]*)"/g;
const NODE_MODULES = /node_modules\/((?:@[\w.-]+\/)?[\w.-]+)\//g;
const NOT_NAMES = new Set(["license", "licensed", "copyright", "version", "released", "under", "the", "and", "v", "c"]);

/** Licence headers in bundle text: `/*! tinychart v2.1.0 | MIT *\/`, `/** @license minidate 0.9.1 ... ISC *\/`. */
export function licenceHeaders(code: string): OssMarker[] {
  const out: OssMarker[] = [];
  for (const m of code.matchAll(HEADER)) {
    const body = m[1].replace(/^\s*\*+/gm, " ");
    const bang = m[0].startsWith("/*!");
    if (!bang && !/@license|@preserve/i.test(body)) continue;
    const cleaned = body.replace(/@license|@preserve/gi, " ").replace(/\(c\)|©/gi, " ");
    const nv = NAME_VERSION.exec(cleaned);
    if (!nv || NOT_NAMES.has(nv[1].toLowerCase())) continue;
    out.push({ name: nv[1], version: nv[2], licence: spdxOf(body), source: "licence-header" });
  }
  return out;
}

export function packageMarkers(code: string): OssMarker[] {
  return [...code.matchAll(PKG)].map((m) => ({ name: m[1], version: m[2], licence: null, source: "package-marker" as const }));
}

export function sourceMapPackages(sources: string[]): OssMarker[] {
  const out: OssMarker[] = [];
  for (const s of sources) for (const m of s.matchAll(NODE_MODULES)) out.push({ name: m[1], version: null, licence: null, source: "source-map" });
  return out;
}

/** Merges markers by package name; a licence header wins over weaker evidence. */
export function mergeOss(markers: OssMarker[]): OssMarker[] {
  const rank = { "licence-header": 0, "package-marker": 1, "source-map": 2 } as const;
  const by = new Map<string, OssMarker>();
  for (const m of [...markers].sort((a, b) => rank[a.source] - rank[b.source])) {
    const k = m.name.toLowerCase();
    const cur = by.get(k);
    if (!cur) by.set(k, { ...m });
    else {
      cur.version ??= m.version;
      cur.licence ??= m.licence;
    }
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findOss(texts: string[], sources: string[]): OssMarker[] {
  return mergeOss([...texts.flatMap((t) => [...licenceHeaders(t), ...packageMarkers(t)]), ...sourceMapPackages(sources)]);
}

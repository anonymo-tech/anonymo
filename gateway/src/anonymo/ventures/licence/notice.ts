// WS11 · Licence engine: NOTICE file and REUSE headers for output repos (Ventures Backend spec, PART 6).
//
// A forked venture keeps every upstream notice. The NOTICE lists each component with its version, SPDX expression,
// copyright lines and where its licence text is. Output files get REUSE-style headers
// (`SPDX-FileCopyrightText:` / `SPDX-License-Identifier:`) in the comment syntax of their language; files that cannot
// carry a comment (JSON, lockfiles, images) are covered by a REUSE.toml annotation instead (REUSE spec 3.2).

import { posix } from "node:path";
import { LICENCE_FILE } from "./detect.ts";
import type { LicenceDecision, LicenceReport } from "./types.ts";

export type NoticeOptions = { title?: string };

/** The NOTICE text for a scanned repo. With a decision, each component shows the licence the policy chose. */
export function noticeFile(report: Pick<LicenceReport, "components" | "files">, decision?: Pick<LicenceDecision, "components">, opts: NoticeOptions = {}): string {
  const chosen = new Map(decision?.components.map((c) => [c.path, c.effective]) ?? []);
  const lines = [opts.title ?? "NOTICE", "", "This product includes the following components. Their copyright and licence notices are kept below.", ""];
  for (const c of report.components) {
    const spdx = chosen.get(c.path) ?? c.spdx;
    const prefix = c.path === "." ? "" : `${c.path}/`;
    const texts = report.files.filter((f) => f.path.startsWith(prefix) && posix.dirname(f.path) === (c.path === "." ? "." : c.path) && LICENCE_FILE.test(posix.basename(f.path))).map((f) => f.path);
    lines.push(`Component: ${c.name}${c.version ? ` ${c.version}` : ""}`);
    lines.push(`Path: ${c.path}`);
    lines.push(`SPDX-License-Identifier: ${spdx ?? "NONE"}`);
    for (const cr of c.copyrights) lines.push(`Copyright: ${cr}`);
    if (!c.copyrights.length) lines.push("Copyright: no copyright line found");
    if (texts.length) for (const t of texts) lines.push(`Licence text: ${t}`);
    else if (spdx) lines.push(`Licence text: https://spdx.org/licenses/ (${spdx})`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---- REUSE headers ------------------------------------------------------------------------------------------------

export type ReuseInfo = { copyright: string[]; spdx: string };

type Style = { line?: string; open?: string; close?: string };
const STYLES: [RegExp, Style][] = [
  [/\.(?:[cm]?[jt]sx?|go|rs|java|kt|kts|swift|scala|c|cc|cpp|h|hpp|cs|dart|php|sol|proto|zig|groovy|gradle)$/i, { line: "//" }],
  [/\.(?:py|sh|bash|zsh|rb|pl|r|ya?ml|toml|ex|exs|nix|tf|mk|cmake|dockerfile|gitignore|env\.example)$|(?:^|\/)(?:Dockerfile|Makefile|Gemfile|Rakefile|Procfile)$/i, { line: "#" }],
  [/\.(?:sql|lua|hs|elm)$/i, { line: "--" }],
  [/\.(?:css|scss|less)$/i, { open: "/*", close: "*/" }],
  [/\.(?:html?|xml|svg|md|markdown|vue|svelte|astro|xhtml)$/i, { open: "<!--", close: "-->" }],
];

/** The comment style for a path, or null when the file cannot carry a header (JSON, lockfiles, binaries, ...). */
export function commentStyle(path: string): Style | null {
  if (/(?:^|\/)(?:package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock)$/.test(path)) return null;
  return STYLES.find(([re]) => re.test(path))?.[1] ?? null;
}

// A copyright line must not be able to close the comment it sits in or start a new line.
const safe = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /").replace(/-->/g, "-- >").trim();

/** The REUSE header for one file, in its comment syntax; null when it cannot carry one. */
export function reuseHeader(path: string, info: ReuseInfo): string | null {
  const style = commentStyle(path);
  if (!style) return null;
  const tags = [...info.copyright.map((c) => `SPDX-FileCopyrightText: ${safe(c.replace(/^SPDX-FileCopyrightText:\s*/i, ""))}`), `SPDX-License-Identifier: ${safe(info.spdx)}`];
  if (style.line) return tags.map((t) => `${style.line} ${t}`).join("\n") + "\n";
  return `${style.open}\n${tags.join("\n")}\n${style.close}\n`;
}

/** The file with its REUSE header in front (after a shebang or XML declaration). Already-tagged files are left alone. */
export function applyReuseHeader(path: string, content: string, info: ReuseInfo): string | null {
  const header = reuseHeader(path, info);
  if (!header) return null;
  if (/SPDX-License-Identifier:/.test(content.slice(0, 4096))) return content;
  const keep = content.match(/^(?:#![^\n]*\n|<\?xml[^>]*\?>\s*\n?|<!doctype[^>]*>\s*\n?)/i)?.[0] ?? "";
  return `${keep}${header}${keep || !content ? "" : "\n"}${content.slice(keep.length)}`;
}

const tomlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " ")}"`;

/** A REUSE.toml covering the given files (REUSE spec 3.2 annotations). */
export function reuseToml(entries: ({ path: string } & ReuseInfo)[]): string {
  const out = ["version = 1", ""];
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    out.push("[[annotations]]");
    out.push(`path = ${tomlString(e.path)}`);
    out.push('precedence = "aggregate"');
    out.push(`SPDX-FileCopyrightText = [${e.copyright.map((c) => tomlString(c.replace(/^SPDX-FileCopyrightText:\s*/i, ""))).join(", ")}]`);
    out.push(`SPDX-License-Identifier = ${tomlString(e.spdx)}`);
    out.push("");
  }
  return out.join("\n");
}

export type OutputFile = { path: string; content: string | Uint8Array } & ReuseInfo;

/**
 * Headers for every output file that can carry one; the rest (and every binary) go into REUSE.toml. Returns only the
 * files whose content changed, plus the REUSE.toml text (null when every file took a header).
 */
export function reuseOutput(files: OutputFile[]): { files: { path: string; content: string }[]; reuseToml: string | null } {
  const changed: { path: string; content: string }[] = [];
  const annotated: ({ path: string } & ReuseInfo)[] = [];
  for (const f of files) {
    const text = typeof f.content === "string" ? f.content : null;
    const next = text === null ? null : applyReuseHeader(f.path, text, f);
    if (next === null) annotated.push({ path: f.path, copyright: f.copyright, spdx: f.spdx });
    else if (next !== text) changed.push({ path: f.path, content: next });
  }
  return { files: changed, reuseToml: annotated.length ? reuseToml(annotated) : null };
}

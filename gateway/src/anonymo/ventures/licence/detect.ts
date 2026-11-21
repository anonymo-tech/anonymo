// WS11 · Licence engine: the built-in detector (Ventures Backend spec, PART 6).
//
// Used when ScanCode Toolkit is not installed, and for the manifests either way. Per file it reads
// `SPDX-License-Identifier:` headers, recognises LICENSE / LICENCE / COPYING texts by phrases distinctive to each
// licence the policy names, and collects copyright lines for the NOTICE. Per component it reads the manifest licence
// field (package.json, Cargo.toml, pyproject.toml / setup.cfg, composer.json, *.gemspec). The repo is split into
// components: the root, every package under a dependency directory (node_modules, vendor, third_party, ...), and any
// nested directory that carries its own licence. Nothing here follows symlinks or executes anything it reads.

import { open, readdir } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { KNOWN_DUAL_LICENCE, isCopyleft, licenceClass } from "./catalog.ts";
import { combineSpdx, formatSpdx, spdxLeaves, tryParseSpdx, type SpdxNode } from "./spdx.ts";
import type { FileEvidence, LicenceComponent, LicenceReport } from "./types.ts";

export const LICENCE_FILE = /^(?:licen[cs]e|copying|unlicense)(?:[-._][\w.-]*)?$/i;
export const NOTICE_FILE = /^notice(?:\.[\w]+)?$/i;
const MANIFEST = /^(?:package\.json|Cargo\.toml|pyproject\.toml|setup\.cfg|composer\.json|.+\.gemspec)$/;
const DEPENDENCY_DIRS = new Set(["node_modules", "vendor", "third_party", "third-party", "thirdparty", "external", "deps"]);
const SKIP_DIRS = new Set([".git", ".hg", ".svn"]);

const HEAD_BYTES = 16 * 1024;
const LICENCE_BYTES = 512 * 1024;

export const isLicenceFile = (path: string) => LICENCE_FILE.test(posix.basename(path));

// ---- SPDX headers -------------------------------------------------------------------------------------------------

const HEADER = /^[ \t]*(?:\/\/+|#+|\*|\/\*+|<!--|--|;+|%+|'|"|rem\b|\.\.)?[ \t]*SPDX-License-Identifier:[ \t]*(.+?)[ \t]*(?:\*\/|-->)?[ \t]*$/gim;

/** Every `SPDX-License-Identifier:` comment line in the text, ANDed together; null when there is none. */
export function spdxHeader(text: string): string | null {
  const found: string[] = [];
  for (const m of text.matchAll(HEADER)) {
    const expr = m[1].replace(/["'`,;]+$/, "").trim();
    if (!/^[A-Za-z0-9.\-+:() ]+$/.test(expr)) continue;
    const node = tryParseSpdx(expr);
    if (node) found.push(formatSpdx(node));
  }
  return combineSpdx(found);
}

// ---- licence texts ------------------------------------------------------------------------------------------------

function gnuText(t: string): string | null {
  if (/GNU AFFERO GENERAL PUBLIC LICENSE Version 3/i.test(t)) return "AGPL-3.0-only";
  if (/GNU LESSER GENERAL PUBLIC LICENSE Version 3/i.test(t)) return "LGPL-3.0-only";
  if (/GNU LESSER GENERAL PUBLIC LICENSE Version 2\.1/i.test(t)) return "LGPL-2.1-only";
  if (/GNU GENERAL PUBLIC LICENSE Version 3/i.test(t)) return "GPL-3.0-only";
  if (/GNU GENERAL PUBLIC LICENSE Version 2/i.test(t)) return "GPL-2.0-only";
  // A licence notice rather than the full text: "... under the terms of the GNU General Public License ... version 3".
  const m = t.match(/terms of the GNU (Affero |Lesser )?General Public License[^.]{0,160}?version (\d(?:\.\d)?)/i);
  if (!m) return null;
  const family = m[1]?.trim().toLowerCase() === "affero" ? "AGPL" : m[1] ? "LGPL" : "GPL";
  const version = m[2].includes(".") ? m[2] : family === "LGPL" && m[2] === "2" ? "2.1" : `${m[2]}.0`;
  const later = /or \(at your option\) any later version/i.test(t) ? "-or-later" : "-only";
  return `${family}-${version}${later}`;
}

function permissiveText(t: string): string | null {
  if (/free and unencumbered software released into the public domain/i.test(t)) return "Unlicense";
  if (/CC0 1\.0 Universal|Creative Commons CC0/i.test(t)) return "CC0-1.0";
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t))
    return /above copyright notice and this permission notice shall be included/i.test(t) ? "MIT" : "MIT-0";
  if (/Permission to use, copy, modify, and\/?or distribute this software for any purpose with or without fee is hereby granted/i.test(t))
    return /provided that the above copyright notice and this permission notice appear in all copies/i.test(t) ? "ISC" : "0BSD";
  if (/Redistribution and use in source and binary forms, with or without modification, are permitted/i.test(t)) {
    if (/advertising materials/i.test(t)) return "BSD-4-Clause";
    if (/Neither the name|names of (?:its|the) contributors may (?:not )?be used to endorse/i.test(t)) return "BSD-3-Clause";
    return "BSD-2-Clause";
  }
  if (/Altered source versions must be plainly marked as such/i.test(t) && /This notice may not be removed or altered from any source distribution/i.test(t)) return "Zlib";
  if (/Boost Software License - Version 1\.0/i.test(t)) return "BSL-1.0";
  return null;
}

function sourceAvailableText(t: string): string | null {
  if (/Server Side Public License/i.test(t)) return "SSPL-1.0";
  if (/Business Source License/i.test(t)) return "BUSL-1.1";
  if (/Elastic License 2\.0|Elastic License,? Version 2\.0/i.test(t)) return "Elastic-2.0";
  if (/PolyForm Noncommercial License/i.test(t)) return "PolyForm-Noncommercial-1.0.0";
  if (/PolyForm Small Business License/i.test(t)) return "PolyForm-Small-Business-1.0.0";
  if (/PolyForm [A-Z][\w ]{0,40}License/i.test(t)) return "LicenseRef-PolyForm";
  if (/Elastic License/i.test(t)) return "LicenseRef-Commercial";
  if (/Attribution-NonCommercial/i.test(t)) return "LicenseRef-NonCommercial";
  return null;
}

const DUAL = /dual[- ]licen[cs](?:ed|e|ing)|available under (?:a|the) commercial licen[cs]e/i;
const COMMERCIAL = /commercial licen[cs]e/i;

/**
 * Recognises a licence text by its distinctive phrases. Several licences in one file are ANDed (MIT text plus a
 * Commons Clause stays restricted); a text that says it is dual licensed with a commercial option is ORed with
 * LicenseRef-Commercial and flagged.
 */
export function detectLicenceText(text: string): { spdx: string | null; dual?: string } {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return { spdx: null };
  // A LICENSE file that holds nothing but an id or an expression ("MIT", "Apache-2.0 OR MIT").
  if (t.length < 120 && /^[A-Za-z0-9.\-+:() ]+$/.test(t)) {
    const short = normaliseLicence(t);
    if (short && short !== "LicenseRef-Unknown") return { spdx: short };
  }
  const ids: string[] = [];
  const gnu = gnuText(t);
  if (gnu) ids.push(gnu);
  const restricted = sourceAvailableText(t);
  // A source-available text names its future open licence ("Change License: Apache License, Version 2.0"); that
  // licence does not apply yet, so the restricted one stands alone.
  if (restricted && !restricted.startsWith("LicenseRef-")) return { spdx: restricted };
  if (restricted && !(restricted === "LicenseRef-Commercial" && gnu)) ids.push(restricted);
  if (/Mozilla Public License,? (?:Version |v\.? ?)2\.0/i.test(t)) ids.push("MPL-2.0");
  if (/Apache License,? Version 2\.0/i.test(t)) ids.push("Apache-2.0");
  const permissive = permissiveText(t);
  if (permissive) ids.push(permissive);
  if (/Commons Clause/i.test(t)) ids.push("LicenseRef-Commons-Clause");
  // LGPL-3.0 is a supplement to GPL-3.0, so its projects ship both texts; the GPL text is not a second licence.
  if (ids.includes("LGPL-3.0-only") && ids.includes("GPL-3.0-only")) ids.splice(ids.indexOf("GPL-3.0-only"), 1);

  if (DUAL.test(t) && COMMERCIAL.test(t)) {
    const base = combineSpdx(ids, "OR");
    return { spdx: combineSpdx([base, "LicenseRef-Commercial"], "OR"), dual: "licence text says it is dual licensed with a commercial licence" };
  }
  if (ids.length) {
    const dual = DUAL.test(t) && ids.length > 1 && ids.some((id) => licenceClass(id) !== "permissive") ? "licence text says it is dual licensed" : undefined;
    return { spdx: combineSpdx(ids, dual ? "OR" : "AND"), ...(dual ? { dual } : {}) };
  }
  if (/non-?commercial (?:use|purposes?)/i.test(t)) return { spdx: "LicenseRef-NonCommercial" };
  if (COMMERCIAL.test(t) || /all rights reserved|proprietary/i.test(t)) return { spdx: "LicenseRef-Commercial" };
  return { spdx: "LicenseRef-Unknown" };
}

// ---- free-text licence names (manifests) --------------------------------------------------------------------------

const ALIASES: [RegExp, string][] = [
  [/^(?:the )?mit(?: license| licence)?$|^expat$/, "MIT"],
  [/^mit[- ]?0$/, "MIT-0"],
  [/^(?:the )?apache(?: software)?(?: license| licence)?,?(?: version)?[- ]?2(?:\.0)?$|^asl[- ]?2(?:\.0)?$|^apache software license$/, "Apache-2.0"],
  [/^(?:new |modified |revised )?bsd(?: license| licence)?$|^bsd[- ]?3(?:[- ]clause)?(?: license)?$/, "BSD-3-Clause"],
  [/^(?:simplified |freebsd )bsd(?: license)?$|^bsd[- ]?2(?:[- ]clause)?(?: license)?$/, "BSD-2-Clause"],
  [/^isc(?: license| licence)?(?: \(iscl\))?$/, "ISC"],
  [/^(?:the )?unlicen[sc]e$/, "Unlicense"],
  [/^zlib(?:\/libpng)?(?: license)?$/, "Zlib"],
  [/^cc0(?:[- ]1\.0)?(?: universal)?$/, "CC0-1.0"],
  [/^mpl[- ]?2(?:\.0)?$|^mozilla public licen[cs]e,? (?:version )?2\.0(?: \(mpl 2\.0\))?$/, "MPL-2.0"],
  [/^(?:gnu )?lgpl ?v?3(?:\.0)?\+$|^gnu lesser general public license v3 or later \(lgplv3\+\)$/, "LGPL-3.0-or-later"],
  [/^(?:gnu )?lgpl ?v?3(?:\.0)?$|^gnu lesser general public license v3 \(lgplv3\)$/, "LGPL-3.0-only"],
  [/^(?:gnu )?lgpl ?v?2(?:\.1)?\+$|^gnu lesser general public license v2 or later \(lgplv2\+\)$/, "LGPL-2.1-or-later"],
  [/^(?:gnu )?lgpl ?v?2(?:\.1)?$|^gnu lesser general public license v2 \(lgplv2\)$/, "LGPL-2.1-only"],
  [/^(?:gnu )?agpl ?v?3(?:\.0)?\+$|^gnu affero general public license v3 or later \(agplv3\+\)$/, "AGPL-3.0-or-later"],
  [/^(?:gnu )?agpl ?v?3(?:\.0)?$|^gnu affero general public license v3(?: \(agplv3\))?$/, "AGPL-3.0-only"],
  [/^(?:gnu )?gpl ?v?3(?:\.0)?\+$|^gnu general public license v3 or later \(gplv3\+\)$/, "GPL-3.0-or-later"],
  [/^(?:gnu )?gpl ?v?3(?:\.0)?$|^gnu general public license v3 \(gplv3\)$/, "GPL-3.0-only"],
  [/^(?:gnu )?gpl ?v?2(?:\.0)?\+$|^gnu general public license v2 or later \(gplv2\+\)$/, "GPL-2.0-or-later"],
  [/^(?:gnu )?gpl ?v?2(?:\.0)?$|^gnu general public license v2 \(gplv2\)$/, "GPL-2.0-only"],
  [/^sspl(?:[- ]?v?1(?:\.0)?)?$|^server side public license/, "SSPL-1.0"],
  [/^bus?l(?:[- ]?1\.1)?$|^business source license/, "BUSL-1.1"],
  [/^elastic(?: license)?[- ]?(?:v?2(?:\.0)?)?$|^elv2$/, "Elastic-2.0"],
  [/^polyform[- ]noncommercial/, "PolyForm-Noncommercial-1.0.0"],
  [/commons clause/, "LicenseRef-Commons-Clause"],
  [/^unlicensed$|^proprietary$|^commercial$|^all rights reserved$/, "LicenseRef-Commercial"],
];

/**
 * A manifest licence field (an SPDX expression, a common name, a trove classifier) as a canonical SPDX expression.
 * Null when the field defers to a file ("SEE LICENSE IN ..."); LicenseRef-Unknown when it cannot be read.
 */
export function normaliseLicence(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^License :: (?:OSI Approved :: )?/i, "").replace(/\s+/g, " ");
  if (!s || /^see licen[cs]e in\b/i.test(s) || /^file:/i.test(s)) return null;
  const alias = (v: string) => {
    const key = v.toLowerCase().replace(/_/g, " ").replace(/\.$/, "").trim();
    return ALIASES.find(([re]) => re.test(key))?.[1] ?? null;
  };
  const whole = alias(s);
  if (whole) return whole;
  const node = tryParseSpdx(s);
  if (!node) return "LicenseRef-Unknown";
  // An id the catalogue does not know may still be a common name ("Expat", "BSD").
  const fix = (n: SpdxNode): SpdxNode => {
    if (n.type !== "licence") return { ...n, args: n.args.map(fix) };
    if (licenceClass(n.id) !== "unforkable" || n.id.startsWith("LicenseRef-")) return n;
    const a = alias(n.id);
    return a ? { ...n, id: a } : n;
  };
  return formatSpdx(fix(node));
}

// ---- copyright lines ----------------------------------------------------------------------------------------------

const NOT_A_HOLDER = /^(?:notices?|holders?|owners?|laws?|and|or|license|licence|licensing|statements?|protection|the|to|of|for|in|is|on|permission|claims?|interest|treaty|information|status|assignment|disclaimer|act)\b/i;
const PLACEHOLDER = /<[^>]*>|\[[^\]]*(?:yyyy|year|name|owner)[^\]]*\]|\{[^}]*\}|\byyyy\b/i;
const LICENCE_AUTHORS = /Free Software Foundation|MariaDB Corporation Ab|Elasticsearch B\.V\.|MongoDB, Inc\.|PolyForm Project/i;

/** The holder part of a copyright line, for deduplication ("Copyright (c) 2024 X" and "© 2024 X" are one line). */
export const copyrightKey = (line: string) =>
  line
    .replace(/^(?:copyright\b:?\s*|\(c\)\s*|©\s*)+/i, "")
    .replace(/[.,;\s]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

/** `Copyright (c) 2024 Sample Org` and `SPDX-FileCopyrightText:` lines, cleaned and deduplicated, in order. */
export function copyrightLines(text: string, opts: { licenceText?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*<\?php\b/i, "")
      .replace(/^[\s#*/;!%'"\->]*(?:<!--)?\s*/, "")
      .replace(/\s*(?:\*\/|-->)\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    let value: string | null = null;
    const tagged = line.match(/^SPDX-FileCopyrightText:\s*(.+)$/i);
    if (tagged) value = tagged[1].trim();
    else if (/^(?:copyright\b|\(c\) |© ?)/i.test(line)) {
      const rest = line.replace(/^(?:copyright\b:?\s*|\(c\)\s*|©\s*)(?:\(c\)\s*|©\s*)?/i, "");
      if (!rest || NOT_A_HOLDER.test(rest)) continue;
      if (!/^(?:\d|[A-ZÀ-ɏ@])/.test(rest)) continue;
      value = line;
    }
    if (!value || value.length > 200 || PLACEHOLDER.test(value)) continue;
    if (opts.licenceText && LICENCE_AUTHORS.test(value)) continue;
    if (tagged && !/^(?:copyright\b|\(c\)|©)/i.test(value)) value = `Copyright ${value}`;
    if (!out.some((o) => copyrightKey(o) === copyrightKey(value!))) out.push(value);
  }
  return out;
}

// ---- manifests ----------------------------------------------------------------------------------------------------

export type ManifestInfo = { kind: "npm" | "cargo" | "python" | "composer" | "gem"; name?: string; version?: string; licence: string | null };

/** Reads `key = "value"` pairs (and inline tables / arrays of strings) inside one TOML or INI section. Best effort. */
function section(text: string, names: string[], ini = false): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (head) {
      inside = names.includes(head[1].trim());
      continue;
    }
    if (!inside) continue;
    // An indented INI line continues the previous value (setup.cfg classifiers).
    if (ini && /^\s+\S/.test(line) && out.size) {
      const last = [...out.keys()].pop()!;
      out.set(last, `${out.get(last)}\n${line.trim()}`);
      continue;
    }
    const kv = line.match(ini ? /^\s*([\w.-]+)\s*[=:]\s*(.*)$/ : /^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (kv) out.set(kv[1], kv[2].trim());
  }
  return out;
}

const tomlString = (v: string | undefined) => v?.match(/^["']([^"']*)["']/)?.[1];
const tomlTableText = (v: string | undefined) => v?.match(/\btext\s*=\s*["']([^"']*)["']/)?.[1];
const classifierLicences = (text: string) =>
  [...text.matchAll(/License :: (?:OSI Approved :: )?([^"'\n,\]]+)/g)].map((m) => normaliseLicence(m[1].trim())).filter((x): x is string => !!x && x !== "LicenseRef-Unknown");

/** Reads a manifest's name, version and licence. Null when the file is not a manifest or cannot be parsed. */
export function parseManifest(fileName: string, text: string): ManifestInfo | null {
  const name = posix.basename(fileName);
  try {
    if (name === "package.json" || name === "composer.json") {
      const j = JSON.parse(text) as Record<string, unknown>;
      if (!j || typeof j !== "object" || Array.isArray(j)) return null;
      const field = (v: unknown): string | null =>
        typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string" ? ((v as { type: string }).type as string) : null;
      const list = (v: unknown) => (Array.isArray(v) ? v.map(field).map(normaliseLicence) : []);
      let licence: string | null = null;
      if (Array.isArray(j.license)) licence = combineSpdx(list(j.license), "OR");
      else licence = normaliseLicence(field(j.license));
      if (!licence && Array.isArray(j.licenses)) licence = combineSpdx(list(j.licenses), "OR");
      return { kind: name === "package.json" ? "npm" : "composer", name: typeof j.name === "string" ? j.name : undefined, version: typeof j.version === "string" ? j.version : undefined, licence };
    }
    if (name === "Cargo.toml") {
      const p = section(text, ["package"]);
      return { kind: "cargo", name: tomlString(p.get("name")), version: tomlString(p.get("version")), licence: normaliseLicence(tomlString(p.get("license"))) };
    }
    if (name === "pyproject.toml") {
      const p = section(text, ["project"]);
      const poetry = section(text, ["tool.poetry"]);
      const raw = tomlString(p.get("license")) ?? tomlTableText(p.get("license")) ?? tomlString(poetry.get("license"));
      const licence = normaliseLicence(raw) ?? combineSpdx(classifierLicences(text), "OR");
      return { kind: "python", name: tomlString(p.get("name")) ?? tomlString(poetry.get("name")), version: tomlString(p.get("version")) ?? tomlString(poetry.get("version")), licence };
    }
    if (name === "setup.cfg") {
      const m = section(text, ["metadata"], true);
      const licence = normaliseLicence(m.get("license")?.split("\n")[0]) ?? combineSpdx(classifierLicences(m.get("classifiers") ?? ""), "OR");
      return { kind: "python", name: m.get("name"), version: m.get("version"), licence };
    }
    if (name.endsWith(".gemspec")) {
      const str = (key: string) => text.match(new RegExp(`\\.${key}\\s*=\\s*["']([^"']+)["']`))?.[1];
      const many = text.match(/\.licenses\s*=\s*(?:%w[[(]([^\])]*)[\])]|\[([^\]]*)\])/);
      const items = many ? (many[1] ? many[1].split(/\s+/) : [...(many[2] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1])) : [];
      const licence = items.length ? combineSpdx(items.filter(Boolean).map(normaliseLicence), "OR") : normaliseLicence(str("license"));
      return { kind: "gem", name: str("name"), version: str("version"), licence };
    }
  } catch {
    return null;
  }
  return null;
}

// ---- walking the repo ---------------------------------------------------------------------------------------------

export class LicenceScanError extends Error {}

export type WalkOptions = { maxFiles?: number };

/** Every regular file under dir as a sorted relative POSIX path. Symlinks and VCS directories are skipped. */
export async function walkRepo(dir: string, opts: WalkOptions = {}): Promise<string[]> {
  const max = opts.maxFiles ?? 200_000;
  const out: string[] = [];
  const visit = async (rel: string) => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(path);
      } else if (e.isFile()) {
        out.push(path);
        if (out.length > max) throw new LicenceScanError(`more than ${max} files to scan`);
      }
    }
  };
  await visit("");
  return out.sort();
}

async function readHead(path: string, bytes: number): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const chunk = buf.subarray(0, bytesRead);
    if (chunk.includes(0)) return null;
    return chunk.toString("utf8");
  } finally {
    await fh.close();
  }
}

/** The built-in detector's evidence for every file under dir. */
export async function builtinEvidence(dir: string, paths?: string[], opts: WalkOptions = {}): Promise<FileEvidence[]> {
  const files = paths ?? (await walkRepo(dir, opts));
  const out: FileEvidence[] = [];
  for (const path of files) {
    const base = posix.basename(path);
    const licenceText = LICENCE_FILE.test(base);
    const text = await readHead(join(dir, path), licenceText || NOTICE_FILE.test(base) ? LICENCE_BYTES : HEAD_BYTES).catch(() => null);
    if (text === null) {
      out.push({ path, spdx: null, licenceText: false, copyrights: [] });
      continue;
    }
    if (licenceText) {
      const found = detectLicenceText(text);
      out.push({ path, spdx: found.spdx, licenceText: true, copyrights: copyrightLines(text, { licenceText: true }), ...(found.dual ? { dual: found.dual } : {}) });
    } else {
      out.push({ path, spdx: spdxHeader(text), licenceText: false, copyrights: copyrightLines(text) });
    }
  }
  return out;
}

// ---- components ---------------------------------------------------------------------------------------------------

const parentDir = (path: string) => {
  const d = posix.dirname(path);
  return d === "." ? "" : d;
};

/** A direct package directory under a dependency directory (node_modules/x, node_modules/@scope/x, vendor/x). */
function isDependencyRoot(dir: string): boolean {
  const parts = dir.split("/");
  const last = parts.length - 1;
  if (parts[last].startsWith(".")) return false;
  if (DEPENDENCY_DIRS.has(parts[last - 1] ?? "")) return !parts[last].startsWith("@");
  return parts[last - 1]?.startsWith("@") === true && parts[last - 2] === "node_modules";
}


function knownDual(name: string): string | null {
  const segments = name.toLowerCase().split(/[@/\s]+/).filter(Boolean);
  const hit = KNOWN_DUAL_LICENCE.find((k) => segments.includes(k.name) || segments.some((s) => s === `${k.name}-core` || s.startsWith(`${k.name}-`)));
  return hit ? `known dual-licence project: ${hit.note}` : null;
}

/** True when an OR in the expression offers both a copyleft licence and a commercial / unknown one. */
export function mixesCopyleftAndCommercial(spdx: string | null): boolean {
  const node = tryParseSpdx(spdx);
  if (!node) return false;
  const walk = (n: SpdxNode): boolean => {
    if (n.type === "licence") return false;
    if (n.type === "or") {
      const classes = n.args.flatMap(spdxLeaves).map((l) => licenceClass(l.id));
      if (classes.some(isCopyleft) && classes.includes("unforkable")) return true;
    }
    return n.args.some(walk);
  };
  return walk(node);
}

/** The distinct licences a component's licence files name. */
function licenceFileIds(licenceFiles: FileEvidence[]): string[] {
  const ids = [...new Set(licenceFiles.map((e) => e.spdx).filter((s): s is string => !!s))];
  // LGPL-3.0 is a supplement to GPL-3.0, so its projects ship COPYING (GPL) beside COPYING.LESSER (LGPL).
  return ids.some((s) => s.startsWith("LGPL-3.0")) ? ids.filter((s) => s !== "GPL-3.0-only") : ids;
}

/** Several licence files naming different licences, not all permissive: offered as alternatives (dual licence). */
function filesOfferChoice(ids: string[]): boolean {
  return ids.length > 1 && ids.some((s) => !tryParseSpdx(s) || spdxLeaves(tryParseSpdx(s)!).some((l) => licenceClass(l.id) !== "permissive"));
}

// A licence text cannot say "-only" or "-or-later" (the text is the same), so declarations compare by family.
const family = (expr: string) => new Set(spdxLeaves(tryParseSpdx(expr) ?? { type: "licence", id: expr }).map((l) => formatSpdx(l).replace(/-(?:only|or-later)\b/g, "")));
const within = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

/**
 * A component's licence: the manifest's declaration when the licence files agree with it; the files' expression when
 * it offers the declared licence among other options (a dual licence); both ANDed when they disagree (the
 * conservative reading). Without a declaration, the licence files, then the files' own SPDX headers.
 */
function componentSpdx(declared: string | null, licenceFiles: FileEvidence[], all: FileEvidence[]): string | null {
  const fileIds = licenceFileIds(licenceFiles);
  const fromFiles = combineSpdx(fileIds, filesOfferChoice(fileIds) ? "OR" : "AND");
  if (!declared) return fromFiles ?? combineSpdx(all.filter((e) => !e.licenceText).map((e) => e.spdx));
  const known = fileIds.filter((s) => s !== "LicenseRef-Unknown");
  if (!known.length) return declared;
  const fromKnown = combineSpdx(known, filesOfferChoice(known) ? "OR" : "AND")!;
  const d = family(declared);
  const f = family(fromKnown);
  if (within(f, d)) return declared;
  if (within(d, f) && tryParseSpdx(fromKnown)?.type === "or") return fromKnown;
  return combineSpdx([declared, fromKnown]);
}

export type AssembleOptions = { name?: string };

/** Splits the evidence into components, reads their manifests and finds dual-licence projects. */
export async function assembleReport(dir: string, evidence: FileEvidence[], tool: LicenceReport["tool"], opts: AssembleOptions = {}): Promise<Omit<LicenceReport, "sha256">> {
  const byDir = new Map<string, FileEvidence[]>();
  for (const e of evidence) {
    const d = parentDir(e.path);
    byDir.set(d, [...(byDir.get(d) ?? []), e]);
  }
  const manifests = new Map<string, ManifestInfo>();
  for (const [d, list] of byDir) {
    for (const e of list) {
      const base = posix.basename(e.path);
      if (!MANIFEST.test(base) || manifests.has(d)) continue;
      const text = await readHead(join(dir, e.path), 1024 * 1024).catch(() => null);
      const info = text ? parseManifest(base, text) : null;
      if (info) manifests.set(d, info);
    }
  }

  // Which directories are component roots.
  const roots = new Set<string>([""]);
  const allDirs = new Set<string>();
  for (const e of evidence) {
    let d = parentDir(e.path);
    while (d) {
      allDirs.add(d);
      d = parentDir(d);
    }
  }
  for (const d of allDirs) {
    const own = byDir.get(d) ?? [];
    const hasLicence = own.some((e) => e.licenceText) || !!manifests.get(d)?.licence;
    if (hasLicence || (isDependencyRoot(d) && (manifests.has(d) || own.length > 0))) roots.add(d);
  }
  const rootOf = (path: string) => {
    let d = parentDir(path);
    while (d && !roots.has(d)) d = parentDir(d);
    return d;
  };

  const grouped = new Map<string, FileEvidence[]>([...roots].map((r) => [r, []]));
  for (const e of evidence) grouped.get(rootOf(e.path))!.push(e);

  const components: LicenceComponent[] = [];
  const dualLicence: { name: string; reason: string }[] = [];
  for (const [root, list] of grouped) {
    const manifest = manifests.get(root);
    const own = list.filter((e) => parentDir(e.path) === root);
    const licenceFiles = own.filter((e) => e.licenceText);
    const spdx = componentSpdx(manifest?.licence ?? null, licenceFiles, list);
    const name = (root === "" ? opts.name : undefined) ?? manifest?.name ?? (root ? posix.basename(root) : basename(dir));
    if (root !== "" && !list.length) continue;
    const copyrights: string[] = [];
    const keys = new Set<string>();
    for (const e of [...licenceFiles, ...list.filter((x) => !x.licenceText)])
      for (const c of e.copyrights) {
        const k = copyrightKey(c);
        if (!keys.has(k)) keys.add(k), copyrights.push(c);
      }
    components.push({ name, ...(manifest?.version ? { version: manifest.version } : {}), path: root || ".", spdx, copyrights, files: list.length });

    const reasons: string[] = [];
    const known = knownDual(name) ?? (root === "" ? knownDual(basename(dir)) : null);
    if (known) reasons.push(known);
    for (const e of licenceFiles) if (e.dual) reasons.push(`${e.path}: ${e.dual}`);
    const distinct = licenceFileIds(licenceFiles);
    if (filesOfferChoice(distinct))
      reasons.push(`several licence files with different licences: ${distinct.join("; ")}`);
    for (const expr of new Set([spdx, ...distinct])) if (mixesCopyleftAndCommercial(expr)) reasons.push(`expression offers copyleft or commercial: ${expr}`);
    if (reasons.length) dualLicence.push({ name, reason: [...new Set(reasons)].join("; ") });
  }

  components.sort((a, b) => (a.path === "." ? -1 : b.path === "." ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  dualLicence.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = evidence.map((e) => ({ path: e.path, spdx: e.spdx })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { tool, components, files, dualLicence };
}

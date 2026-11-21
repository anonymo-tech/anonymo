// WS11 · Licence engine: SPDX licence expressions (Ventures Backend spec, PART 6; SPDX spec annex D).
//
// `MIT OR (Apache-2.0 AND GPL-2.0-only WITH Classpath-exception-2.0)` parses into a small AST. Precedence is
// WITH > AND > OR, parentheses group, operators are accepted in either case, and a trailing `+` means "or later".
// Ids are put in canonical case and deprecated GNU ids are mapped to their -only / -or-later form, so the policy only
// ever compares canonical ids.

import { DEPRECATED_IDS, KNOWN_IDS } from "./catalog.ts";

export type SpdxLicence = { type: "licence"; id: string; exception?: string };
export type SpdxNode = SpdxLicence | { type: "and" | "or"; args: SpdxNode[] };

export class SpdxParseError extends Error {}

const KNOWN_LOWER = new Map(KNOWN_IDS.map((id) => [id.toLowerCase(), id]));
const DEPRECATED_LOWER = new Map(Object.entries(DEPRECATED_IDS).map(([k, v]) => [k.toLowerCase(), v]));
const GNU = /^(A|L)?GPL-\d\.\d$/i;

/** Canonical case for a licence id; deprecated ids and `+` map to the current SPDX id. Unknown ids keep their text. */
export function canonicalId(raw: string): string {
  const id = raw.trim();
  const lower = id.toLowerCase();
  const deprecated = DEPRECATED_LOWER.get(lower);
  if (deprecated) return deprecated;
  const known = KNOWN_LOWER.get(lower);
  if (known) return known;
  if (id.endsWith("+")) {
    const base = id.slice(0, -1);
    if (GNU.test(base)) return canonicalId(base).replace(/-only$/, "-or-later");
    return canonicalId(base);
  }
  if (lower.startsWith("licenseref-")) return "LicenseRef-" + id.slice("licenseref-".length);
  return id;
}

type Token = { kind: "(" | ")" | "AND" | "OR" | "WITH" | "id"; text: string };

function tokenize(expr: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(\(|\)|[A-Za-z0-9.\-:+]+)\s*/y;
  let at = 0;
  while (at < expr.length) {
    re.lastIndex = at;
    const m = re.exec(expr);
    if (!m) {
      if (/^\s*$/.test(expr.slice(at))) break;
      throw new SpdxParseError(`unexpected character at ${at} in licence expression`);
    }
    at = re.lastIndex;
    const t = m[1];
    const upper = t.toUpperCase();
    if (t === "(" || t === ")") out.push({ kind: t, text: t });
    else if (upper === "AND" || upper === "OR" || upper === "WITH") out.push({ kind: upper, text: t });
    else out.push({ kind: "id", text: t });
  }
  return out;
}

/** Parses an SPDX licence expression. Throws SpdxParseError on anything that is not one. */
export function parseSpdx(expr: string): SpdxNode {
  const tokens = tokenize(expr);
  if (!tokens.length) throw new SpdxParseError("empty licence expression");
  let i = 0;
  const peek = () => tokens[i];
  const take = (kind: Token["kind"]) => {
    const t = tokens[i];
    if (!t || t.kind !== kind) throw new SpdxParseError(`expected ${kind} in licence expression`);
    i++;
    return t;
  };
  const join = (type: "and" | "or", parts: SpdxNode[]): SpdxNode =>
    parts.length === 1 ? parts[0] : { type, args: parts.flatMap((p) => (p.type === type ? p.args : [p])) };

  const primary = (): SpdxNode => {
    if (peek()?.kind === "(") {
      i++;
      const inner = or();
      take(")");
      return inner;
    }
    const id = take("id").text;
    const node: SpdxLicence = { type: "licence", id: canonicalId(id) };
    if (peek()?.kind === "WITH") {
      i++;
      node.exception = take("id").text;
    }
    return node;
  };
  const and = (): SpdxNode => {
    const parts = [primary()];
    while (peek()?.kind === "AND") {
      i++;
      parts.push(primary());
    }
    return join("and", parts);
  };
  const or = (): SpdxNode => {
    const parts = [and()];
    while (peek()?.kind === "OR") {
      i++;
      parts.push(and());
    }
    return join("or", parts);
  };

  const node = or();
  if (i !== tokens.length) throw new SpdxParseError("trailing tokens in licence expression");
  return node;
}

export function tryParseSpdx(expr: string | null | undefined): SpdxNode | null {
  if (!expr) return null;
  try {
    return parseSpdx(expr);
  } catch {
    return null;
  }
}

/** Writes the AST back as a canonical expression, with parentheses only where precedence needs them. */
export function formatSpdx(node: SpdxNode): string {
  if (node.type === "licence") return node.exception ? `${node.id} WITH ${node.exception}` : node.id;
  const sep = node.type === "and" ? " AND " : " OR ";
  return node.args.map((a) => (a.type === "or" && node.type === "and" ? `(${formatSpdx(a)})` : formatSpdx(a))).join(sep);
}

export function spdxLeaves(node: SpdxNode): SpdxLicence[] {
  return node.type === "licence" ? [node] : node.args.flatMap(spdxLeaves);
}

/** Joins expressions with AND (or OR), dropping duplicates; null when there is nothing to join. */
export function combineSpdx(exprs: (string | null | undefined)[], op: "AND" | "OR" = "AND"): string | null {
  const parts = [...new Set(exprs.filter((e): e is string => !!e))];
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  const nodes = parts.map((p) => tryParseSpdx(p) ?? ({ type: "licence", id: "LicenseRef-Unknown" } as SpdxNode));
  return formatSpdx({ type: op === "AND" ? "and" : "or", args: nodes.flatMap((n) => (n.type === (op === "AND" ? "and" : "or") ? n.args : [n])) });
}

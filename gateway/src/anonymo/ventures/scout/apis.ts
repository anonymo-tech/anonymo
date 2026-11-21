// WS11 · Scout: public API shapes (Ventures Backend spec, PART 4: "traces public API calls (from HAR when a browser is
// used; from fetch()/axios/XMLHttpRequest URL literals and method hints in bundles otherwise); infers request and
// response shapes").
//
// Only shapes are kept: method, a path pattern with ids generalised to `:id`, field names and coarse types.

import type { EntitySpec, FieldSpec } from "../types.ts";
import type { ApiObservation, HarEntry } from "./types.ts";

const HOLE = "\u0000";

export type BundleCall = { method: string; path: string; concrete: string | null; request: FieldSpec[] };

const CALL = /(?<![\w$.])(fetch|axios(?:\.(?:get|post|put|patch|delete|head|request))?|ky(?:\.(?:get|post|put|patch|delete))?|\$\.(?:ajax|get|post|getJSON)|[\w$]+\.open)\s*\(/g;

/** Splits a call's argument list at top-level commas; returns the raw argument sources. */
export function readArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        args.push(src.slice(start, i).trim());
        return args.filter((a) => a.length > 0);
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [];
}

function skipString(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") j++;
    else if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
      let d = 1;
      j += 2;
      while (j < src.length && d > 0) {
        if (src[j] === "{") d++;
        else if (src[j] === "}") d--;
        if (d > 0) j++;
      }
    }
    j++;
  }
  return j;
}

function splitTop(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(expr, i);
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim());
}

/** Evaluates a URL expression (`"/a/"+id`, `` `/a/${id}` ``) to a string with holes for the unknown parts. */
export function evalUrlExpr(expr: string): string | null {
  let out = "";
  let literal = false;
  for (const part of splitTop(expr, "+")) {
    const q = part[0];
    if ((q === '"' || q === "'") && part.endsWith(q)) {
      out += part.slice(1, -1);
      literal = true;
    } else if (q === "`" && part.endsWith("`")) {
      out += part.slice(1, -1).replace(/\$\{[^}]*\}/g, HOLE);
      literal = true;
    } else out += HOLE;
  }
  return literal ? out : null;
}

const STATIC = /\.(png|jpe?g|gif|svg|webp|ico|css|js|map|woff2?|ttf|html?)$/i;

function toPath(url: string, origin: string | null): string | null {
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (/^https?:\/\//i.test(url) && origin) {
    try {
      const u = new URL(url.replace(new RegExp(HOLE, "g"), "0"));
      if (u.origin !== origin) return null;
      return url.slice(url.indexOf(u.host) + u.host.length) || "/";
    } catch {
      return null;
    }
  }
  return null;
}

const ID_SEGMENT = [/^\d+$/, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, /^[0-9a-f]{12,}$/i, /^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{8,}$/i, /^[A-Z]{2,6}-\d+$/, /^:[\w]+$/, /^\{[\w]+\}$/];

export const isIdSegment = (seg: string) => seg.includes(HOLE) || ID_SEGMENT.some((re) => re.test(seg));

/** `/api/v1/invoices/123?x=1` → `/api/v1/invoices/:id`. */
export function generalisePath(path: string): string {
  const bare = path.split(/[?#]/)[0];
  const out = bare
    .split("/")
    .map((seg) => (seg && isIdSegment(seg) ? ":id" : seg))
    .join("/");
  return out || "/";
}

export function typeFromName(name: string): FieldSpec["type"] {
  if (/^(id|uuid|guid)$|[a-z0-9](Id|ID|Uuid)$|_id$/.test(name)) return "id";
  if (/(At|_at|Date|_date|On|_on)$|^(date|timestamp|created|updated)$/.test(name)) return "date";
  if (/^(is|has|can|should)[A-Z_]|(enabled|active|archived|paid|verified)$/i.test(name)) return "boolean";
  if (/(Count|Total|Amount|Price|Cents|Qty|Quantity|_count|_total|_amount|_cents)$|^(count|total|amount|price|qty|quantity|limit|offset|page|per_page|size)$/.test(name)) return "number";
  return "string";
}

function literalType(value: string, key: string): FieldSpec["type"] {
  const v = value.trim();
  if (/^["'`]/.test(v)) return /^["'`]\d{4}-\d{2}-\d{2}/.test(v) ? "date" : typeFromName(key) === "id" ? "id" : "string";
  if (/^-?\d/.test(v)) return typeFromName(key) === "id" ? "id" : "number";
  if (/^(!0|!1|true|false)$/.test(v)) return "boolean";
  if (v.startsWith("[")) return "array";
  if (v.startsWith("{")) return "object";
  if (/new Date|toISOString\(\)/.test(v)) return "date";
  return typeFromName(key);
}

/** Keys and coarse types of an object literal source (`{a:1,b:"x",c}`); spreads and methods are skipped. */
export function objectLiteralFields(src: string): FieldSpec[] {
  const s = src.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return [];
  const out: FieldSpec[] = [];
  for (const entry of splitTop(s.slice(1, -1), ",")) {
    if (!entry || entry.startsWith("...")) continue;
    const m = /^(?:["']([\w$-]+)["']|([A-Za-z_$][\w$]*))\s*(:([\s\S]*))?$/.exec(entry);
    if (!m) continue;
    const name = m[1] ?? m[2];
    out.push({ name, type: m[3] ? literalType(m[4], name) : typeFromName(name) });
  }
  return out;
}

const HTTP_METHOD = /^["'`](GET|POST|PUT|PATCH|DELETE|HEAD)["'`]$/i;

function methodIn(obj: string | undefined): string | null {
  const m = obj && /\b(?:method|type)\s*:\s*["'`](\w+)["'`]/i.exec(obj);
  return m ? m[1].toUpperCase() : null;
}

function bodyFields(obj: string | undefined): FieldSpec[] {
  if (!obj) return [];
  const at = obj.search(/\b(?:body|data)\s*:\s*(?:JSON\.stringify\s*\()?\s*\{/);
  if (at < 0) return [];
  const brace = obj.indexOf("{", obj.indexOf(":", at));
  const end = matchBrace(obj, brace);
  return end > brace ? objectLiteralFields(obj.slice(brace, end + 1)) : [];
}

function matchBrace(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(s, i);
      continue;
    }
    if (c === "{") d++;
    else if (c === "}" && --d === 0) return i;
  }
  return -1;
}

function urlProp(obj: string): string | null {
  const m = /\burl\s*:\s*/.exec(obj);
  if (!m) return null;
  const rest = obj.slice(m.index + m[0].length);
  return splitTop(rest.replace(/^\{|\}$/g, ""), ",")[0] ?? null;
}

/** Every fetch/axios/XHR/$.ajax call in a bundle whose URL is a same-site path. */
export function findBundleCalls(code: string, origin: string | null = null): BundleCall[] {
  const out: BundleCall[] = [];
  for (const m of code.matchAll(CALL)) {
    const fn = m[1];
    const args = readArgs(code, (m.index ?? 0) + m[0].length - 1);
    if (!args.length) continue;
    let method = "GET";
    let urlExpr: string | null = args[0];
    let opts: string | undefined = args[1];
    let request: FieldSpec[] = [];
    if (/\.open$/.test(fn)) {
      if (!HTTP_METHOD.test(args[0]) || !args[1]) continue;
      method = args[0].slice(1, -1).toUpperCase();
      urlExpr = args[1];
      opts = undefined;
    } else if (/^axios\.|^ky\./.test(fn) && !/request$/.test(fn)) {
      method = fn.split(".")[1].toUpperCase();
      if (args[1]?.startsWith("{") && method !== "GET" && method !== "DELETE") request = objectLiteralFields(args[1]);
      opts = args[2] ?? (method === "GET" || method === "DELETE" ? args[1] : undefined);
    } else if (/^\$\./.test(fn)) {
      if (args[0].startsWith("{")) {
        opts = args[0];
        urlExpr = urlProp(args[0]);
        method = methodIn(args[0]) ?? "GET";
      } else method = fn.endsWith("post") ? "POST" : "GET";
    } else if ((fn === "axios" || fn === "axios.request") && args[0].startsWith("{")) {
      opts = args[0];
      urlExpr = urlProp(args[0]);
      method = methodIn(args[0]) ?? "GET";
    } else method = methodIn(opts) ?? "GET";
    if (!urlExpr) continue;
    const url = evalUrlExpr(urlExpr);
    if (!url) continue;
    const path = toPath(url, origin);
    if (!path || STATIC.test(path.split(/[?#]/)[0])) continue;
    if (!request.length) request = bodyFields(opts);
    const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
    for (const kv of query.split("&")) {
      const k = kv.split("=")[0];
      if (/^[A-Za-z_][\w]*$/.test(k) && !request.some((f) => f.name === k)) request.push({ name: k, type: typeFromName(k) });
    }
    out.push({ method, path: generalisePath(path), concrete: path.includes(HOLE) ? null : path, request });
  }
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export function jsonFieldType(key: string, v: unknown): FieldSpec["type"] {
  if (v === null || v === undefined) return typeFromName(key);
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return typeFromName(key) === "id" ? "id" : "number";
  if (typeof v === "string") return typeFromName(key) === "id" ? "id" : ISO_DATE.test(v) ? "date" : "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

/** Field names and types of a JSON object (or of the first element of an array). */
export function inferFields(json: unknown): FieldSpec[] {
  const obj = Array.isArray(json) ? json.find((x) => x && typeof x === "object" && !Array.isArray(x)) : json;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj as Record<string, unknown>)
    .filter(([k]) => /^[A-Za-z_$][\w$-]{0,63}$/.test(k))
    .map(([k, v]) => ({ name: k, type: jsonFieldType(k, v) }));
}

/** The record a response describes: the object itself, the first array element, or the first item of a list wrapper. */
export function recordOf(json: unknown): unknown {
  if (Array.isArray(json)) return json[0];
  if (json && typeof json === "object") {
    for (const k of ["data", "items", "results", "records"]) {
      const v = (json as Record<string, unknown>)[k];
      if (Array.isArray(v) && v.length) return v[0];
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    }
  }
  return json;
}

const safeJson = (s: string | undefined): unknown => {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** API observations from HAR entries (browser network log or Scout's own probes). */
export function apisFromHar(entries: HarEntry[], sameSite: (url: string) => boolean, seenIn: "har" | "probe" = "har"): ApiObservation[] {
  const out: ApiObservation[] = [];
  for (const e of entries) {
    if (!sameSite(e.url) || e.status < 200 || e.status >= 300) continue;
    const isApi = e.resourceType === "xhr" || e.resourceType === "fetch" || /json/.test(e.mimeType);
    if (!isApi) continue;
    const u = new URL(e.url);
    const body = safeJson(e.responseBody);
    const req = safeJson(e.requestBody);
    const o: ApiObservation = { method: e.method.toUpperCase(), path: generalisePath(u.pathname), seenIn: [seenIn] };
    const reqFields = [...inferFields(req), ...[...u.searchParams.keys()].map((k) => ({ name: k, type: typeFromName(k) }))];
    if (reqFields.length) o.request = reqFields;
    const resFields = body === undefined ? [] : inferFields(body);
    if (resFields.length) o.response = resFields;
    out.push(o);
  }
  return out;
}

function mergeFields(a: FieldSpec[] | undefined, b: FieldSpec[] | undefined): FieldSpec[] | undefined {
  if (!a?.length) return b?.length ? b : undefined;
  if (!b?.length) return a;
  const out = [...a];
  for (const f of b) if (!out.some((x) => x.name === f.name)) out.push(f);
  return out;
}

export function mergeApis(list: ApiObservation[]): ApiObservation[] {
  const by = new Map<string, ApiObservation>();
  for (const o of list) {
    const k = `${o.method} ${o.path}`;
    const cur = by.get(k);
    if (!cur) {
      by.set(k, { ...o, seenIn: [...o.seenIn] });
      continue;
    }
    cur.request = mergeFields(cur.request, o.request);
    cur.response = mergeFields(cur.response, o.response);
    for (const s of o.seenIn) if (!cur.seenIn.includes(s)) cur.seenIn.push(s);
  }
  return [...by.values()].sort((x, y) => x.path.localeCompare(y.path) || x.method.localeCompare(y.method));
}

export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|us)$/i.test(word)) return word;
  if (/(sses|xes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** `/api/v1/invoices/:id` → `Invoice`. */
export function entityName(path: string): string | null {
  const segs = path.split("/").filter((s) => s && s !== ":id" && !/^(api|v\d+|rest|public|graphql)$/i.test(s));
  const last = segs[segs.length - 1];
  if (!last || !/^[A-Za-z][\w-]*$/.test(last)) return null;
  return singular(last)
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

/** Data models from API responses: one entity per resource, fields from the record a response returns. */
export function entitiesFromResponses(samples: { path: string; json: unknown }[]): EntitySpec[] {
  const by = new Map<string, EntitySpec>();
  for (const s of samples) {
    const name = entityName(generalisePath(s.path));
    if (!name) continue;
    const fields = inferFields(recordOf(s.json));
    if (!fields.length) continue;
    const cur = by.get(name);
    by.set(name, { name, fields: mergeFields(cur?.fields, fields) ?? [] });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

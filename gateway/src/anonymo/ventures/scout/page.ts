// WS11 · Scout: what one public page shows (Ventures Backend spec, PART 4: "maps the state machine of each flow from
// links, buttons and forms structure").

import { byTag, findAll, hasAncestor, textOf, type HtmlNode } from "./html.ts";
import { guardUrl } from "./guards.ts";
import type { FormField, FormInfo, LinkInfo, PageInfo } from "./types.ts";

const SKIP_INPUTS = new Set(["hidden", "submit", "button", "image", "reset"]);
const SEARCH_NAMES = /^(q|query|search|s|term|keyword|keywords|filter|find)$/i;

export function resolveUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function analysePage(url: string, root: HtmlNode, artifact: string): PageInfo {
  const u = new URL(url);
  const title = textOf(findAll(root, byTag("title"))[0] ?? "") || null;
  const siteName = findAll(root, (n) => n.tag === "meta" && n.attrs.property === "og:site_name")[0]?.attrs.content ?? null;
  const headings = findAll(root, byTag("h1", "h2", "h3", "h4")).map((h) => ({ level: Number(h.tag[1]), text: textOf(h) })).filter((h) => h.text);
  const anchors = findAll(root, (n) => n.tag === "a" && !!n.attrs.href);
  const links: LinkInfo[] = [];
  for (const a of anchors) {
    const target = resolveUrl(a.attrs.href, url);
    if (!target) continue;
    const label = textOf(a) || a.attrs["aria-label"] || a.attrs.title || "";
    links.push({ url: target, label, guard: guardUrl(target, label) });
  }
  const nav = anchors.filter((a) => hasAncestor(a, ["nav", "header"])).map((a) => textOf(a)).filter(Boolean);
  const buttons = [
    ...findAll(root, byTag("button")).map((b) => textOf(b)),
    ...findAll(root, (n) => n.tag === "input" && /^(submit|button)$/i.test(n.attrs.type ?? "")).map((n) => n.attrs.value ?? ""),
    ...anchors.filter((a) => /\b(btn|button|cta)\b/i.test(a.attrs.class ?? "") || a.attrs.role === "button").map((a) => textOf(a)),
  ].filter(Boolean);
  const forms = findAll(root, byTag("form")).map((f) => readForm(f, root, url));
  const paragraphs = findAll(root, byTag("p", "li", "blockquote", "td")).map((n) => textOf(n)).filter((t) => t.length > 0);
  const scripts: string[] = [];
  const inlineScripts: string[] = [];
  for (const s of findAll(root, byTag("script"))) {
    if (s.attrs.src) {
      const r = resolveUrl(s.attrs.src, url);
      if (r) scripts.push(r);
    } else if (!/json|template/i.test(s.attrs.type ?? "")) {
      const body = s.children.filter((c): c is string => typeof c === "string").join("");
      if (body.trim()) inlineScripts.push(body);
    }
  }
  const stylesheets = findAll(root, (n) => n.tag === "link" && /\bstylesheet\b/i.test(n.attrs.rel ?? "") && !!n.attrs.href)
    .map((n) => resolveUrl(n.attrs.href, url))
    .filter((x): x is string => !!x);
  return { url, path: u.pathname + u.search, title, siteName, headings, nav, buttons, links, forms, paragraphs, scripts, inlineScripts, stylesheets, artifact };
}

function readForm(form: HtmlNode, root: HtmlNode, base: string): FormInfo {
  const labels = new Map<string, string>();
  for (const l of findAll(root, byTag("label"))) if (l.attrs.for) labels.set(l.attrs.for, textOf(l));
  const fields: FormField[] = [];
  let hasPassword = false;
  for (const el of findAll(form, byTag("input", "select", "textarea"))) {
    const type = el.tag === "input" ? (el.attrs.type ?? "text").toLowerCase() : el.tag;
    if (type === "password") hasPassword = true;
    if (SKIP_INPUTS.has(type)) continue;
    const name = el.attrs.name ?? el.attrs.id ?? "";
    if (!name) continue;
    const wrap = (() => {
      for (let p = el.parent; p && p !== form; p = p.parent) if (p.tag === "label") return textOf(p);
      return null;
    })();
    const f: FormField = {
      name,
      type,
      label: (el.attrs.id && labels.get(el.attrs.id)) || wrap || el.attrs["aria-label"] || el.attrs.placeholder || null,
      required: "required" in el.attrs || el.attrs["aria-required"] === "true",
    };
    const num = (k: string) => (el.attrs[k] && /^\d+$/.test(el.attrs[k]) ? Number(el.attrs[k]) : undefined);
    if (num("maxlength") !== undefined) f.maxLength = num("maxlength");
    if (num("minlength") !== undefined) f.minLength = num("minlength");
    if (el.attrs.min) f.min = el.attrs.min;
    if (el.attrs.max) f.max = el.attrs.max;
    if (el.attrs.pattern) f.pattern = el.attrs.pattern;
    if (el.tag === "select") f.options = findAll(el, byTag("option")).map((o) => o.attrs.value ?? textOf(o)).filter(Boolean);
    fields.push(f);
  }
  const method = (form.attrs.method ?? "get").toUpperCase();
  const action = resolveUrl(form.attrs.action ?? "", base) ?? base;
  const submit = findAll(form, (n) => n.tag === "button" || (n.tag === "input" && /^(submit|image)$/i.test(n.attrs.type ?? "")))[0];
  const submitLabel = submit ? textOf(submit) || submit.attrs.value || null : null;
  const names = fields.map((f) => f.name);
  const searchy = form.attrs.role === "search" || fields.some((f) => f.type === "search") || (fields.length === 1 && SEARCH_NAMES.test(fields[0].name));
  const role: FormInfo["role"] = hasPassword
    ? fields.length > 2 || names.some((n) => /confirm|name|company/i.test(n)) ? "signup" : "login"
    : searchy && method === "GET"
      ? "search"
      : "other";
  return { action, method, fields, submitLabel, role, hasPassword };
}

/** A public search/filter form Scout may submit: GET, one text-like input, no password, a safe action URL. */
export function isSubmittableSearch(form: FormInfo): boolean {
  if (form.method !== "GET" || form.hasPassword || form.role !== "search") return false;
  if (form.fields.length !== 1) return false;
  if (!/^(text|search)$/.test(form.fields[0].type)) return false;
  return guardUrl(form.action) === null;
}

// WS11 · Scout: a small, tolerant HTML reader (Ventures Backend spec, PART 4: "crawls public pages").
//
// Not a browser. It builds a loose element tree good enough to read headings, links, buttons, forms, tables and code
// samples from server-rendered pages. Scripts and styles are kept as raw text children.

export type HtmlNode = { tag: string; attrs: Record<string, string>; children: (HtmlNode | string)[]; parent: HtmlNode | null };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
/** Opening one of these closes an open element of the same tag (li in li, option in option, ...). */
const SELF_NESTING_CLOSES = new Set(["li", "option", "p", "tr", "td", "th", "dt", "dd"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul", "li", "tr", "td", "th", "br", "dt", "dd", "option",
  "button", "label", "select", "figure", "figcaption", "summary", "details",
]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", middot: "·", times: "×", euro: "€", pound: "£", check: "✓",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

export function parseHtml(src: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  const pushText = (t: string) => {
    if (t) cur.children.push(decodeEntities(t));
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      pushText(src.slice(i));
      break;
    }
    pushText(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const close = src[lt + 1] === "/";
    const m = /^<\/?([a-zA-Z][\w:-]*)([^>]*)>/.exec(src.slice(lt, lt + 4000));
    if (!m) {
      pushText("<");
      i = lt + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    i = lt + m[0].length;
    if (close) {
      let n: HtmlNode | null = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    if (SELF_NESTING_CLOSES.has(tag) && cur.tag === tag && cur.parent) cur = cur.parent;
    else if (cur.tag === "p" && BLOCK.has(tag) && cur.parent) cur = cur.parent;
    const node: HtmlNode = { tag, attrs: parseAttrs(m[2]), children: [], parent: cur };
    cur.children.push(node);
    if (VOID.has(tag) || m[2].trimEnd().endsWith("/")) continue;
    if (RAW.has(tag)) {
      const endRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = src.slice(i);
      const em = endRe.exec(rest);
      const body = em ? rest.slice(0, em.index) : rest;
      if (body) node.children.push(tag === "title" || tag === "textarea" ? decodeEntities(body) : body);
      i += em ? em.index + em[0].length : rest.length;
      continue;
    }
    cur = node;
  }
  return root;
}

export const isNode = (c: HtmlNode | string): c is HtmlNode => typeof c !== "string";

export function findAll(node: HtmlNode, pred: (n: HtmlNode) => boolean, out: HtmlNode[] = []): HtmlNode[] {
  for (const c of node.children) {
    if (!isNode(c)) continue;
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}

export const byTag = (...tags: string[]) => (n: HtmlNode) => tags.includes(n.tag);

/** Visible text: block boundaries become spaces, scripts and styles are skipped, whitespace collapsed. */
export function textOf(node: HtmlNode | string): string {
  return rawTextOf(node).replace(/\s+/g, " ").trim();
}

function rawTextOf(node: HtmlNode | string): string {
  if (typeof node === "string") return node;
  if (node.tag === "script" || node.tag === "style" || node.tag === "template") return "";
  const inner = node.children.map(rawTextOf).join("");
  return BLOCK.has(node.tag) ? ` ${inner} ` : inner;
}

export function hasAncestor(node: HtmlNode, tags: string[]): boolean {
  for (let p = node.parent; p; p = p.parent) if (tags.includes(p.tag)) return true;
  return false;
}

/** Elements in document order, for "nearest preceding heading" lookups. */
export function walk(node: HtmlNode, visit: (n: HtmlNode) => void) {
  for (const c of node.children) {
    if (!isNode(c)) continue;
    visit(c);
    walk(c, visit);
  }
}

/** Page text for the leakage index: the visible text, scripts and styles removed. */
export function htmlToText(src: string): string {
  return textOf(parseHtml(src));
}

// WS11 · Scout: served JS/CSS bundles and their de-minified form (Ventures Backend spec, PART 4: "de-minifies bundles
// (source-map if public, else a pretty-printer)").
//
// A source map is fetched only when the bundle references it and it is served publicly on the same site. Of the map we
// keep only `sources` (file names) and `sourcesContent` (the mapped code), for analysis inside the SCOUT zone.

import { scoutArtifact, type Fetcher } from "./crawl.ts";
import { resolveUrl } from "./page.ts";
import type { BundleInfo, ScoutArtifact } from "./types.ts";

export type BundleText = { url: string; type: "js" | "css"; text: string; mapped: string[]; mapSources: string[] };

export function sourceMapUrl(js: string, bundleUrl: string): string | null {
  const m = /\/[/*][#@]\s*sourceMappingURL=([^\s*'"]+)\s*(?:\*\/)?\s*$/m.exec(js.slice(-4000));
  if (!m || m[1].startsWith("data:")) return null;
  return resolveUrl(m[1], bundleUrl);
}

/** Keeps only the two fields Scout analyses. */
export function readSourceMap(text: string): { sources: string[]; sourcesContent: string[] } | null {
  try {
    const j = JSON.parse(text) as { sources?: unknown; sourcesContent?: unknown };
    const sources = Array.isArray(j.sources) ? j.sources.filter((s): s is string => typeof s === "string") : [];
    const sourcesContent = Array.isArray(j.sourcesContent) ? j.sourcesContent.filter((s): s is string => typeof s === "string") : [];
    return sources.length || sourcesContent.length ? { sources, sourcesContent } : null;
  } catch {
    return null;
  }
}

/** A plain pretty-printer: breaks after `;`, `{` and `}` outside strings, comments, regexes and `for (...)` heads. */
export function prettyPrintJs(src: string): string {
  let out = "";
  let depth = 0;
  let paren = 0;
  let i = 0;
  let lastSig = "";
  const nl = () => {
    out = out.replace(/[ \t]+$/, "");
    out += "\n" + "  ".repeat(Math.max(0, depth));
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stopAt = end < 0 ? src.length : end + 2;
      out += src.slice(i, stopAt);
      i = stopAt;
      if (src[i] === "\n" || /^\s*\S/.test(src.slice(i, i + 2))) nl();
      continue;
    }
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stopAt = end < 0 ? src.length : end;
      out += src.slice(i, stopAt);
      i = stopAt;
      nl();
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = c;
      continue;
    }
    if (c === "/" && (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      while (j + 1 < src.length && /[a-z]/i.test(src[j + 1])) j++;
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = "/re";
      continue;
    }
    if (c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") paren++;
    if (c === ")") paren = Math.max(0, paren - 1);
    if (c === "{") {
      out += "{";
      depth++;
      nl();
    } else if (c === "}") {
      depth--;
      nl();
      out += "}";
      if (paren === 0 && !/^[)\],;.]/.test(src[i + 1] ?? "")) nl();
    } else if (c === ";") {
      out += ";";
      if (paren === 0) nl();
    } else out += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.replace(/\n\s*\n/g, "\n").trim() + "\n";
}

const isJs = (url: string, contentType: string) => /javascript|ecmascript/.test(contentType) || /\.m?js(\?|$)/i.test(new URL(url).pathname);

export type CollectedBundles = { infos: BundleInfo[]; texts: BundleText[]; artifacts: ScoutArtifact[] };

/** Fetches same-site scripts and stylesheets the pages reference, plus any public source map. Off-site bundles are skipped. */
export async function collectBundles(f: Fetcher, scripts: string[], styles: string[], inline: string[]): Promise<CollectedBundles> {
  const infos: BundleInfo[] = [];
  const texts: BundleText[] = [];
  const artifacts: ScoutArtifact[] = [];
  const want: { url: string; type: "js" | "css" }[] = [...[...new Set(scripts)].map((url) => ({ url, type: "js" as const })), ...[...new Set(styles)].map((url) => ({ url, type: "css" as const }))];
  for (const { url, type } of want) {
    if (!f.sameSite(url)) continue;
    const r = await f.get(url, "asset");
    if (!r || r.status !== 200) continue;
    const kind = type === "js" && isJs(url, r.contentType) ? "js" : type;
    const art = scoutArtifact("bundle", r.text, { type: kind, url, contentType: r.contentType }, new URL(url).pathname);
    artifacts.push(art);
    const info: BundleInfo = { url, artifact: art.ref.sha256, type: kind, sourceMap: null, deminified: null };
    const bt: BundleText = { url, type: kind, text: r.text, mapped: [], mapSources: [] };
    if (kind === "js") {
      const mapUrl = sourceMapUrl(r.text, url);
      const m = mapUrl && f.sameSite(mapUrl) ? await f.get(mapUrl, "asset") : null;
      const map = m && m.status === 200 ? readSourceMap(m.text) : null;
      if (map && mapUrl) {
        const kept = JSON.stringify({ sources: map.sources, sourcesContent: map.sourcesContent });
        const mapArt = scoutArtifact("bundle", kept, { type: "source-map", url: mapUrl, bundle: url, contentType: "application/json" }, new URL(mapUrl).pathname);
        artifacts.push(mapArt);
        info.sourceMap = { url: mapUrl, sources: map.sources, artifact: mapArt.ref.sha256 };
        bt.mapped = map.sourcesContent;
        bt.mapSources = map.sources;
      } else {
        const pretty = prettyPrintJs(r.text);
        const prettyArt = scoutArtifact("bundle", pretty, { type: "deminified", url, contentType: "text/javascript" }, `${new URL(url).pathname}.pretty.js`);
        artifacts.push(prettyArt);
        info.deminified = prettyArt.ref.sha256;
        bt.mapped = [pretty];
      }
    }
    infos.push(info);
    texts.push(bt);
  }
  inline.forEach((text, i) => texts.push({ url: `inline:${i}`, type: "js", text, mapped: [], mapSources: [] }));
  return { infos, texts, artifacts };
}

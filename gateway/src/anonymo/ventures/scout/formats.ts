// WS11 · Scout: file formats seen in public docs and samples (Ventures Backend spec, PART 4 and PART 4 Spec Filter:
// "keeps file formats for import tools (e.g. CSV export column names seen in public docs/samples)").

import type { FileFormat } from "../types.ts";
import { textOf, walk, type HtmlNode } from "./html.ts";

const CELL = /^[A-Za-z][\w .()/-]{0,40}$/;

/** A CSV/TSV header row: the first line splits into 2+ name-like cells and a second line has as many cells. */
export function csvHeader(sample: string): { fields: string[]; extension: "csv" | "tsv" } | null {
  const lines = sample.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  for (const [sep, extension] of [[",", "csv"], ["\t", "tsv"], [";", "csv"]] as const) {
    const head = lines[0].split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (head.length < 2 || !head.every((c) => CELL.test(c))) continue;
    if (lines.length > 1 && lines[1].split(sep).length !== head.length) continue;
    return { fields: head, extension };
  }
  return null;
}

/** CSV samples in <pre>/<code> blocks, named by the nearest heading above them. */
export function formatsInPage(root: HtmlNode): FileFormat[] {
  const out: FileFormat[] = [];
  let heading = "";
  walk(root, (n) => {
    if (/^h[1-4]$/.test(n.tag)) heading = textOf(n);
    if (n.tag !== "pre" && !(n.tag === "code" && n.parent?.tag !== "pre")) return;
    const raw = textOfRaw(n);
    const h = csvHeader(raw);
    if (h) out.push({ name: heading || `${h.extension.toUpperCase()} file`, extension: h.extension, fields: h.fields });
  });
  return out;
}

function textOfRaw(n: HtmlNode): string {
  return n.children.map((c) => (typeof c === "string" ? c : textOfRaw(c))).join("");
}

export function formatFromFile(url: string, text: string): FileFormat | null {
  const h = csvHeader(text.split("\n").slice(0, 3).join("\n"));
  if (!h) return null;
  const file = new URL(url).pathname.split("/").pop() ?? "";
  const name = /import/i.test(file) ? "CSV import sample" : /export/i.test(file) ? "CSV export sample" : `${h.extension.toUpperCase()} sample`;
  return { name, extension: h.extension, fields: h.fields };
}

export function mergeFormats(list: FileFormat[]): FileFormat[] {
  const out: FileFormat[] = [];
  for (const f of list) if (!out.some((o) => o.extension === f.extension && o.fields.join("\u0001") === f.fields.join("\u0001"))) out.push(f);
  return out;
}

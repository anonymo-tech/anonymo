// WS11 · Scout: pricing history from the public web archive (Ventures Backend spec, PART 4: "pricing pages and archive
// history").
//
// One CDX query lists captures of <host>/pricing; the earliest and latest distinct captures are read through the
// archive's raw (`id_`) view and parsed with the same pricing reader. Requests go through Scout's fetcher (UA, delay,
// byte budget).

import { scoutArtifact, type Fetcher } from "./crawl.ts";
import { parseHtml } from "./html.ts";
import { extractPricing } from "./pricing.ts";
import type { ArchiveCapture, ArchiveHistory, ScoutArtifact } from "./types.ts";

export const ARCHIVE_ORIGIN = "https://web.archive.org";

export const cdxUrl = (host: string, path = "/pricing", limit = 50) =>
  `${ARCHIVE_ORIGIN}/cdx/search/cdx?url=${encodeURI(`${host}${path}`).replace(/[&#]/g, encodeURIComponent)}&output=json&limit=${limit}`;

/** CDX JSON (`[[header...], [row...], ...]`) → captures with status 200, one per distinct digest, oldest first. */
export function parseCdx(text: string): (ArchiveCapture & { original: string })[] {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0])) return [];
  const head = (rows[0] as unknown[]).map(String);
  const col = (n: string) => head.indexOf(n);
  const [ts, orig, st, dg] = [col("timestamp"), col("original"), col("statuscode"), col("digest")];
  if (ts < 0 || orig < 0) return [];
  const seen = new Set<string>();
  const out: (ArchiveCapture & { original: string })[] = [];
  for (const r of rows.slice(1)) {
    if (!Array.isArray(r)) continue;
    const timestamp = String(r[ts] ?? "");
    const status = st >= 0 ? String(r[st] ?? "") : "200";
    const digest = dg >= 0 ? String(r[dg] ?? "") : timestamp;
    if (!/^\d{8,14}$/.test(timestamp) || (status !== "200" && status !== "-") || seen.has(digest)) continue;
    seen.add(digest);
    out.push({ timestamp, status, digest, original: String(r[orig] ?? "") });
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** `20250301123000` → `2025-03-01`. */
export const archiveDate = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

export async function fetchArchiveHistory(f: Fetcher, host: string, opts: { limit?: number; snapshots?: number } = {}): Promise<{ history: ArchiveHistory | null; artifacts: ScoutArtifact[] }> {
  const r = await f.getExternal(cdxUrl(host, "/pricing", opts.limit ?? 50));
  if (!r || r.status !== 200) return { history: null, artifacts: [] };
  const captures = parseCdx(r.text);
  const artifacts: ScoutArtifact[] = [];
  const grids: ArchiveHistory["grids"] = [];
  const picks = captures.length <= 1 ? captures : [captures[0], captures[captures.length - 1]];
  for (const c of picks.slice(0, Math.max(0, opts.snapshots ?? 2))) {
    const snap = await f.getExternal(`${ARCHIVE_ORIGIN}/web/${c.timestamp}id_/${c.original}`);
    if (!snap || snap.status !== 200) continue;
    artifacts.push(scoutArtifact("page", snap.text, { type: "archive-snapshot", timestamp: c.timestamp, contentType: snap.contentType }, `archive/${c.timestamp}`));
    const grid = extractPricing(parseHtml(snap.text));
    if (grid) grids.push({ timestamp: c.timestamp, grid });
  }
  return { history: { captures: captures.map(({ original: _o, ...c }) => c), grids }, artifacts };
}

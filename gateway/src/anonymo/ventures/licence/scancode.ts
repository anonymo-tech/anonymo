// WS11 · Licence engine: the ScanCode Toolkit adapter (Ventures Backend spec, PART 6).
//
// When a `scancode` binary is on PATH the engine runs
// `scancode --license --copyright --json-pp <out> <dir>` and maps its per-file results onto the same FileEvidence the
// built-in detector produces, so the report shape does not depend on which scanner ran. No binary, a failed run or
// output it cannot read all return null and the caller falls back to the built-in detector. The binary path is
// injectable so tests can stand in a fake script.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { LICENCE_FILE, normaliseLicence } from "./detect.ts";
import { combineSpdx } from "./spdx.ts";
import type { FileEvidence } from "./types.ts";

export type ScancodeOptions = {
  /** Path to the scancode binary. Undefined looks it up on PATH; null skips ScanCode. */
  bin?: string | null;
  timeoutMs?: number;
};

type ScancodeFile = {
  path?: string;
  type?: string;
  detected_license_expression_spdx?: string | null;
  license_detections?: { license_expression_spdx?: string | null }[];
  licenses?: { spdx_license_key?: string | null }[];
  copyrights?: { copyright?: string; value?: string }[];
};

export const findScancode = (bin?: string | null): string | null => (bin === null ? null : bin ?? Bun.which("scancode"));

/** Maps ScanCode's JSON output (toolkit 3.x through 32.x field names) to FileEvidence. Null when it is not ScanCode JSON. */
export function mapScancodeJson(json: unknown, scannedDir: string): FileEvidence[] | null {
  const files = (json as { files?: unknown })?.files;
  if (!Array.isArray(files)) return null;
  const prefix = `${basename(scannedDir)}/`;
  const rows = (files as ScancodeFile[]).filter((f) => f && typeof f.path === "string" && (f.type ?? "file") === "file");
  const strip = rows.length > 0 && rows.every((f) => f.path!.startsWith(prefix));
  const out: FileEvidence[] = [];
  for (const f of rows) {
    const path = (strip ? f.path!.slice(prefix.length) : f.path!).replace(/^\.\/+/, "");
    if (!path || path.split("/").includes(".git")) continue;
    const raw =
      f.detected_license_expression_spdx ||
      combineSpdx((f.license_detections ?? []).map((d) => d.license_expression_spdx)) ||
      combineSpdx((f.licenses ?? []).map((l) => l.spdx_license_key));
    const copyrights: string[] = [];
    for (const c of f.copyrights ?? []) {
      const v = (c.copyright ?? c.value ?? "").replace(/\s+/g, " ").trim();
      if (v && v.length <= 200 && !copyrights.includes(v)) copyrights.push(v);
    }
    out.push({ path, spdx: raw ? normaliseLicence(raw) : null, licenceText: LICENCE_FILE.test(posix.basename(path)), copyrights });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Runs ScanCode over dir. Null when it is not installed or the run fails, so the built-in detector takes over. */
export async function runScancode(dir: string, opts: ScancodeOptions = {}): Promise<FileEvidence[] | null> {
  const bin = findScancode(opts.bin);
  if (!bin) return null;
  const work = await mkdtemp(join(tmpdir(), "anonymo-scancode-"));
  const out = join(work, "scan.json");
  try {
    const proc = Bun.spawn([bin, "--license", "--copyright", "--json-pp", out, dir], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30 * 60_000);
    const code = await proc.exited.finally(() => clearTimeout(timer));
    if (code !== 0) return null;
    const json = JSON.parse(await readFile(out, "utf8")) as unknown;
    return mapScancodeJson(json, dir);
  } catch {
    return null;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

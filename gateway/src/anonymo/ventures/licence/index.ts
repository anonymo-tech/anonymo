// WS11 · Licence engine entry point (Ventures Backend spec, PART 6, Fork & Flip).
//
// `scanRepo` scans a checked-out repo with ScanCode when it is installed and the built-in detector otherwise, and
// returns one LicenceReport whose sha256 is over its canonical JSON (sorted keys), so the exact report a decision was
// made from can be cited in a receipt. `licenceReport` adds the policy decision and the NOTICE text.

import { createHash } from "node:crypto";
import { assembleReport, builtinEvidence, type WalkOptions } from "./detect.ts";
import { noticeFile } from "./notice.ts";
import { decide } from "./policy.ts";
import { runScancode, type ScancodeOptions } from "./scancode.ts";
import type { DecisionInput, LicenceDecision, LicenceReport } from "./types.ts";

export type ScanOptions = WalkOptions & {
  /** ScanCode settings; false skips ScanCode and uses the built-in detector. */
  scancode?: ScancodeOptions | false;
  /** Name for the root component when its manifest has none (defaults to the directory name). */
  name?: string;
};

/** JSON with object keys in sorted order at every level, so equal reports hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The sha256 (hex) of a report's canonical JSON, without its own sha256 field. */
export function reportHash(report: Omit<LicenceReport, "sha256"> | LicenceReport): string {
  const { sha256: _, ...rest } = report as LicenceReport;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

export async function scanRepo(dir: string, opts: ScanOptions = {}): Promise<LicenceReport> {
  const fromScancode = opts.scancode === false ? null : await runScancode(dir, opts.scancode ?? {});
  const evidence = fromScancode ?? (await builtinEvidence(dir, undefined, opts));
  const body = await assembleReport(dir, evidence, fromScancode ? "scancode" : "builtin", { name: opts.name });
  return { ...body, sha256: reportHash(body) };
}

export async function licenceReport(dir: string, input: DecisionInput, opts: ScanOptions = {}): Promise<{ report: LicenceReport; decision: LicenceDecision; notice: string }> {
  const report = await scanRepo(dir, opts);
  const decision = decide(report, input);
  return { report, decision, notice: noticeFile(report, decision) };
}

export { decide, decideExpression, gplRepoAccepts, VERDICT_RANK } from "./policy.ts";
export { noticeFile, reuseHeader, applyReuseHeader, reuseToml, reuseOutput } from "./notice.ts";
export { fetchRepo, findForkCandidates, forkPlan, checkRepoUrl } from "./fork.ts";
export { parseSpdx, tryParseSpdx, formatSpdx, canonicalId } from "./spdx.ts";
export { runScancode, mapScancodeJson } from "./scancode.ts";
export { STORE_ENGINE_DEFAULT, STORE_ENGINE_ALTERNATE, KNOWN_DUAL_LICENCE } from "./catalog.ts";
export type * from "./types.ts";

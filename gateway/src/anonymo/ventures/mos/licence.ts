// WS11 · the licence engine as crew steps (Ventures Backend PART 6, Law 3 "licence before fork").
//
// licence.scan scans the winning build before it goes into the venture's repo; licence.fork fetches an open-source
// repo for Fork & Flip, scans every file, and decides: fork, fork + publish source, manual choice, or clean-room.
// builder.rebrand applies the new brand to an allowed fork, keeps every notice, adds NOTICE and REUSE headers.

import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { uid } from "../../../lib/util.ts";
import { decide, fetchRepo, forkPlan, noticeFile, scanRepo, type LicenceDecision, type LicenceReport } from "../licence/index.ts";
import type { RoleHandler, StepContext } from "../orchestrator.ts";
import { ventureLicenceReports } from "../store/schema.ts";
import type { DesignSystem } from "../design/index.ts";
import type { FileMap } from "./build.ts";
import type { VenturePlan } from "./strategist.ts";

export type LicenceServices = { scancodeBin?: string | false; fetchRepoExec?: Parameters<typeof fetchRepo>[2] extends infer O ? (O extends { exec?: infer E } ? E : never) : never };

async function writeTree(dir: string, files: FileMap) {
  for (const [p, body] of Object.entries(files)) {
    const full = join(dir, p);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
}

const TEXT_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|html|css|scss|yml|yaml|toml|py|go|rs|rb|php|java|kt|swift|c|h|cpp|sh|sql|svg|xml|env\.example|lock)$|(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE|README)[^/]*$/i;

/** Reads a checkout into a file map: text files only, skipping .git and node_modules, up to a byte cap. */
export async function readTree(dir: string, cap = 6_000_000): Promise<{ files: FileMap; truncated: boolean }> {
  const files: FileMap = {};
  let bytes = 0;
  let truncated = false;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const rel = relative(dir, full);
        if (!TEXT_EXT.test(rel)) continue;
        const size = (await stat(full)).size;
        if (bytes + size > cap) {
          truncated = true;
          continue;
        }
        bytes += size;
        files[rel] = await readFile(full, "utf8");
      }
    }
  };
  await walk(dir);
  return { files, truncated };
}

const decisionInput = (s: StepContext) => ({ publishSource: !!s.input.publishSource, repoLicence: s.input.publishSource ? String(s.input.repoLicence ?? "AGPL-3.0-only") : "MIT" });

async function record(s: StepContext, report: LicenceReport, decision: LicenceDecision) {
  await s.ctx.db.insert(ventureLicenceReports).values({ id: uid("lic_"), ventureId: s.venture.id, buildSha: report.sha256, spdx: report, decisions: decision });
}

export const scanBuild: RoleHandler = async (s) => {
  const ref = Object.values(s.needs).flat().find((r) => r.name === "code");
  if (!ref) throw new Error("nothing to scan");
  const files = await s.json<FileMap>(ref);
  const dir = await mkdtemp(join(tmpdir(), "anonymo-licence-"));
  try {
    await writeTree(dir, { ...files, "package.json": JSON.stringify({ name: "venture-app", private: true, license: "MIT" }) });
    const svc = s.deps.services as LicenceServices;
    const report = await scanRepo(dir, { scancode: svc.scancodeBin === false ? false : svc.scancodeBin ? { bin: svc.scancodeBin } : undefined, name: "venture-app" });
    const decision = decide(report, decisionInput(s));
    await record(s, report, decision);
    await s.put({ kind: "report", name: "licence", mime: "application/json", body: JSON.stringify({ report, decision }) });
    await s.put({ kind: "code", name: "notice", mime: "text/plain", body: noticeFile(report, decision) });
    s.log(`licences: ${decision.verdict} (${report.components.length} component(s), ${report.tool})`);
    if (!["allow", "allow-with-obligations"].includes(decision.verdict)) throw new Error(`licence check says ${decision.verdict}: ${decision.reasons.join("; ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export const forkRepo: RoleHandler = async (s) => {
  const url = typeof s.input.repo === "string" ? s.input.repo : "";
  if (!url) throw new Error("Fork & Flip needs a repo url");
  const dir = await mkdtemp(join(tmpdir(), "anonymo-fork-"));
  try {
    const svc = s.deps.services as LicenceServices;
    const fetched = await fetchRepo(url, join(dir, "src"), { exec: svc.fetchRepoExec });
    const report = await scanRepo(fetched.dir, { scancode: svc.scancodeBin === false ? false : svc.scancodeBin ? { bin: svc.scancodeBin } : undefined });
    const decision = decide(report, decisionInput(s));
    const plan = forkPlan(report, decision);
    await record(s, report, decision);
    const { files, truncated } = await readTree(fetched.dir);
    const readme = Object.entries(files).find(([p]) => /^readme/i.test(p))?.[1] ?? "";
    const root = report.components[0];
    const project = { name: root?.name ?? "project", url: fetched.url, sha: fetched.sha, spdx: root?.spdx ?? null, summary: readme.replace(/\s+/g, " ").slice(0, 3000) };
    await s.put({ kind: "report", name: "fork", mime: "application/json", body: JSON.stringify({ project, plan, decision, report: { sha256: report.sha256, tool: report.tool, components: report.components } }) });
    await s.put({ kind: "repo", name: "snapshot", mime: "application/json", body: JSON.stringify(files) });
    s.log(`fork ${project.name}@${fetched.sha.slice(0, 8)}: ${plan.action}${truncated ? " (large repo: text files over the cap were left out)" : ""}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const rebrand: RoleHandler = async (s) => {
  const fork = await s.json<{ project: { name: string; url: string; sha: string }; plan: { action: string; sourceLinkRequired: boolean; obligations: string[]; blockers: string[]; requires: string[] }; decision: LicenceDecision }>(s.need("fork", "fork"));
  if (fork.plan.action === "clean-room" || fork.plan.action === "manual") {
    throw new Error(fork.plan.action === "clean-room" ? `not forkable (${fork.plan.blockers.join(", ") || "licence"}): use Build Better for a clean-room rebuild` : "dual-licence project: choose the licence by hand before forking");
  }
  // Law 3: only an outright allow forks. GPL needs a GPL repo, AGPL/SSPL need publish_source; until the run says so,
  // nothing third-party enters the repo.
  if (!["allow", "allow-with-obligations"].includes(fork.decision.verdict)) {
    throw new Error(`licence says ${fork.decision.verdict}: ${[...fork.plan.requires, ...fork.decision.reasons].join("; ") || "see the licence report"}`);
  }
  const files = await s.json<FileMap>(s.need("fork", "snapshot"));
  const plan = await s.json<VenturePlan>(s.need("plan", "plan"));
  const ds = await s.json<DesignSystem>(s.need("design", "design"));
  const brand = s.input.brand || plan.name || ds.name;
  const old = fork.project.name.replace(/^@[^/]+\//, "");
  const out: FileMap = {};
  for (const [p, body] of Object.entries(files)) {
    // Licence and notice files keep every word: the original notices stay as they are.
    if (/(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE)[^/]*$/i.test(p)) {
      out[p] = body;
      continue;
    }
    out[p] = /(?:^|\/)(?:README[^/]*|package\.json)$/i.test(p) && old.length > 2 ? body.replace(new RegExp(`\\b${escapeRe(old)}\\b`, "g"), brand) : body;
  }
  const notice = [`${brand}`, "", `${brand} is a fork of ${fork.project.name} (${fork.project.url} at ${fork.project.sha}).`, "The original licence and copyright notices are kept unchanged in this repository.", ...(fork.plan.obligations.length ? ["", "Obligations:", ...fork.plan.obligations.map((o) => `- ${o}`)] : [])].join("\n");
  out["NOTICE.fork.md"] = notice + "\n";
  if (fork.plan.sourceLinkRequired) out["SOURCE.md"] = `Source code for ${brand}: this repository. The deployed app links here, as its licence requires.\n`;
  await s.put({ kind: "code", name: "code", mime: "application/json", body: JSON.stringify(out) });
  s.log(`rebranded ${old} → ${brand}; ${Object.keys(out).length} files`);
};

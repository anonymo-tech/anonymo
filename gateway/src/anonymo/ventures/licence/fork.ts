// WS11 · Licence engine: fetching fork candidates and planning the fork (Ventures Backend spec, PART 6, Fork & Flip).
//
// `fetchRepo` shallow-clones one public repo (https or file only, never a URL carrying credentials) with git isolated
// from this machine's configuration: no global or system config, no credential helper, no prompt, so a clone can never
// sign in as anyone. `findForkCandidates` turns the Spec's OSS markers into candidate repos and can ask the public
// GitHub search API, logged out. `forkPlan` turns a licence decision into fork / fork+publish / manual / clean-room.

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Spec } from "../types.ts";
import { licenceClass, type LicenceClass } from "./catalog.ts";
import { normaliseLicence } from "./detect.ts";
import { gplRepoAccepts } from "./policy.ts";
import { spdxLeaves, tryParseSpdx } from "./spdx.ts";
import type { LicenceDecision, LicenceReport } from "./types.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string[], opts: { env: Record<string, string>; timeoutMs: number; cwd?: string }) => Promise<ExecResult>;

export class FetchRepoError extends Error {}

/** Spawns a command with exactly the env given (nothing inherited but PATH), killing it after timeoutMs. */
export const defaultExec: Exec = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, { env: opts.env, cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** Checks a clone URL: https or file only, no embedded credentials, no query or fragment. Returns the parsed URL. */
export function checkRepoUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRepoError("not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "file:") throw new FetchRepoError(`refused ${url.protocol} URL: only https and file are allowed`);
  if (url.username || url.password) throw new FetchRepoError("refused a URL with credentials in it");
  if (url.search || url.hash) throw new FetchRepoError("refused a URL with a query or fragment");
  if (url.protocol === "https:" && !url.hostname) throw new FetchRepoError("refused an https URL without a host");
  return url;
}

/** Git with no user, system or global config: no credential helper, no URL rewrites, no prompts. */
function isolatedGitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
}
const GIT_FLAGS = ["-c", "credential.helper=", "-c", "core.askPass=/bin/false", "-c", "core.symlinks=false", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always"];

async function treeBytes(dir: string, cap: number): Promise<number> {
  let total = 0;
  const visit = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await visit(p);
      else if (e.isFile()) total += (await stat(p)).size;
      if (total > cap) return;
    }
  };
  await visit(dir);
  return total;
}

export type FetchRepoOptions = { exec?: Exec; maxBytes?: number; timeoutMs?: number };
export type FetchedRepo = { dir: string; url: string; sha: string; bytes: number };

/** Shallow-clones a public repo into dest (which must not exist or be empty). Over maxBytes, the clone is removed. */
export async function fetchRepo(url: string, dest: string, opts: FetchRepoOptions = {}): Promise<FetchedRepo> {
  const parsed = checkRepoUrl(url);
  const exec = opts.exec ?? defaultExec;
  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const existing = await readdir(dest).catch(() => null);
  if (existing && existing.length) throw new FetchRepoError("destination is not empty");
  await mkdir(dest, { recursive: true });
  const env = isolatedGitEnv();
  const clone = await exec(["git", ...GIT_FLAGS, "clone", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", "--", parsed.href, dest], { env, timeoutMs });
  if (clone.code !== 0) {
    await rm(dest, { recursive: true, force: true });
    throw new FetchRepoError(`git clone failed (exit ${clone.code})`);
  }
  const bytes = await treeBytes(dest, maxBytes);
  if (bytes > maxBytes) {
    await rm(dest, { recursive: true, force: true });
    throw new FetchRepoError(`repo is larger than ${maxBytes} bytes`);
  }
  const head = await exec(["git", ...GIT_FLAGS, "-C", dest, "rev-parse", "HEAD"], { env, timeoutMs: 30_000 });
  return { dir: dest, url: parsed.href, sha: head.code === 0 ? head.stdout.trim() : "", bytes };
}

// ---- candidates ---------------------------------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ForkCandidate = {
  name: string;
  url: string;
  licence: string | null;
  /** The weakest class among the licence's options, as a first screen before the scan. */
  licenceClass: LicenceClass;
  source: "spec" | "github-search";
  stars?: number;
};

export type FindCandidatesOptions = {
  fetch?: FetchLike;
  /** Ask the public GitHub search API for OSS markers that carry no URL. Off by default. */
  query?: boolean;
  apiBase?: string;
  perName?: number;
};

export type CandidateSearch = { candidates: ForkCandidate[]; rateLimited: boolean; errors: string[] };

const CLASS_ORDER: LicenceClass[] = ["permissive", "weak-copyleft", "gpl", "network-copyleft", "unforkable"];
function weakestClass(spdx: string | null): LicenceClass {
  const node = tryParseSpdx(spdx);
  if (!node) return "unforkable";
  const classes = spdxLeaves(node).map((l) => licenceClass(l.id));
  return CLASS_ORDER.find((c) => classes.includes(c)) ?? "unforkable";
}

const repoUrl = (raw: string | undefined) => {
  if (!raw) return null;
  try {
    return checkRepoUrl(raw.replace(/^git\+/, "")).href;
  } catch {
    return null;
  }
};

/** The Spec's OSS markers as candidate repos, optionally looked up on the public GitHub search API (no token). */
export async function findForkCandidates(oss: Spec["oss"], opts: FindCandidatesOptions = {}): Promise<CandidateSearch> {
  const candidates: ForkCandidate[] = [];
  const errors: string[] = [];
  let rateLimited = false;
  const doFetch = opts.fetch ?? ((u: string, init?: RequestInit) => fetch(u, init));
  const apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const seen = new Set<string>();
  const add = (c: ForkCandidate) => {
    if (seen.has(c.url)) return;
    seen.add(c.url);
    candidates.push(c);
  };

  for (const marker of oss) {
    const url = repoUrl(marker.url);
    if (url) {
      const licence = normaliseLicence(marker.licence);
      add({ name: marker.name, url, licence, licenceClass: weakestClass(licence), source: "spec" });
      continue;
    }
    if (!opts.query || rateLimited) continue;
    const q = encodeURIComponent(`${marker.name} in:name fork:false`);
    try {
      const res = await doFetch(`${apiBase}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${opts.perName ?? 3}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "anonymo-ventures" },
      });
      if (res.status === 403 || res.status === 429) {
        rateLimited = true;
        errors.push(`GitHub search rate limited at ${marker.name}`);
        continue;
      }
      if (!res.ok) {
        errors.push(`GitHub search failed for ${marker.name}: ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { items?: { full_name?: string; clone_url?: string; html_url?: string; license?: { spdx_id?: string | null } | null; stargazers_count?: number }[] };
      for (const item of body.items ?? []) {
        const url = repoUrl(item.clone_url ?? item.html_url);
        if (!url) continue;
        const spdx = item.license?.spdx_id && item.license.spdx_id !== "NOASSERTION" ? normaliseLicence(item.license.spdx_id) : null;
        add({ name: item.full_name ?? marker.name, url, licence: spdx, licenceClass: weakestClass(spdx), source: "github-search", ...(typeof item.stargazers_count === "number" ? { stars: item.stargazers_count } : {}) });
      }
    } catch (e) {
      errors.push(`GitHub search failed for ${marker.name}: ${(e as Error).message}`);
    }
  }
  candidates.sort((a, b) => CLASS_ORDER.indexOf(a.licenceClass) - CLASS_ORDER.indexOf(b.licenceClass));
  return { candidates, rateLimited, errors };
}

// ---- the plan -----------------------------------------------------------------------------------------------------

export type ForkAction = "fork" | "fork+publish" | "manual" | "clean-room";
export type ForkPlan = {
  action: ForkAction;
  /** What the venture must do before the fork is allowed (publish the repo under GPL, publish the source, ...). */
  requires: string[];
  obligations: string[];
  sourceLinkRequired: boolean;
  /** Components that stop a fork outright. */
  blockers: string[];
  notice: boolean;
  reasons: string[];
};

/** fork (keep notices), fork+publish (GPL repo or published source), manual (dual licence) or clean-room. */
export function forkPlan(report: Pick<LicenceReport, "components">, decision: LicenceDecision): ForkPlan {
  const base = { obligations: decision.obligations, reasons: decision.reasons, notice: report.components.length > 0 };
  const blockers = decision.components.filter((c) => c.verdict === "clean-room").map((c) => `${c.name} (${c.spdx ?? "no licence"})`);
  switch (decision.verdict) {
    case "allow":
    case "allow-with-obligations":
      return { ...base, action: decision.sourceLinkRequired ? "fork+publish" : "fork", requires: decision.sourceLinkRequired ? ["publish the deployed app's source and link it as \"source\""] : [], sourceLinkRequired: decision.sourceLinkRequired, blockers };
    case "needs-gpl-repo": {
      const gpl = decision.components.filter((c) => c.verdict === "needs-gpl-repo").flatMap((c) => spdxLeaves(tryParseSpdx(c.effective ?? c.spdx) ?? { type: "licence", id: "" }).map((l) => l.id)).filter((id) => licenceClass(id) === "gpl");
      const target = ["GPL-3.0-or-later", "GPL-2.0-or-later", "GPL-2.0-only"].find((t) => gpl.every((id) => gplRepoAccepts(id, t))) ?? null;
      const requires = [target ? `publish the venture repo under ${target}` : `the GPL versions (${[...new Set(gpl)].join(", ")}) cannot share one repo licence`];
      return { ...base, action: target ? "fork+publish" : "clean-room", requires, sourceLinkRequired: decision.sourceLinkRequired, blockers };
    }
    case "needs-publish-source":
      return { ...base, action: "fork+publish", requires: ["set publishSource and link the deployed app's source as \"source\""], sourceLinkRequired: true, blockers };
    case "manual":
      return { ...base, action: "manual", requires: ["choose one of the dual licences deliberately before forking"], sourceLinkRequired: decision.sourceLinkRequired, blockers };
    case "clean-room":
      return { ...base, action: "clean-room", requires: ["rebuild clean-room from the functional Spec; do not copy the source"], sourceLinkRequired: false, blockers, notice: false };
  }
}

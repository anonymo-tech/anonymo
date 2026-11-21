// WS11 · the venture's own git repo (Ventures Backend PART 7: "the venture owns a git repo (export as a tarball or
// push to the user's remote at any time)", Law 8 "repo export always works").
//
// git runs with no system or global config, no credential helpers and no prompts, so it can never pick up an identity
// or a login from the machine it runs on. Commits are authored by the crew, in UTC. A push to the owner's remote uses
// the token they pass for that one call, through an askpass helper (never in the url or the command line).

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CREW_IDENT = { name: "Anonymo Crew", email: "crew@anonymo.invalid" };

export const repoRoot = (root?: string) => root ?? process.env.VENTURES_REPO_ROOT ?? join(tmpdir(), "anonymo-ventures");
export const repoDir = (root: string | undefined, ventureId: string) => {
  if (!/^[a-z0-9_]+$/i.test(ventureId)) throw new Error("bad venture id");
  return join(repoRoot(root), ventureId);
};

function gitEnv(extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tmpdir(),
    TZ: "UTC",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: CREW_IDENT.name,
    GIT_AUTHOR_EMAIL: CREW_IDENT.email,
    GIT_COMMITTER_NAME: CREW_IDENT.name,
    GIT_COMMITTER_EMAIL: CREW_IDENT.email,
    ...extra,
  };
}

export async function git(dir: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string; bytes: Uint8Array }> {
  const p = Bun.spawn(["git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: gitEnv(extra), stdout: "pipe", stderr: "pipe" });
  const [bytes, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: new TextDecoder().decode(bytes), err, bytes: new Uint8Array(bytes) };
}

const SAFE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_\-./ @+]{1,200}$/;

/** Writes the files and commits them. Creates the repo on first use. Returns the commit sha. */
export async function commitFiles(root: string | undefined, ventureId: string, files: Record<string, string>, message: string): Promise<string> {
  const dir = repoDir(root, ventureId);
  await mkdir(dir, { recursive: true });
  if ((await git(dir, ["rev-parse", "--git-dir"])).code !== 0) {
    const init = await git(dir, ["init", "-q", "-b", "main"]);
    if (init.code !== 0) throw new Error(`git init failed: ${init.err}`);
  }
  for (const [p, body] of Object.entries(files)) {
    if (!SAFE.test(p) || p.startsWith(".git")) throw new Error(`refusing to write ${p}`);
    const full = join(dir, p);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  const add = await git(dir, ["add", "-A"]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.err}`);
  const c = await git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
  if (c.code !== 0) throw new Error(`git commit failed: ${c.err}`);
  return (await git(dir, ["rev-parse", "HEAD"])).out.trim();
}

/** The repo as a .tar.gz of HEAD (Law 8: always available). */
export async function exportTarball(root: string | undefined, ventureId: string): Promise<Uint8Array | null> {
  const dir = repoDir(root, ventureId);
  const r = await git(dir, ["archive", "--format=tar.gz", `--prefix=${ventureId}/`, "HEAD"]);
  return r.code === 0 ? r.bytes : null;
}

export async function headSha(root: string | undefined, ventureId: string): Promise<string | null> {
  const r = await git(repoDir(root, ventureId), ["rev-parse", "HEAD"]);
  return r.code === 0 ? r.out.trim() : null;
}

/** Pushes HEAD to the owner's https remote. The token is handed over through GIT_ASKPASS for this call only. */
export async function pushToRemote(root: string | undefined, ventureId: string, remote: string, o: { branch?: string; token?: string; username?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  let u: URL;
  try {
    u = new URL(remote);
  } catch {
    return { ok: false, error: "remote must be an https url" };
  }
  if (u.protocol !== "https:" || u.username || u.password) return { ok: false, error: "remote must be an https url without credentials in it" };
  const branch = o.branch ?? "main";
  if (!/^[A-Za-z0-9._\-/]{1,100}$/.test(branch) || branch.includes("..")) return { ok: false, error: "bad branch name" };
  const dir = repoDir(root, ventureId);
  const helperDir = join(tmpdir(), `anonymo-askpass-${ventureId}-${Date.now()}`);
  await mkdir(helperDir, { recursive: true });
  const helper = join(helperDir, "askpass.sh");
  await writeFile(helper, '#!/bin/sh\ncase "$1" in Username*) printf "%s" "$VENTURE_PUSH_USER";; *) printf "%s" "$VENTURE_PUSH_TOKEN";; esac\n');
  await chmod(helper, 0o700);
  try {
    const r = await git(dir, ["push", u.toString(), `HEAD:refs/heads/${branch}`], o.token ? { GIT_ASKPASS: helper, VENTURE_PUSH_TOKEN: o.token, VENTURE_PUSH_USER: o.username ?? "x-access-token" } : {});
    return r.code === 0 ? { ok: true } : { ok: false, error: r.err.replaceAll(o.token ?? "\u0000", "***").slice(0, 400) };
  } finally {
    await rm(helperDir, { recursive: true, force: true });
  }
}

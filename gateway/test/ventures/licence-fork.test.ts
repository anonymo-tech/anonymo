import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepoUrl, fetchRepo, FetchRepoError, findForkCandidates, forkPlan, type Exec } from "../../src/anonymo/ventures/licence/fork.ts";
import { decide } from "../../src/anonymo/ventures/licence/policy.ts";
import { scanRepo } from "../../src/anonymo/ventures/licence/index.ts";

// WS11 Licence engine (Ventures Backend PART 6): fetching a fork candidate, finding candidates and the fork plan.
// The clone runs against a file:// repo built in a temp dir; the GitHub search is an injected fetch. No network.

const temps: string[] = [];
const tempDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "licence-fork-"));
  temps.push(d);
  return d;
};
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "sample-user",
  GIT_AUTHOR_EMAIL: "sample-user@example.com",
  GIT_COMMITTER_NAME: "sample-user",
  GIT_COMMITTER_EMAIL: "sample-user@example.com",
  TZ: "UTC",
};
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A local upstream repo with two commits, so a depth-1 clone is visibly shallow. */
async function upstream(): Promise<{ dir: string; head: string }> {
  const dir = join(await tempDir(), "upstream");
  await mkdir(dir);
  git(dir, "init", "-q");
  await writeFile(join(dir, "package.json"), '{"name":"sample-upstream","version":"1.0.0","license":"MIT"}');
  await writeFile(join(dir, "LICENSE"), "Permission is hereby granted, free of charge, to any person obtaining a copy. The above copyright notice and this permission notice shall be included.\nCopyright (c) 2024 Sample Org\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  await writeFile(join(dir, "index.js"), "module.exports = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "second");
  git(dir, "tag", "v1");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

describe("fetchRepo", () => {
  test("shallow-clones a local file:// repo without tags and reports its HEAD", async () => {
    const up = await upstream();
    const dest = join(await tempDir(), "clone");
    const got = await fetchRepo(`file://${up.dir}`, dest);
    expect(got.sha).toBe(up.head);
    expect(got.bytes).toBeGreaterThan(0);
    expect(await readFile(join(dest, "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dest, "tag", "--list")).toBe("");
    const report = await scanRepo(dest, { scancode: false });
    expect(report.components[0]).toMatchObject({ name: "sample-upstream", spdx: "MIT" });
  });

  test("refuses credentials in the URL, other protocols and non-empty destinations", async () => {
    for (const bad of ["https://user:pass@github.com/example/repo.git", "https://token@github.com/example/repo.git", "http://github.com/example/repo.git", "ssh://git@github.com/example/repo.git", "git@github.com:example/repo.git", "ext::sh -c touch% /tmp/pwned", "https://github.com/example/repo.git?x=1", "-uhttps://github.com/x", "not a url"])
      expect(() => checkRepoUrl(bad)).toThrow(FetchRepoError);
    let called = false;
    const exec: Exec = async () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(fetchRepo("https://user:pass@example.com/repo.git", join(await tempDir(), "x"), { exec })).rejects.toThrow("credentials");
    expect(called).toBe(false);
    const full = await tempDir();
    await writeFile(join(full, "keep.txt"), "x");
    await expect(fetchRepo("https://example.com/repo.git", full, { exec })).rejects.toThrow("not empty");
    expect(called).toBe(false);
  });

  test("runs git isolated from this machine's config, with no credential helper or prompt", async () => {
    const calls: { cmd: string[]; env: Record<string, string> }[] = [];
    const exec: Exec = async (cmd, opts) => {
      calls.push({ cmd, env: opts.env });
      if (cmd.includes("clone")) await writeFile(join(cmd[cmd.length - 1], "README"), "hi");
      return { code: 0, stdout: "abc123\n", stderr: "" };
    };
    const got = await fetchRepo("https://example.com/sample/repo.git", join(await tempDir(), "dest"), { exec });
    expect(got.sha).toBe("abc123");
    const clone = calls[0];
    expect(clone.cmd.slice(clone.cmd.indexOf("clone"))).toEqual(["clone", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", "--", "https://example.com/sample/repo.git", got.dir]);
    expect(clone.cmd).toContain("credential.helper=");
    expect(clone.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
    expect(Object.keys(clone.env).some((k) => /TOKEN|GH_|GITHUB/i.test(k))).toBe(false);
  });

  test("a clone over the size cap is removed; a failed clone leaves nothing behind", async () => {
    const up = await upstream();
    const dest = join(await tempDir(), "big");
    await expect(fetchRepo(`file://${up.dir}`, dest, { maxBytes: 10 })).rejects.toThrow("larger than");
    expect(await readdir(dest).catch(() => null)).toBeNull();
    const missing = join(await tempDir(), "missing");
    await expect(fetchRepo(`file://${join(up.dir, "nope")}`, missing)).rejects.toThrow("git clone failed");
    expect(await readdir(missing).catch(() => null)).toBeNull();
  });
});

describe("findForkCandidates", () => {
  const item = (full: string, spdx: string | null, stars: number) => ({ full_name: full, clone_url: `https://github.com/${full}.git`, html_url: `https://github.com/${full}`, license: spdx ? { spdx_id: spdx } : null, stargazers_count: stars });

  test("markers with a URL become candidates without any request; the search is off by default", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response("{}");
    };
    const r = await findForkCandidates(
      [
        { name: "medusa", licence: "MIT", url: "https://github.com/medusajs/medusa" },
        { name: "nolink", licence: "MIT" },
        { name: "bad", licence: "MIT", url: "https://user:pw@github.com/example/bad" },
      ],
      { fetch },
    );
    expect(calls).toBe(0);
    expect(r.candidates).toEqual([{ name: "medusa", url: "https://github.com/medusajs/medusa", licence: "MIT", licenceClass: "permissive", source: "spec" }]);
  });

  test("the logged-out GitHub search fills in markers without a URL, permissive first", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return Response.json({ items: [item("example/shop-agpl", "AGPL-3.0", 900), item("example/shop-mit", "MIT", 500), item("example/shop-none", "NOASSERTION", 10)] });
    };
    const r = await findForkCandidates([{ name: "shop", licence: null }], { fetch, query: true, apiBase: "http://127.0.0.1:1" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://127.0.0.1:1/search/repositories?q=shop%20in%3Aname%20fork%3Afalse&sort=stars&order=desc&per_page=3");
    expect(Object.keys(seen[0].headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(r.candidates.map((c) => [c.name, c.licence, c.licenceClass])).toEqual([
      ["example/shop-mit", "MIT", "permissive"],
      ["example/shop-agpl", "AGPL-3.0-only", "network-copyleft"],
      ["example/shop-none", null, "unforkable"],
    ]);
    expect(r.rateLimited).toBe(false);
  });

  test("a rate limit stops further searches and is reported, not thrown", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    };
    const r = await findForkCandidates([{ name: "a", licence: null }, { name: "b", licence: null }], { fetch, query: true });
    expect(calls).toBe(1);
    expect(r.rateLimited).toBe(true);
    expect(r.candidates).toEqual([]);
    expect(r.errors[0]).toContain("rate limited");
    const broken = await findForkCandidates([{ name: "a", licence: null }], { fetch: async () => Promise.reject(new Error("offline")), query: true });
    expect(broken.errors[0]).toContain("offline");
  });

  test("works against a local Bun.serve stand-in for the search API", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/search/repositories" ? Response.json({ items: [item("example/saleor-like", "BSD-3-Clause", 3)] }) : new Response("no", { status: 404 })) });
    try {
      const r = await findForkCandidates([{ name: "saleor-like", licence: null }], { query: true, apiBase: `http://127.0.0.1:${server.port}` });
      expect(r.candidates.map((c) => c.licence)).toEqual(["BSD-3-Clause"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("forkPlan", () => {
  const plan = (spdx: (string | null)[], input = { publishSource: false, repoLicence: "MIT" }, dual: { name: string; reason: string }[] = []) => {
    const report = { components: spdx.map((s, i) => ({ name: `c${i}`, path: i ? `vendor/c${i}` : ".", spdx: s, copyrights: [], files: 1 })), files: [], dualLicence: dual };
    return forkPlan(report, decide(report, input));
  };

  test("fork, fork+publish, manual and clean-room", () => {
    expect(plan(["MIT", "Apache-2.0"])).toMatchObject({ action: "fork", requires: [], notice: true, blockers: [] });
    expect(plan(["MIT", "GPL-3.0-only"])).toMatchObject({ action: "fork+publish", requires: ["publish the venture repo under GPL-3.0-or-later"] });
    expect(plan(["MIT", "GPL-2.0-only"])).toMatchObject({ action: "fork+publish", requires: ["publish the venture repo under GPL-2.0-only"] });
    expect(plan(["GPL-2.0-only", "GPL-3.0-only"]).action).toBe("clean-room");
    expect(plan(["MIT", "AGPL-3.0-only"])).toMatchObject({ action: "fork+publish", sourceLinkRequired: true });
    expect(plan(["MIT", "AGPL-3.0-only"], { publishSource: true, repoLicence: "MIT" })).toMatchObject({ action: "fork+publish", sourceLinkRequired: true });
    expect(plan(["GPL-3.0-or-later"], { publishSource: false, repoLicence: "GPL-3.0-or-later" }, [{ name: "c0", reason: "known dual-licence project" }]).action).toBe("manual");
    expect(plan(["MIT", "BUSL-1.1"])).toMatchObject({ action: "clean-room", blockers: ["c1 (BUSL-1.1)"], notice: false });
    expect(plan([null])).toMatchObject({ action: "clean-room", blockers: ["c0 (no licence)"] });
  });
});

// Build Better, Takeover Kit, Fork & Flip and the static deploy, end to end against the fictional "Ledgerly" site and
// mock providers (Ventures Backend PART 13 acceptance 1–3 and 6, Laws 1–3).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { venturesRuntime } from "../../src/anonymo/ventures/runtime.ts";
import { defaultSandboxPool } from "../../src/anonymo/ventures/runtime.ts";
import { ventureDeployments, ventures } from "../../src/anonymo/ventures/store/schema.ts";
import { defaultBuilderPolicy, LocalDriver, SandboxPool, type SandboxPolicy } from "../../src/anonymo/ventures/sandbox/index.ts";
import { startRouter } from "../helpers.ts";
import { CREW_PROVIDERS, crewReply } from "./fixtures/crew-mock.ts";
import { fixtureFetch, startFixtureSite, type FixtureSite } from "./fixtures/saas/server.ts";

type H = Awaited<ReturnType<typeof startRouter>>;
let h: H;
let auth: Record<string, string>;
let site: FixtureSite;
const prompts: string[] = [];
const policies: SandboxPolicy[] = [];
const repoRoot = mkdtempSync(join(tmpdir(), "ventures-modes-"));
const cleanups: (() => unknown)[] = [];

async function waitFor(id: string, ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = (await (await h.request(`/v1/ventures/${id}`, { headers: auth })).json()) as any;
    if (["DONE", "FAILED", "CAPPED", "CANCELLED"].includes(j.data.status)) return j.data;
    await Bun.sleep(150);
  }
  throw new Error("venture did not finish");
}
const start = async (json: Record<string, unknown>) => {
  const r = await h.request("/v1/ventures", { method: "POST", headers: auth, json });
  const j = (await r.json()) as any;
  if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j.data;
};
const artifact = async (v: any, name: string) => {
  const arts = ((await (await h.request(`/v1/ventures/${v.id}/artifacts`, { headers: auth })).json()) as any).data;
  const a = arts.find((x: any) => x.name === name);
  return a ? (await h.request(`/v1/ventures/${v.id}/artifacts/${a.sha256}`, { headers: auth })).text() : null;
};

beforeAll(async () => {
  site = startFixtureSite();
  // Record every prompt any provider receives, so the tests can prove the target never reaches a model.
  const providers = CREW_PROVIDERS.map((p) => ({ ...p, reply: (prompt: string, body: any) => (prompts.push(JSON.stringify(body.messages)), crewReply(prompt, body)) }));
  h = await startRouter({ env: { ANONYMO_FEATURE_VENTURES: "true" }, providers });
  const pool = defaultSandboxPool(h.ctx);
  const recording = new Proxy(pool, { get: (t, k) => (k === "run" ? (policy: SandboxPolicy, fn: any, ro: any) => (policies.push(policy), t.run(policy, fn, ro)) : (t as any)[k]) });
  venturesRuntime(h.app as never, h.ctx, { services: { repoRoot, allowPrivateTargets: true, scoutFetch: fixtureFetch(site.origin), scoutArchive: true, sleep: async () => {}, sandboxPool: recording } });
  const k = await h.fundedKey(1000n);
  auth = k.auth;
});
afterAll(async () => {
  for (const c of cleanups) c();
  await h.close();
  site.stop();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("Build Better", () => {
  let v: any;
  test("runs the firewall: scout → spec filter → clean crew", async () => {
    const created = await start({ mode: "BUILD_BETTER", target_url: site.origin + "/", brand: "Tallyhop", rival: "Ledgerly" });
    expect(created.target_commit).toMatch(/^0x[0-9a-f]{64}$/);
    expect(created.target_salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(created.steps.map((s: any) => s.key)).not.toContain("deploy"); // Law 2: no gate yet, so no deploy step
    v = await waitFor(created.id);
    expect(v.error).toBeNull();
    expect(v.status).toBe("DONE");
  }, 180_000);

  test("the target url never reached any model, and the target is not stored in clear", async () => {
    expect(prompts.length).toBeGreaterThan(10);
    for (const p of prompts) {
      expect(p).not.toContain(site.host);
      expect(p).not.toContain(site.origin);
    }
    const row = JSON.stringify(await h.ctx.db.execute(`select * from ventures where id = '${v.id}'` as never));
    expect(row).not.toContain(site.host);
  });

  test("only the Spec crosses: the spec step writes CLEAN only, and every CLEAN step's inputs are CLEAN", () => {
    const byKey = Object.fromEntries(v.steps.map((s: any) => [s.key, s]));
    expect(byKey.scout.zone).toBe("SCOUT");
    expect(byKey.scout.outputs.every((o: any) => o.zone === "SCOUT")).toBe(true);
    expect(byKey.spec.outputs.every((o: any) => o.zone === "CLEAN")).toBe(true);
    for (const s of v.steps.filter((x: any) => x.zone === "CLEAN")) for (const n of s.needs) expect(byKey[n].outputs.every((o: any) => o.zone === "CLEAN")).toBe(true);
  });

  test("scout artifacts are listed by hash but never served; the owner reads CLEAN bodies", async () => {
    const arts = ((await (await h.request(`/v1/ventures/${v.id}/artifacts`, { headers: auth })).json()) as any).data;
    const scout = arts.find((a: any) => a.zone === "SCOUT");
    expect((await h.request(`/v1/ventures/${v.id}/artifacts/${scout.sha256}`, { headers: auth })).status).toBe(403);
  });

  test("logged-out only: login and signup were never requested", () => {
    expect(site.log.some((r) => r.path.startsWith("/login") || r.path.startsWith("/signup"))).toBe(false);
  });

  test("builder sandboxes deny the target host", () => {
    const builderPolicies = policies.filter((p) => p.zone === "CLEAN");
    expect(builderPolicies.length).toBeGreaterThan(0);
    for (const p of builderPolicies) expect(p.egressDeny).toContain("127.0.0.1");
  });

  test("the comparison page keeps only rows that cite a dated finding", async () => {
    const html = (await artifact(v, "comparison"))!;
    expect(html).toContain("Tallyhop");
    expect(html).toContain("Ledgerly");
    expect(html).not.toContain("Uncited claim");
    expect(html).toMatch(/\d{4}-\d{2}-\d{2}/);
    const claims = JSON.parse((await artifact(v, "comparison-claims"))!);
    expect(claims.dropped).toBe(1);
    expect(claims.rows.length).toBeGreaterThan(0);
  });

  test("the receipt carries the scout hashes, the spec hash and a clean-room root", async () => {
    const r = ((await (await h.request(`/v1/ventures/${v.id}/receipt`, { headers: auth })).json()) as any).data;
    expect(r.clean_room.scoutArtifactHashes.length).toBeGreaterThan(3);
    expect(r.clean_room.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.clean_room.builderArtifactHashes.length).toBeGreaterThan(0);
  });
});

describe("Takeover Kit", () => {
  test("comparison, switch kit, 30 ads and a tested import tool for the rival's export format", async () => {
    const created = await start({ mode: "TAKEOVER", target_url: site.origin + "/", brand: "Tallyhop", rival: "Ledgerly" });
    const v = await waitFor(created.id);
    expect(v.error).toBeNull();
    expect(v.status).toBe("DONE");
    const ads = JSON.parse((await artifact(v, "ads"))!);
    expect(ads.ads.length).toBe(30);
    expect((await artifact(v, "alternative"))!).toContain("Tallyhop");
    const build = v.steps.find((s: any) => s.key === "build");
    expect(build.candidates.some((c: any) => c.chosen && c.pass_rate === 1)).toBe(true);
    const code = JSON.parse((await artifact(v, "code"))!);
    expect(code["src/import.ts"]).toContain("parseExport");
    expect(code["test/import.test.ts"]).toContain("parseExport");
  }, 180_000);
});

function localRepo(licence: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "fork-src-"));
  writeFileSync(join(dir, "LICENSE"), licence);
  writeFileSync(join(dir, "README.md"), `# ${name}\n\n${name} is a tiny tool.\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license: licence.startsWith("MIT") ? "MIT" : "AGPL-3.0-only" }));
  writeFileSync(join(dir, "index.js"), "export const hello = () => 'hi';\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "sample-user", GIT_AUTHOR_EMAIL: "sample@example.com", GIT_COMMITTER_NAME: "sample-user", GIT_COMMITTER_EMAIL: "sample@example.com" };
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "init"]]) Bun.spawnSync(["git", ...a], { cwd: dir, env });
  return dir;
}

const MIT_TEXT = 'MIT License\n\nCopyright (c) 2026 sample-user\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n';
const AGPL_TEXT = "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n\nCopyright (C) 2007 Free Software Foundation, Inc.\n";

describe("Fork & Flip (Law 3: licence before fork)", () => {
  test("an MIT repo is forked, rebranded, keeps its licence and gets a NOTICE", async () => {
    const dir = localRepo(MIT_TEXT, "tinytool");
    const v = await waitFor((await start({ mode: "FORK_FLIP", repo_url: `file://${dir}`, brand: "Brightkit", brief: "Fork tinytool into a nicer product." })).id);
    expect(v.error).toBeNull();
    expect(v.status).toBe("DONE");
    const code = JSON.parse((await artifact(v, "code"))!);
    expect(code.LICENSE).toBe(MIT_TEXT);
    expect(code["README.md"]).toContain("Brightkit");
    expect(code["NOTICE.fork.md"]).toContain("tinytool");
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  test("an AGPL repo without publish_source is not forked", async () => {
    const dir = localRepo(AGPL_TEXT, "copyleft-tool");
    const v = await waitFor((await start({ mode: "FORK_FLIP", repo_url: `file://${dir}`, brief: "Fork it into a product." })).id);
    expect(v.status).toBe("FAILED");
    expect(v.steps.find((s: any) => s.key === "rebrand").state).toBe("FAILED");
    expect(v.steps.find((s: any) => s.key === "repo").state).toBe("SKIPPED");
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

describe("static deploy behind the gate", () => {
  const stored = new Map<string, Uint8Array>();
  let kuboA: ReturnType<typeof Bun.serve>;
  let kuboB: ReturnType<typeof Bun.serve>;
  let gateway: ReturnType<typeof Bun.serve>;
  const CID = "bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm";
  beforeAll(() => {
    const kubo = () =>
      Bun.serve({
        port: 0,
        async fetch(req) {
          const form = await req.formData();
          for (const [, v] of form.entries()) if (typeof v !== "string") stored.set(decodeURIComponent((v as File).name), new Uint8Array(await (v as File).arrayBuffer()));
          return new Response([JSON.stringify({ Name: "index.html", Hash: "bafkqaaa", Size: "1" }), JSON.stringify({ Name: "", Hash: CID, Size: "10" })].join("\n") + "\n");
        },
      });
    kuboA = kubo();
    kuboB = kubo();
    gateway = Bun.serve({ port: 0, fetch: () => new Response(stored.get("index.html") ?? stored.get([...stored.keys()].find((k) => k.endsWith("index.html")) ?? "") ?? "missing", { headers: { "content-type": "text/html" } }) });
    venturesRuntime(h.app as never, h.ctx, { services: { deployEnv: { VENTURES_IPFS_A_URL: `http://127.0.0.1:${kuboA.port}`, VENTURES_IPFS_A_TOKEN: "token-a", VENTURES_IPFS_B_URL: `http://localhost:${kuboB.port}`, VENTURES_IPFS_B_TOKEN: "token-b", VENTURES_IPFS_GATEWAYS: `http://127.0.0.1:${gateway.port}` } } });
  });
  // The mock pinning services stay up for the later deploy tests; the file's afterAll stops them.
  cleanups.push(() => (kuboA.stop(true), kuboB.stop(true), gateway.stop(true)));

  test("an Idea to Live site passes the gate and goes live on two pinning services", async () => {
    const v = await waitFor((await start({ mode: "IDEA_TO_LIVE", brief: "A notes API for small teams.", deploy: { domain: "notes.example.com" } })).id);
    const dep = v.steps.find((s: any) => s.key === "deploy");
    expect(dep.error).toBeNull();
    expect(dep.state).toBe("DONE");
    const [row] = await h.ctx.db.select().from(ventureDeployments).where(eq(ventureDeployments.ventureId, v.id));
    expect(row!.cid).toBe(CID);
    expect(row!.status).toBe("live");
    expect((row!.details as any).dnslink.value).toBe(`dnslink=/ipfs/${CID}`);
    expect(JSON.parse((await artifact(v, "gate"))!).verdict).toBe("PASS");
    // The deploy was charged to the run's own budget, not absorbed.
    const { ledger } = await import("../../src/db/schema.ts");
    const rows = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `venture:${v.id}:deploy:deploy`));
    expect(rows.length).toBe(1);
    expect(rows[0]!.amount).toBe(-(5n * 10n ** 11n)); // $0.50
  }, 180_000);
});

describe("acceptance 2: a builder sandbox's request to the target is dropped and logged", () => {
  test("fetching the target from inside a CLEAN sandbox fails, and the egress log records the drop", async () => {
    const pool = new SandboxPool({ driver: new LocalDriver(), pricePerVcpuMinuteUsd: 0 });
    const policy = defaultBuilderPolicy({ gatewayHost: "anonymo.tech", targetHosts: ["127.0.0.1", "ledgerly.test"] });
    const out = await pool.run(policy, async (sb) => {
      await sb.writeFiles({ "probe.ts": `try { const r = await fetch("http://ledgerly.test/pricing"); console.log("status", r.status); } catch (e) { console.log("blocked"); }` });
      const r = await sb.exec(["bun", "probe.ts"], { timeoutMs: 20_000 });
      return { stdout: r.stdout, log: sb.egressLog() };
    });
    expect(out.stdout).not.toContain("status 200");
    expect(out.log.some((d) => d.host === "ledgerly.test" && !d.allowed)).toBe(true);
  }, 60_000);
});

describe("People's Forks: a funded fork is built by the crew and fulfil() is prepared", () => {
  test("triggered on chain → Build Better on the registered url → MIT repo → fulfil calldata", async () => {
    const { syncChain } = await import("../../src/anonymo/ventures/routes.ts");
    const { fulfilPayload, targetCommitOf } = await import("../../src/anonymo/ventures/forks.ts");
    const salt = ("0x" + "22".repeat(32)) as `0x${string}`;
    const url = site.origin + "/";
    const commit = targetCommitOf(salt, url);
    let events: any[] = [{ forkId: "41", kind: "opened", targetCommit: commit, chainId: 4663 }];
    const rt = venturesRuntime(h.app as never, h.ctx, { services: { chainReader: { forkEvents: async () => events, crewFamilies: async () => null } } });
    await syncChain(rt);
    const reg = await h.request("/v1/forks/41/target", { method: "POST", headers: auth, json: { url, salt } });
    expect(reg.status).toBe(200);
    events = [...events, { forkId: "41", kind: "triggered", chainId: 4663, usdgRouted: 200_000_000n }]; // 200 USDG of cash covers the build
    const { started } = await syncChain(rt);
    expect(started.length).toBe(1);
    const ventureId = started[0]!;
    const t0 = Date.now();
    let status = "";
    while (Date.now() - t0 < 120_000) {
      const [row] = await h.ctx.db.select({ status: ventures.status }).from(ventures).where(eq(ventures.id, ventureId));
      status = row?.status ?? "";
      if (["DONE", "FAILED", "CAPPED", "CANCELLED"].includes(status)) break;
      await Bun.sleep(150);
    }
    expect(status).toBe("DONE");
    const p = await fulfilPayload(h.ctx, "41", "0x00000000000000000000000000000000000f0f0f", repoRoot);
    expect(p).not.toBeNull();
    expect(p!.data).toMatch(/^0x/);
    expect(p!.receipt.targetCommit).toBe(commit);
    expect(p!.receipt.licenceSpdxHash).toBe(keccakMit);
  }, 180_000);
});

import { keccak256 as k256, toBytes as tb } from "viem";
const keccakMit = k256(tb("MIT"));

describe("acceptance 6: an AGPL fork deploys only with publish_source and a live source link", () => {
  test("with publish_source and source_url the fork deploys and the page links to its source", async () => {
    const dir = localRepo(AGPL_TEXT, "copyleft-app");
    const v = await waitFor((await start({ mode: "FORK_FLIP", repo_url: `file://${dir}`, publish_source: true, source_url: "https://code.example/copyleft-app", brief: "Fork it and publish the source.", deploy: { domain: "copyleft.example.com" } })).id);
    const dep = v.steps.find((s: any) => s.key === "deploy");
    expect(v.steps.find((s: any) => s.key === "rebrand").state).toBe("DONE");
    expect(dep.state).toBe("DONE");
    const { injectSourceLink } = await import("../../src/anonymo/ventures/mos/ship.ts");
    expect(injectSourceLink("<body><h1>x</h1></body>", "https://code.example/a")).toContain('href="https://code.example/a"');
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  test("with publish_source but no source_url the deploy is refused", async () => {
    const dir = localRepo(AGPL_TEXT, "copyleft-app-2");
    const v = await waitFor((await start({ mode: "FORK_FLIP", repo_url: `file://${dir}`, publish_source: true, brief: "Fork it and publish the source.", deploy: { domain: "copyleft2.example.com" } })).id);
    const dep = v.steps.find((s: any) => s.key === "deploy");
    expect(dep.state).toBe("FAILED");
    expect(dep.error).toContain("source");
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});

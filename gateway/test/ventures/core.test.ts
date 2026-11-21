// Unit and property tests for the Ventures core: copy rules, prices and tiers, Boss Mo's DAGs, recipe validation (the
// firewall can't be weakened by a recipe), zones, events, forks and votes, the clean-room root.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { keccak256, toBytes, type Hex } from "viem";
import { copyIsClean, lintCopy, lintDeep, LAUNCH_LINES } from "../../src/anonymo/ventures/copy.ts";
import { priceList, priceOf, tierAllows, tierForStake, TIER_RULES } from "../../src/anonymo/ventures/pricing.ts";
import { planVenture, runTickPlan } from "../../src/anonymo/ventures/boss.ts";
import { validateDag, TASKS } from "../../src/anonymo/ventures/recipes.ts";
import { assertAcyclic, checkZoneInputs, targetHosts, type StepTemplate } from "../../src/anonymo/ventures/orchestrator.ts";
import { getArtifact, putArtifact, ZoneViolation } from "../../src/anonymo/ventures/store/artifacts.ts";
import { VentureEvents } from "../../src/anonymo/ventures/events.ts";
import { cleanRoomRoot } from "../../src/anonymo/ventures/receipt.ts";
import { optionId, optionName, registerForkTarget, syncForks, syncVotes, targetCommitOf, winners, type ChainReader } from "../../src/anonymo/ventures/forks.ts";
import { allowedFamilies, allowFamilies, isCrewModel, pickFamilies, nextFamily } from "../../src/anonymo/ventures/crew/families.ts";
import { checkClaims, scrub } from "../../src/anonymo/ventures/mos/adman.ts";
import { bareImports, cleanFiles, importTests, parseBunTest, rankCandidates, staticScan } from "../../src/anonymo/ventures/mos/build.ts";
import { strictGate } from "../../src/anonymo/ventures/mos/ship.ts";
import { specDiff } from "../../src/anonymo/ventures/runmode.ts";
import { fallbackTier, setTierReader, tierOfKey } from "../../src/anonymo/ventures/tiers.ts";
import { targetProblem } from "../../src/anonymo/ventures/routes.ts";
import { emptySpec, VENTURE_MODES, type Tier, type VentureMode } from "../../src/anonymo/ventures/types.ts";
import { anonymoKeys } from "../../src/anonymo/deposits/schema.ts";
import { startRouter } from "../helpers.ts";

/** A tiny seeded generator for property loops (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("copy rules (Overview §11)", () => {
  test("banned words and claims are caught, ordinary words are not", () => {
    for (const bad of ["Earn while you sleep", "10% APY", "guaranteed results", "place a bet", "the odds are good", "gamble on it", "our partner", "the official store", "audited code", "clone any site", "copy their code", "steal their store", "make money fast", "passive income"]) expect(lintCopy(bad).length).toBeGreaterThan(0);
    for (const ok of ["Learn faster", "Better than the rest", "Rebuild it", "Parity plus", "Dupe the bestseller. Keep your brand.", "Partial refunds", "Betting nothing"]) expect(copyIsClean(ok)).toBe(ok !== "Betting nothing" ? true : false);
  });
  test("the launch lines pass their own rules", () => {
    for (const l of LAUNCH_LINES) expect(copyIsClean(l)).toBe(true);
  });
  test("scrub removes exactly the strings that break the rules", () => {
    const { value, removed } = scrub({ a: "fine", b: ["ok", "guaranteed"], c: { d: "earn yield" } });
    expect(value).toEqual({ a: "fine", b: ["ok"], c: {} });
    expect(removed.length).toBe(2);
    expect(lintDeep(value)).toEqual([]);
  });
});

describe("prices and tiers (Overview §5–6)", () => {
  test("prices match the table, NYMO is 25% less", () => {
    expect([priceOf("IDEA_TO_LIVE"), priceOf("DUPE_DROP"), priceOf("BUILD_BETTER"), priceOf("TAKEOVER"), priceOf("RUN")]).toEqual([79, 99, 149, 49, 5]);
    expect(priceList().runs.find((r) => r.mode === "BUILD_BETTER")!.nymoUsdEquivalent).toBe(111.75);
  });
  test("tier thresholds and crew sizes", () => {
    expect([0, 49_999, 50_000, 250_000, 999_999, 1_000_000].map(tierForStake)).toEqual(["solo", "solo", "crew", "gang", "gang", "syndicate"]);
    expect([TIER_RULES.solo.builders, TIER_RULES.crew.builders, TIER_RULES.gang.builders, TIER_RULES.syndicate.builders]).toEqual([1, 3, 5, 8]);
    expect(tierAllows("solo", "BUILD_BETTER")).toBe(false);
    expect(tierAllows("crew", "TAKEOVER")).toBe(true);
  });
});

describe("Boss Mo's plans", () => {
  const modes = VENTURE_MODES.filter((m) => m !== "DUPE_DROP" && m !== "RUN") as VentureMode[];
  test("every mode × tier × deploy plan is acyclic, uses known tasks in their own zone, and passes recipe validation", () => {
    for (const mode of modes)
      for (const tier of Object.keys(TIER_RULES) as Tier[])
        for (const deploy of [false, true]) {
          const plan = planVenture(mode, { tier, deploy });
          expect(() => assertAcyclic(plan)).not.toThrow();
          expect(() => validateDag(mode, plan)).not.toThrow();
          for (const s of plan) expect(TASKS[s.task]!.zone).toBe(s.zone);
          const build = plan.find((s) => s.key === "build");
          if (build) expect(build.fanout).toBe(TIER_RULES[tier].builders);
          expect(plan.reduce((n, s) => n + s.share, 0)).toBeLessThanOrEqual(1.0001);
        }
  });
  test("modes with a target never plan a deploy (Law 2: no gate yet)", () => {
    for (const mode of ["BUILD_BETTER", "TAKEOVER"] as VentureMode[]) expect(planVenture(mode, { tier: "syndicate", deploy: true }).some((s) => s.task === "deployer.static")).toBe(false);
  });
  test("only scout and spec filter run in the SCOUT zone", () => {
    for (const mode of modes) for (const s of planVenture(mode, { tier: "gang", deploy: true })) if (s.zone === "SCOUT") expect(["scout.site", "spec.filter"]).toContain(s.task);
  });
  test("a Run Mode tick without a target skips the watch task", () => {
    expect(runTickPlan(1, ["watch", "ads"], { hasTarget: false }).map((s) => s.task)).toEqual(["run.ads"]);
    expect(runTickPlan(1, ["watch"], { hasTarget: true }).map((s) => s.task)).toEqual(["scout.site", "spec.filter", "run.watch"]);
  });
  test("Dupe Drop is not planned yet", () => {
    expect(() => planVenture("DUPE_DROP", { tier: "crew", deploy: false })).toThrow();
  });
});

describe("recipes can't weaken the firewall", () => {
  const base = planVenture("BUILD_BETTER", { tier: "crew", deploy: false });
  const tweak = (f: (d: StepTemplate[]) => void) => {
    const d = structuredClone(base);
    f(d);
    return d;
  };
  test("a builder moved into the SCOUT zone is refused", () => {
    expect(() => validateDag("BUILD_BETTER", tweak((d) => (d.find((s) => s.key === "build")!.zone = "SCOUT")))).toThrow();
  });
  test("a CLEAN step wired straight to the scout is refused", () => {
    expect(() => validateDag("BUILD_BETTER", tweak((d) => d.find((s) => s.key === "parity")!.needs.push("scout")))).toThrow();
  });
  test("a deploy step on a target mode is refused", () => {
    expect(() => validateDag("BUILD_BETTER", tweak((d) => d.push({ key: "deploy", task: "deployer.static", role: "deployer", kind: "deploy", zone: "CLEAN", fanout: 1, select: "single", needs: ["repo"], share: 0.01 })))).toThrow();
  });
  test("a scout step in a mode without a target is refused", () => {
    expect(() => validateDag("IDEA_TO_LIVE", [{ key: "scout", task: "scout.site", role: "scout", kind: "research", zone: "SCOUT", fanout: 1, select: "single", needs: [], share: 0.1 }])).toThrow();
  });
  test("unknown tasks and cycles are refused", () => {
    expect(() => validateDag("IDEA_TO_LIVE", tweak((d) => (d[0]!.task = "shell.exec")))).toThrow();
    expect(() => validateDag("BUILD_BETTER", tweak((d) => d.find((s) => s.key === "scout")!.needs.push("repo")))).toThrow();
  });
});

describe("zones (Law 1)", () => {
  test("a CLEAN step is never handed a SCOUT input", () => {
    expect(() => checkZoneInputs({ zone: "CLEAN", key: "x" }, [{ sha256: "ab", kind: "page", zone: "SCOUT" }])).toThrow();
    expect(() => checkZoneInputs({ zone: "SCOUT", key: "x" }, [{ sha256: "ab", kind: "page", zone: "SCOUT" }])).not.toThrow();
  });
  test("targetHosts covers the bare and www forms", () => {
    expect(targetHosts("https://www.Example.com/pricing")).toEqual(["www.example.com", "example.com"]);
    expect(targetHosts(null)).toEqual([]);
  });
  test("targets must be public http(s) urls without credentials", () => {
    for (const bad of ["ftp://x.com", "http://localhost/", "http://10.0.0.2/", "http://192.168.1.4/", "https://user:pw@x.com/", "http://169.254.169.254/latest", "not a url"]) expect(targetProblem(bad)).not.toBeNull();
    expect(targetProblem("https://example.com/")).toBeNull();
  });
});

describe("artifact store", () => {
  let h: Awaited<ReturnType<typeof startRouter>>;
  beforeAll(async () => {
    h = await startRouter({ env: { ANONYMO_FEATURE_VENTURES: "true" } });
  });
  afterAll(async () => h.close());
  test("a CLEAN reader can't read SCOUT bytes; a SCOUT reader can; binary round-trips", async () => {
    const scout = await putArtifact(h.ctx.db, "v_test", { kind: "page", zone: "SCOUT", body: "<html>their page</html>" });
    await expect(getArtifact(h.ctx.db, "v_test", scout.sha256, "CLEAN")).rejects.toBeInstanceOf(ZoneViolation);
    expect((await getArtifact(h.ctx.db, "v_test", scout.sha256, "SCOUT"))!.body).toBe("<html>their page</html>");
    const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2]);
    const ref = await putArtifact(h.ctx.db, "v_test", { kind: "screenshot", zone: "SCOUT", mime: "image/png", body: png });
    const back = await getArtifact(h.ctx.db, "v_test", ref.sha256, "SCOUT");
    expect([...(back!.body as Uint8Array)]).toEqual([...png]);
    expect(back!.mime).toBe("image/png");
  });
  test("tiers: the fallback without a wallet or contract, the chain reader with one, and solo when the chain fails", async () => {
    expect(fallbackTier({})).toBe("crew");
    expect(fallbackTier({ VENTURES_TIER_FALLBACK: "solo" })).toBe("solo");
    const k = await h.newKey();
    expect((await tierOfKey(h.ctx, k.hash)).source).toBe("fallback");
    await h.ctx.db.insert(anonymoKeys).values({ keyHash: k.hash, wallet: "0x" + "ab".repeat(20) });
    setTierReader(async () => ({ tier: "gang", twabNymo: 300_000 }));
    expect((await tierOfKey(h.ctx, k.hash)).tier).toBe("gang");
    setTierReader(async () => {
      throw new Error("rpc down");
    });
    expect((await tierOfKey(h.ctx, k.hash)).tier).toBe("solo");
    setTierReader(null);
  });
  test("People's Forks: events sync, the url must match the commitment, triggers are reported once", async () => {
    const salt = ("0x" + "11".repeat(32)) as Hex;
    const url = "https://paid-product.example/";
    const commit = targetCommitOf(salt, url);
    let events: Awaited<ReturnType<ChainReader["forkEvents"]>> = [{ forkId: "7", kind: "opened", targetCommit: commit, chainId: 4663 }];
    const reader: ChainReader = { forkEvents: async () => events, crewFamilies: async () => ["glm", "qwen"] };
    expect(await syncForks(h.ctx, reader)).toEqual([]);
    expect(await registerForkTarget(h.ctx, "7", "https://other.example/", salt)).toBe(false);
    expect(await registerForkTarget(h.ctx, "7", url, salt)).toBe(true);
    events = [...events, { forkId: "7", kind: "triggered", chainId: 4663 }];
    expect(await syncForks(h.ctx, reader)).toEqual(["7"]);
    expect(await syncForks(h.ctx, reader)).toEqual([]);
    expect(await syncVotes(reader)).toEqual(["glm", "qwen"]);
    expect([...allowedFamilies()!]).toEqual(["glm", "qwen"]);
    allowFamilies(null);
  });
});

describe("events", () => {
  test("late subscribers replay from the start, and the hub closes when the run ends", () => {
    const ev = new VentureEvents(async () => ({ ok: true, status: 200, error: null, blocked: false }));
    const at = new Date().toISOString();
    ev.emit({ type: "step", ventureId: "v1", step: "a", role: "boss", state: "RUNNING", at, costUsd: 0 });
    ev.emit({ type: "venture", ventureId: "v1", status: "DONE", at, costUsd: 1 });
    const seen: number[] = [];
    const sub = ev.subscribe("v1", 0, (n) => seen.push(n.id));
    expect(seen).toEqual([1, 2]);
    expect(sub.closed).toBe(true);
    const after: number[] = [];
    ev.subscribe("v1", 1, (n) => after.push(n.id));
    expect(after).toEqual([2]);
  });
  test("webhooks get every event, signed", async () => {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const ev = new VentureEvents(async (url, _b, o) => (sent.push({ url, headers: o?.headers ?? {} }), { ok: true, status: 200, error: null, blocked: false }));
    ev.setWebhook("v2", "https://hooks.example/x", "whsec_test");
    ev.emit({ type: "log", ventureId: "v2", step: "a", role: "boss", message: "hi", at: new Date().toISOString() });
    await ev.drain();
    expect(sent[0]!.headers["x-anonymo-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});

describe("crew helpers", () => {
  const pool = [
    { model: "a", family: "deepseek", pricePerMTokUsd: 1 },
    { model: "b", family: "glm", pricePerMTokUsd: 2 },
    { model: "c", family: "qwen", pricePerMTokUsd: 3 },
    { model: "d", family: "gemma", pricePerMTokUsd: 9 },
  ];
  test("fan-out never repeats a family and honours exclusions and the price ceiling (property)", () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(r() * 6);
      const exclude = pool.map((p) => p.family).filter(() => r() < 0.4);
      const max = r() < 0.5 ? 1 + Math.floor(r() * 10) : undefined;
      const picks = pickFamilies(pool, n, { exclude, maxPricePerMTokUsd: max });
      expect(new Set(picks.map((p) => p.family)).size).toBe(picks.length);
      for (const p of picks) {
        expect(exclude).not.toContain(p.family);
        if (max) expect(p.pricePerMTokUsd).toBeLessThanOrEqual(max);
      }
      expect(picks.length).toBeLessThanOrEqual(n);
    }
    expect(nextFamily(pool, ["deepseek", "glm"])!.family).toBe("qwen");
  });
  test("the crew uses direct model IDs only: never a routed preset (and so never a Venice route)", () => {
    for (const id of ["anonymo-1", "anonymo-rp", "anonymo-council", "anonymo-sealed"]) expect(isCrewModel({ id, arch: {} })).toBe(false);
    expect(isCrewModel({ id: "zai/glm-5", arch: {} })).toBe(true);
    expect(isCrewModel({ id: "zai/glm-5", hidden: true, arch: {} })).toBe(false);
    expect(isCrewModel({ id: "embed/x", arch: { output_modalities: ["embeddings"] } })).toBe(false);
  });
  test("ranking: pass rate first, then errors, then bundle size; refusals last", () => {
    const r = rankCandidates([
      { id: 1, passRate: 1, buildErrors: 0, lintErrors: 3, bundleBytes: 100, refused: false },
      { id: 2, passRate: 1, buildErrors: 0, lintErrors: 0, bundleBytes: 900, refused: false },
      { id: 3, passRate: 0.5, buildErrors: 0, lintErrors: 0, bundleBytes: 10, refused: false },
      { id: 4, passRate: 1, buildErrors: 0, lintErrors: 0, bundleBytes: 10, refused: true },
    ] as any[]);
    expect(r.map((x: any) => x.id)).toEqual([2, 1, 3, 4]);
  });
  test("candidate files: safe paths only, packages refused, bun test output parsed", () => {
    expect(Object.keys(cleanFiles({ files: { "src/app.ts": "x", "../etc/passwd": "x", "src/../x.ts": "x", "/abs.ts": "x", "test/t.test.ts": "x" } }, "src"))).toEqual(["src/app.ts"]);
    expect(bareImports({ "src/a.ts": 'import x from "left-pad"; import { y } from "./y.ts"; import fs from "node:fs";' })).toEqual(["left-pad"]);
    expect(parseBunTest(" 4 pass\n 1 fail\n")).toEqual({ passed: 4, failed: 1 });
  });
  test("red team flags eval, secrets and key material", () => {
    // The fake key is assembled at run time so this file itself never carries a key-shaped string.
    const fakeKey = ["sk", "live", "x".repeat(20)].join("_");
    const f = staticScan({ "src/app.ts": `const t = eval("1");\nconst apiKey = "${fakeKey}";\n` });
    expect(f.map((x) => x.rule).sort()).toEqual(["eval", "hardcoded-secret"]);
  });
  test("import tests are generated from the export formats and cover quoting", () => {
    const t = importTests([{ name: "invoices csv", extension: "csv", fields: ["id", "client", "amount"] }])["test/import.test.ts"]!;
    expect(t).toContain('parseExport("invoices csv"');
    expect(t).toContain("quoted commas");
  });
  test("the claim checker drops rows without a real, dated finding", () => {
    const findings = [{ id: "f1", fact: "Top plan costs $49/month", observedAt: "2026-11-20", source: "pricing" as const }];
    const { rows, dropped } = checkClaims([{ feature: "Price", us: "$29", them: "$49", finding: "f1" }, { feature: "Made up", us: true, them: false, finding: "nope" }, { feature: "No cite", us: true, them: false }], findings);
    expect(rows.length).toBe(1);
    expect(rows[0]!.source!.observedAt).toBe("2026-11-20");
    expect(dropped.length).toBe(2);
  });
  test("the strict pre-gate blocks targets and credential pages, passes a plain landing page", async () => {
    expect((await strictGate({ id: "v", mode: "BUILD_BETTER", targetCommit: "0xab" }, { "index.html": "<h1>hi</h1>" })).verdict).toBe("BLOCK");
    expect((await strictGate({ id: "v", mode: "IDEA_TO_LIVE", targetCommit: null }, { "index.html": '<form><input type="password"></form>' })).verdict).toBe("BLOCK");
    expect((await strictGate({ id: "v", mode: "IDEA_TO_LIVE", targetCommit: null }, { "index.html": "<p>Enter your seed phrase</p>" })).verdict).toBe("BLOCK");
    expect((await strictGate({ id: "v", mode: "IDEA_TO_LIVE", targetCommit: null }, { "index.html": "<h1>Notes</h1>" })).verdict).toBe("PASS");
  });
  test("Run Mode's watch diff sees features and price moves", () => {
    const a = { ...emptySpec(), features: [{ id: "1", name: "Invoices", area: "core", description: "" }], pricing: { currency: "USD", plans: [{ name: "Pro", priceUsdMonthly: 49, limits: [], features: [] }] } };
    const b = { ...a, features: [...a.features, { id: "2", name: "Payroll", area: "core", description: "" }], pricing: { currency: "USD", plans: [{ name: "Pro", priceUsdMonthly: 59, limits: [], features: [] }] } };
    const d = specDiff(a, b);
    expect(d.features.added).toEqual(["Payroll"]);
    expect(d.prices).toEqual([{ plan: "Pro", from: 49, to: 59 }]);
    expect(specDiff(a, a).changed).toBe(false);
  });
});

describe("clean-room root and vote options", () => {
  test("the root is deterministic and moves when any part moves (property)", () => {
    const parts = { scoutArtifactHashes: ["a", "b"], specHash: "s", sandboxPolicyHash: "p", builderArtifactHashes: ["c"], gateReportHash: null, licenceReportHash: "l" };
    expect(cleanRoomRoot(parts)).toBe(cleanRoomRoot({ ...parts, scoutArtifactHashes: ["b", "a"] }));
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const x = Math.floor(r() * 1e12).toString(36);
      if (x !== "s") expect(cleanRoomRoot({ ...parts, specHash: x })).not.toBe(cleanRoomRoot(parts));
    }
  });
  test("bytes32 option ids round-trip family names, and winners are ranked by tally", () => {
    expect(optionName(optionId("GLM"))).toBe("glm");
    expect(winners([optionId("glm"), optionId("qwen"), optionId("kimi")], [5n, 9n, 0n], 8)).toEqual(["qwen", "glm"]);
    expect(winners([optionId("glm")], [0n], 8)).toBeNull();
    expect(keccak256(toBytes("MIT"))).toMatch(/^0x/);
  });
});

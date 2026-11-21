// End to end: Anonymo Ventures over HTTP against mock providers (Ventures Backend PART 13 acceptance 3, 8 and the M2
// "Idea to Live end to end; repo export"). The crew's model calls go through the real chat endpoint with the run's
// crew key; builders run in real local sandboxes (bun test inside); tests pick the winner.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { accounts, keys, ledger } from "../../src/db/schema.ts";
import { venturesRuntime } from "../../src/anonymo/ventures/runtime.ts";
import { ventureRunMode, ventures } from "../../src/anonymo/ventures/store/schema.ts";
import { runModeTick } from "../../src/anonymo/ventures/runmode.ts";
import { lintCopy } from "../../src/anonymo/ventures/copy.ts";
import { anonymoKeys } from "../../src/anonymo/deposits/schema.ts";
import { startRouter, type Harness } from "../helpers.ts";
import { CREW_PROVIDERS } from "./fixtures/crew-mock.ts";

type H = Awaited<ReturnType<typeof startRouter>>;
let h: H;
let auth: Record<string, string>;
let keyHash: string;
const repoRoot = mkdtempSync(join(tmpdir(), "ventures-e2e-"));

const balance = async (hash: string) => {
  const [k] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, hash));
  const [a] = await h.ctx.db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, k!.accountId));
  return a!.balance;
};

async function waitFor(id: string, done = ["DONE", "FAILED", "CAPPED", "CANCELLED"], ms = 120_000, headers: Record<string, string> = auth) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await h.request(`/v1/ventures/${id}`, { headers });
    const j = (await r.json()) as any;
    if (done.includes(j.data.status)) return j.data;
    await Bun.sleep(150);
  }
  throw new Error("venture did not finish");
}

beforeAll(async () => {
  h = await startRouter({ env: { ANONYMO_FEATURE_VENTURES: "true" }, providers: CREW_PROVIDERS });
  venturesRuntime(h.app as never, h.ctx, { services: { repoRoot } });
  const k = await h.fundedKey(300n);
  auth = k.auth;
  keyHash = k.hash;
});
afterAll(async () => {
  await h.close();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("Idea to Live, end to end", () => {
  let v: any;
  let before: bigint;

  test("a run starts, charges the fixed price once, and finishes", async () => {
    before = await balance(keyHash);
    const r = await h.request("/v1/ventures", { method: "POST", headers: auth, json: { mode: "IDEA_TO_LIVE", brief: "A notes app for small teams with an API first." } });
    expect(r.status).toBe(201);
    const created = ((await r.json()) as any).data;
    expect(created.price_usd).toBe(79);
    expect(created.steps.map((s: any) => s.key)).toContain("build");
    v = await waitFor(created.id);
    expect(v.error).toBeNull();
    expect(v.status).toBe("DONE");
    // Exactly the price left the owner's account; everything else the crew did was billed inside it.
    expect(before - (await balance(keyHash))).toBe(79n * 10n ** 12n);
  }, 180_000);

  test("every step ran, and the crew's calls carry receipts", () => {
    for (const s of v.steps) expect(s.state).toBe("DONE");
    expect(v.steps.flatMap((s: any) => s.receipts).length).toBeGreaterThan(5);
  });

  test("builders came from distinct families, never the tester's, and the highest pass rate won", () => {
    const build = v.steps.find((s: any) => s.key === "build");
    const fams = build.candidates.map((c: any) => c.family);
    expect(new Set(fams).size).toBe(fams.length);
    expect(fams.length).toBe(3);
    expect(fams).not.toContain("deepseek"); // the tester's family
    const buggy = build.candidates.find((c: any) => c.family === "qwen");
    expect(buggy.pass_rate).toBeLessThan(1);
    const winner = build.candidates.find((c: any) => c.chosen);
    expect(winner.pass_rate).toBe(1);
    expect(winner.family).not.toBe("qwen");
  });

  test("the landing page and ad kit obey the copy rules", async () => {
    const arts = ((await (await h.request(`/v1/ventures/${v.id}/artifacts`, { headers: auth })).json()) as any).data;
    const landing = arts.find((a: any) => a.name === "landing");
    const html = await (await h.request(`/v1/ventures/${v.id}/artifacts/${landing.sha256}`, { headers: auth })).text();
    expect(html).toContain("Notewise");
    expect(lintCopy(html.replace(/<[^>]+>/g, " "))).toEqual([]);
    const ads = arts.find((a: any) => a.name === "adkit");
    const kit = await (await h.request(`/v1/ventures/${v.id}/artifacts/${ads.sha256}`, { headers: auth })).text();
    expect(kit).not.toContain("bet you");
  });

  test("the repo exports as a tarball with the code, tests, site and licence", async () => {
    const r = await h.request(`/v1/ventures/${v.id}/export`, { headers: auth });
    expect(r.status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "ventures-untar-"));
    await Bun.write(join(dir, "repo.tar.gz"), new Uint8Array(await r.arrayBuffer()));
    const list = Bun.spawnSync(["tar", "-tzf", join(dir, "repo.tar.gz")]).stdout.toString();
    for (const f of ["src/app.ts", "test/app.test.ts", "site/index.html", "LICENSE", "NOTICE", "README.md", "docs/plan.json", "marketing/ad-kit.json"]) expect(list).toContain(`${v.id}/${f}`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the receipt lists every candidate route and a clean-room root", async () => {
    const r = ((await (await h.request(`/v1/ventures/${v.id}/receipt`, { headers: auth })).json()) as any).data;
    expect(r.candidates.length).toBe(3);
    expect(r.clean_room.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.clean_room.scoutArtifactHashes).toEqual([]);
  });

  test("the crew key spends nothing past the run, and the leftover settled to the house", async () => {
    const [row] = await h.ctx.db.select().from(ventures).where(eq(ventures.id, v.id));
    expect(await balance(row!.crewKeyHash!)).toBe(0n);
  });

  test("events replay over SSE after the run ended", async () => {
    const r = await h.request(`/v1/ventures/${v.id}/events`, { headers: auth });
    const text = await r.text();
    expect(text).toContain("event: step");
    expect(text).toContain('"status":"DONE"');
    expect(text).toContain("event: end");
  });

  test("another key can't see the run", async () => {
    const other = await h.fundedKey(1n);
    expect((await h.request(`/v1/ventures/${v.id}`, { headers: other.auth })).status).toBe(404);
  });

  describe("Run Mode (acceptance 8): stops at the daily cap; the next tick waits for the next day", () => {
    let runId: string;
    test("switch on", async () => {
      const r = await h.request(`/v1/ventures/${v.id}/run-mode`, { method: "POST", headers: auth, json: { daily_cap_usd: 6, tasks: ["improve", "ads"] } });
      expect(r.status).toBe(201);
      runId = ((await r.json()) as any).data.id;
    });
    test("ticks run until the hours or the cap are used, then wait for tomorrow", async () => {
      const rt = venturesRuntime(h.app as never, h.ctx);
      const day = new Date("2026-12-01T00:30:00Z");
      const b0 = await balance(keyHash);
      const first = await runModeTick(rt.deps, day);
      expect(first.find((o) => o.ventureId === runId)?.ran).toBe(true);
      // The day's fee plus the crew budget (cap − fee) left the owner once.
      expect(b0 - (await balance(keyHash))).toBe(6n * 10n ** 12n);
      // Crew tier: 2 hours a day. Second tick an hour later runs, the third waits for the next UTC day.
      const second = await runModeTick(rt.deps, new Date(day.getTime() + 3_600_000));
      expect(second.find((o) => o.ventureId === runId)?.ran).toBe(true);
      const [rm] = await h.ctx.db.select().from(ventureRunMode).where(eq(ventureRunMode.ventureId, runId));
      expect(rm!.nextTickAt!.toISOString()).toBe("2026-12-02T00:00:00.000Z");
      expect(rm!.spentToday).toBeLessThanOrEqual(rm!.dailyCap);
      const third = await runModeTick(rt.deps, new Date(day.getTime() + 2 * 3_600_000));
      expect(third.find((o) => o.ventureId === runId)).toBeUndefined();
      const tomorrow = await runModeTick(rt.deps, new Date("2026-12-02T00:00:00Z"));
      expect(tomorrow.find((o) => o.ventureId === runId)?.ran).toBe(true);
    }, 60_000);
    test("a tick that would pass the cap does not start", async () => {
      await h.ctx.db.update(ventureRunMode).set({ spentToday: 6n * 10n ** 12n, day: "2026-12-03", nextTickAt: new Date("2026-12-03T05:00:00Z") }).where(eq(ventureRunMode.ventureId, runId));
      const rt = venturesRuntime(h.app as never, h.ctx);
      const out = await runModeTick(rt.deps, new Date("2026-12-03T05:00:00Z"));
      const o = out.find((x) => x.ventureId === runId)!;
      expect(o.ran).toBe(false);
      expect(o.reason).toBe("daily_cap_reached");
      expect(o.nextTickAt).toBe("2026-12-04T00:00:00.000Z");
    });
    test("switching off forgets the target and stops ticks", async () => {
      expect((await h.request(`/v1/ventures/${runId}/run-mode`, { method: "DELETE", headers: auth })).status).toBe(200);
      const [rm] = await h.ctx.db.select().from(ventureRunMode).where(eq(ventureRunMode.ventureId, runId));
      expect(rm!.enabled).toBe(false);
      expect(rm!.targetEnc).toBeNull();
    });
  });

  test("a recipe saved from the run replays its pipeline and pays the creator", async () => {
    const save = await h.request(`/v1/ventures/${v.id}/recipe`, { method: "POST", headers: auth, json: { title: "Notes MVP in an hour", summary: "API + landing page", price_usd: 0 } });
    expect(save.status).toBe(201);
    const { id } = ((await save.json()) as any).data;
    const list = ((await (await h.request("/v1/recipes")).json()) as any).data;
    expect(list.map((r: any) => r.id)).toContain(id);
    // Selling needs Gang: the fallback tier (crew) can publish free recipes only.
    const paid = await h.request(`/v1/ventures/${v.id}/recipe`, { method: "POST", headers: auth, json: { title: "Paid copy", price_usd: 5 } });
    expect(paid.status).toBe(403);
  });
});

describe("guards", () => {
  test("the owner key's daily cap below the price refuses the run before anything moves", async () => {
    const k = await h.fundedKey(200n);
    await h.ctx.db.insert(anonymoKeys).values({ keyHash: k.hash, dailyCap: 10n * 10n ** 12n }).onConflictDoUpdate({ target: anonymoKeys.keyHash, set: { dailyCap: 10n * 10n ** 12n } });
    const b0 = await balance(k.hash);
    const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "Another notes app idea for teams." } });
    expect(r.status).toBe(402);
    expect(await balance(k.hash)).toBe(b0);
  });

  test("too little balance is a 402 and nothing is created", async () => {
    const k = await h.fundedKey(10n);
    const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "A notes app idea for teams." } });
    expect(r.status).toBe(402);
    expect((await h.ctx.db.select().from(ventures).where(eq(ventures.keyHash, k.hash))).length).toBe(0);
  });

  test("Build Better refuses private or loopback targets", async () => {
    const r = await h.request("/v1/ventures", { method: "POST", headers: auth, json: { mode: "BUILD_BETTER", target_url: "http://127.0.0.1:9/" } });
    expect(r.status).toBe(400);
  });

  test("Dupe Drop is not built yet", async () => {
    expect((await h.request("/v1/ventures", { method: "POST", headers: auth, json: { mode: "DUPE_DROP", brief: "x" } })).status).toBe(501);
  });

  test("pricing is public", async () => {
    const j = ((await (await h.request("/v1/ventures/pricing")).json()) as any).data;
    expect(j.runs.find((r: any) => r.mode === "BUILD_BETTER").usd).toBe(149);
    expect(j.runs.find((r: any) => r.mode === "TAKEOVER").nymoUsdEquivalent).toBe(36.75);
  });

  test("model anonymo-swarm starts a run from the chat endpoint", async () => {
    const r = await h.request("/v1/chat/completions", { method: "POST", headers: auth, json: { model: "anonymo-swarm", messages: [{ role: "user", content: "A tiny notes API with a landing page." }] } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.object).toBe("chat.completion");
    expect(j.venture.id).toMatch(/^v_/);
    await waitFor(j.venture.id);
  }, 180_000);

  test("other models still reach the normal chat route", async () => {
    const r = await h.request("/v1/chat/completions", { method: "POST", headers: auth, json: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hello" }], max_tokens: 20 } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).object).toBe("chat.completion");
  });
});

void ledger;
void ({} as Harness);

describe("floor gate and refunds (Law 7)", () => {
  test("a brief the floor gate blocks is a 451 before anything is charged", async () => {
    const k = await h.fundedKey(200n);
    const b0 = await balance(k.hash);
    const real = h.ctx.anonymo.floor;
    h.ctx.anonymo.floor = { check: async (i) => (i.text.includes("forbidden-sample") ? { ok: false, category: "cbrn" } : { ok: true }) };
    try {
      const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "forbidden-sample idea that the gate blocks" } });
      expect(r.status).toBe(451);
      expect(await balance(k.hash)).toBe(b0);
    } finally {
      h.ctx.anonymo.floor = real;
    }
  });

  test("a run that fails gives its unused budget back to the owner", async () => {
    const k = await h.fundedKey(200n);
    const b0 = await balance(k.hash);
    const rt = venturesRuntime(h.app as never, h.ctx);
    const saved = rt.deps.handlers["strategist.research"]!;
    rt.deps.handlers["strategist.research"] = async () => {
      throw new Error("sample failure");
    };
    try {
      const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "A notes app that fails on purpose." } });
      const id = ((await r.json()) as any).data.id;
      const t0 = Date.now();
      let st = "";
      while (Date.now() - t0 < 30_000) {
        const [row] = await h.ctx.db.select({ s: ventures.status }).from(ventures).where(eq(ventures.id, id));
        st = row!.s;
        if (st === "FAILED") break;
        await Bun.sleep(100);
      }
      await Bun.sleep(200);
      expect(st).toBe("FAILED");
      // Nothing was spent before the failure, so the whole price came back.
      expect(await balance(k.hash)).toBe(b0);
    } finally {
      rt.deps.handlers["strategist.research"] = saved;
    }
  });
});

describe("Build Fuel credits and Checkout orders (item 9, gateway side)", () => {
  const WALLET = "0x" + "cd".repeat(20);
  test("today's Build Fuel credits pay part of the price and never touch the balance; they run out", async () => {
    const { setFuelReader } = await import("../../src/anonymo/ventures/fuel.ts");
    const k = await h.fundedKey(300n);
    await h.ctx.db.insert(anonymoKeys).values({ keyHash: k.hash, wallet: WALLET }).onConflictDoUpdate({ target: anonymoKeys.keyHash, set: { wallet: WALLET } });
    setFuelReader(async () => 30_000_000n); // 30 USDG of credits a day; the per-wallet cap is 25
    const { FUEL_POOL_ACCOUNT } = await import("../../src/anonymo/ventures/money.ts");
    const { ensureAccount, post } = await import("../../src/ledger/ledger.ts");
    await h.ctx.db.transaction(async (tx) => {
      await ensureAccount(tx, FUEL_POOL_ACCOUNT, "house");
      await post(tx, { accountId: FUEL_POOL_ACCOUNT, amount: 25n * 10n ** 12n, kind: "test_fill", ref: "test:crew-fuel-pool" });
    });
    try {
      const b0 = await balance(k.hash);
      const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "A notes app paid partly with fuel." } });
      const d = ((await r.json()) as any).data;
      expect(d.paid).toEqual({ order_usd: 0, fuel_usd: 25, balance_usd: 54 });
      expect(b0 - (await balance(k.hash))).toBe(54n * 10n ** 12n);
      const r2 = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "A second notes app, same day." } });
      expect(((await r2.json()) as any).data.paid.fuel_usd).toBe(0);
      await waitFor(d.id, undefined, undefined, k.auth);
      await waitFor(((await r2.json().catch(() => ({ data: { id: d.id } }))) as any).data?.id ?? d.id, undefined, undefined, k.auth).catch(() => undefined);
    } finally {
      setFuelReader(null);
    }
  }, 180_000);

  test("a run paid on chain through Checkout costs the balance nothing, once, and only for its payer and mode", async () => {
    const { syncOrders, skuOf } = await import("../../src/anonymo/ventures/fuel.ts");
    const k = await h.fundedKey(5n);
    await h.ctx.db.insert(anonymoKeys).values({ keyHash: k.hash, wallet: WALLET }).onConflictDoUpdate({ target: anonymoKeys.keyHash, set: { wallet: WALLET } });
    const orderId = ("0x" + "0f".repeat(32)) as `0x${string}`;
    const n = await syncOrders(h.ctx, async () => [{ orderId, sku: skuOf("IDEA_TO_LIVE"), payer: WALLET as `0x${string}`, qty: 1n, amount: 59_250_000n, currency: 1, ventureId: ("0x" + "00".repeat(32)) as `0x${string}`, chainId: 4663 }]);
    expect(n).toBe(1);
    const b0 = await balance(k.hash);
    const wrongMode = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "FORK_FLIP", repo_url: "https://example.com/x.git", order_id: orderId } });
    expect(wrongMode.status).toBe(402);
    const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "A notes app paid in NYMO on chain.", order_id: orderId } });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).data.paid.order_usd).toBe(79);
    expect(await balance(k.hash)).toBe(b0);
    const again = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "Trying to reuse the order.", order_id: orderId } });
    expect(again.status).toBe(402);
    const other = await h.fundedKey(5n);
    expect((await h.request("/v1/ventures", { method: "POST", headers: other.auth, json: { mode: "IDEA_TO_LIVE", brief: "Someone else's order.", order_id: orderId } })).status).toBe(402);
  });
});

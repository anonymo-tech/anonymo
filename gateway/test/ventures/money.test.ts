// No-loss rules for Ventures money (pricing.ts "no-loss rules"): whatever happens in a run, the cash it brought in
// covers what it cost. The crew spends at most 80% of the price (refused attempts included); a run that doesn't finish
// refunds only cash the owner paid, minus what refused attempts cost; Build Fuel is paid from a pool that finished
// runs fill; underpaid Checkout orders and underfunded forks start nothing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accounts, keys } from "../../src/db/schema.ts";
import { ensureAccount, post } from "../../src/ledger/ledger.ts";
import { anonymoKeys } from "../../src/anonymo/deposits/schema.ts";
import { venturesRuntime, HANDLERS } from "../../src/anonymo/ventures/runtime.ts";
import { FUEL_POOL_ACCOUNT, HOUSE_ACCOUNT } from "../../src/anonymo/ventures/money.ts";
import { crewBudgetUsd } from "../../src/anonymo/ventures/pricing.ts";
import { refusedCost } from "../../src/anonymo/ventures/crew/caller.ts";
import { setFuelReader, skuOf, syncOrders } from "../../src/anonymo/ventures/fuel.ts";
import { ventureForks, ventures } from "../../src/anonymo/ventures/store/schema.ts";
import { scriptedLlm, type CrewReply } from "../../src/anonymo/ventures/llm.ts";
import type { RoleHandler } from "../../src/anonymo/ventures/orchestrator.ts";
import { startRouter } from "../helpers.ts";
import { CREW_PROVIDERS } from "./fixtures/crew-mock.ts";

type H = Awaited<ReturnType<typeof startRouter>>;
let h: H;
const P = 10n ** 12n; // pico per USD
const WALLET = "0x" + "ef".repeat(20);

const balanceOf = async (accountId: string) => (await h.ctx.db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, accountId)))[0]?.b ?? 0n;
const keyBalance = async (hash: string) => balanceOf((await h.ctx.db.select({ a: keys.accountId }).from(keys).where(eq(keys.keyHash, hash)))[0]!.a);

async function finish(id: string, auth: Record<string, string>) {
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const j = (await (await h.request(`/v1/ventures/${id}`, { headers: auth })).json()) as any;
    if (["DONE", "FAILED", "CAPPED", "CANCELLED"].includes(j.data.status)) return j.data;
    await Bun.sleep(50);
  }
  throw new Error("run did not end");
}

/** Every task replaced by `handler`, and the crew's model calls by `llm`, for one block. */
async function withCrew<T>(handler: RoleHandler, reply: () => Partial<CrewReply>, fn: () => Promise<T>): Promise<T> {
  const rt = venturesRuntime(h.app as never, h.ctx);
  const saved = { ...rt.deps.handlers };
  const savedLlm = rt.deps.llmFor;
  for (const k of Object.keys(HANDLERS)) rt.deps.handlers[k] = handler;
  rt.deps.llmFor = () => scriptedLlm([{ when: () => true, reply: () => ({ text: "{}", ...reply() }) }]);
  try {
    return await fn();
  } finally {
    Object.assign(rt.deps.handlers, saved);
    rt.deps.llmFor = savedLlm;
  }
}

/** A handler that keeps calling models until its step's budget stops it. */
const spender: RoleHandler = async (s) => {
  for (let i = 0; i < 1000; i++) await s.llm.call({ model: "x", messages: [{ role: "user", content: "go" }] });
};

beforeAll(async () => {
  h = await startRouter({ env: { ANONYMO_FEATURE_VENTURES: "true" }, providers: CREW_PROVIDERS });
  venturesRuntime(h.app as never, h.ctx);
});
afterAll(async () => h.close());

describe("the crew never spends past 80% of the price", () => {
  test("a crew that spends without stopping is cut off; the cash kept covers every dollar it spent", async () => {
    const k = await h.fundedKey(200n);
    const b0 = await keyBalance(k.hash);
    const CALL = 0.5;
    const v = await withCrew(spender, () => ({ costUsd: CALL }), async () => {
      const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "A crew that spends without stopping." } });
      return finish(((await r.json()) as any).data.id, k.auth);
    });
    const kept = b0 - (await keyBalance(k.hash));
    const budget = crewBudgetUsd(79);
    // At most one call per step that was already running when the budget ran out (8 steps can run side by side).
    expect(v.cost_usd).toBeLessThanOrEqual(budget + 8 * CALL);
    // The money that stayed with us covers what the crew spent: no loss.
    expect(Number(kept) / 1e12).toBeGreaterThanOrEqual(v.cost_usd - 1e-9);
  }, 60_000);

  test("refused attempts count against the budget even though nobody is billed for them", async () => {
    const k = await h.fundedKey(200n);
    const b0 = await keyBalance(k.hash);
    const v = await withCrew(spender, () => ({ costUsd: 0, refused: true, refusedCostUsd: 1 }), async () => {
      const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "Every call refuses but still costs us." } });
      return finish(((await r.json()) as any).data.id, k.auth);
    });
    // The refusals were counted: the first step ran into its own budget (8% of the crew budget) and stopped the run.
    const research = v.steps.find((x: any) => x.key === "research");
    expect(research.state).toBe("FAILED");
    expect(research.cost_usd).toBeGreaterThanOrEqual(research.cap_usd);
    expect(v.cost_usd).toBeLessThanOrEqual(crewBudgetUsd(79) + 8);
    // The run did not finish, so the owner is refunded, but not the part that paid the providers for the refusals.
    const kept = Number(b0 - (await keyBalance(k.hash))) / 1e12;
    expect(kept).toBeGreaterThanOrEqual(v.cost_usd - 1e-9);
  }, 60_000);

  test("refusedCost prices the refused routes' tokens", () => {
    const receipt = { routes: [{ status: "refused", family: "glm", tokens: { in: 1_000_000, out: 0 } }, { status: "ok", family: "qwen", tokens: { in: 5, out: 5 } }] } as any;
    expect(refusedCost(receipt, (f) => (f === "glm" ? 2 : 99))).toBe(2);
  });
});

describe("a finished run keeps 20%: 5% of the price funds Build Fuel", () => {
  test("cheap finished run: the owner pays the price once, the fuel pool gets 5%, the house the rest", async () => {
    const k = await h.fundedKey(200n);
    const pool0 = await balanceOf(FUEL_POOL_ACCOUNT);
    const house0 = await balanceOf(HOUSE_ACCOUNT);
    const done: RoleHandler = async (s) => {
      await s.llm.call({ model: "x", messages: [{ role: "user", content: "one" }] });
    };
    const v = await withCrew(done, () => ({ costUsd: 0.01 }), async () => {
      const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "A run that finishes cheaply." } });
      return finish(((await r.json()) as any).data.id, k.auth);
    });
    expect(v.status).toBe("DONE");
    expect((await balanceOf(FUEL_POOL_ACCOUNT)) - pool0).toBe((79n * P * 500n) / 10_000n);
    expect((await balanceOf(HOUSE_ACCOUNT)) - house0).toBeGreaterThan(0n);
  }, 60_000);
});

describe("Build Fuel is backed and capped", () => {
  test("with an empty pool, fuel pays nothing; with a funded pool, at most the per-wallet daily cap", async () => {
    const k = await h.fundedKey(300n);
    await h.ctx.db.insert(anonymoKeys).values({ keyHash: k.hash, wallet: WALLET }).onConflictDoUpdate({ target: anonymoKeys.keyHash, set: { wallet: WALLET } });
    setFuelReader(async () => 1_000_000_000n); // a whale: $1,000 of credits a day
    try {
      // Drain the pool to zero first.
      const pool = await balanceOf(FUEL_POOL_ACCOUNT);
      await h.ctx.db.transaction(async (tx) => {
        await ensureAccount(tx, FUEL_POOL_ACCOUNT, "house");
        if (pool > 0n) await post(tx, { accountId: FUEL_POOL_ACCOUNT, amount: -pool, kind: "test_drain", ref: "test:drain-pool" });
      });
      const quiet: RoleHandler = async () => {};
      await withCrew(quiet, () => ({}), async () => {
        const r1 = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "Fuel with an empty pool." } });
        const d1 = ((await r1.json()) as any).data;
        expect(d1.paid.fuel_usd).toBe(0);
        await finish(d1.id, k.auth);
        await h.ctx.db.transaction(async (tx) => post(tx, { accountId: FUEL_POOL_ACCOUNT, amount: 500n * P, kind: "test_fill", ref: "test:fill-pool" }));
        const r2 = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "Fuel with a full pool." } });
        const d2 = ((await r2.json()) as any).data;
        expect(d2.paid.fuel_usd).toBe(25); // VENTURES_FUEL_WALLET_DAILY_USD default
        await finish(d2.id, k.auth);
      });
    } finally {
      setFuelReader(null);
    }
  }, 60_000);

  test("a failed run paid partly with fuel refunds only the cash part", async () => {
    const k = await h.fundedKey(300n);
    const w2 = "0x" + "a1".repeat(20);
    await h.ctx.db.insert(anonymoKeys).values({ keyHash: k.hash, wallet: w2 }).onConflictDoUpdate({ target: anonymoKeys.keyHash, set: { wallet: w2 } });
    await h.ctx.db.transaction(async (tx) => post(tx, { accountId: FUEL_POOL_ACCOUNT, amount: 100n * P, kind: "test_fill", ref: "test:fill-pool-2" }));
    setFuelReader(async () => 20_000_000n); // $20 of credits
    try {
      const b0 = await keyBalance(k.hash);
      const fails: RoleHandler = async () => {
        throw new Error("sample failure");
      };
      const v = await withCrew(fails, () => ({}), async () => {
        const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "Fails after fuel paid part." } });
        const d = ((await r.json()) as any).data;
        expect(d.paid.fuel_usd).toBe(20);
        return finish(d.id, k.auth);
      });
      expect(v.status).toBe("FAILED");
      // $59 cash came back, the $20 of credits did not turn into withdrawable balance.
      expect(await keyBalance(k.hash)).toBe(b0);
    } finally {
      setFuelReader(null);
    }
  }, 60_000);
});

describe("Checkout orders and People's Forks start nothing at a loss", () => {
  test("a USDG order that paid less than the price is refused", async () => {
    const k = await h.fundedKey(5n);
    const w3 = "0x" + "b2".repeat(20);
    await h.ctx.db.insert(anonymoKeys).values({ keyHash: k.hash, wallet: w3 }).onConflictDoUpdate({ target: anonymoKeys.keyHash, set: { wallet: w3 } });
    const orderId = ("0x" + "1e".repeat(32)) as `0x${string}`;
    await syncOrders(h.ctx, async () => [{ orderId, sku: skuOf("IDEA_TO_LIVE"), payer: w3 as `0x${string}`, qty: 1n, amount: 10_000_000n, currency: 0, ventureId: ("0x" + "00".repeat(32)) as `0x${string}`, chainId: 4663 }]);
    const r = await h.request("/v1/ventures", { method: "POST", headers: k.auth, json: { mode: "IDEA_TO_LIVE", brief: "Paid $10 for a $79 run.", order_id: orderId } });
    expect(r.status).toBe(402);
  });

  test("a fork whose USDG doesn't cover the build is marked underfunded and never built", async () => {
    const { startForkBuild } = await import("../../src/anonymo/ventures/routes.ts");
    const rt = venturesRuntime(h.app as never, h.ctx);
    const { encrypt } = await import("../../src/lib/util.ts");
    await h.ctx.db.insert(ventureForks).values({ forkId: "900", chainId: 4663, targetCommit: "0x" + "77".repeat(32), status: "triggered", usdgRouted: 100_000_000n, targetEnc: encrypt(h.ctx.cfg.appSecret, "https://example.com/") });
    expect(await startForkBuild(rt, "900")).toBeNull();
    const [f] = await h.ctx.db.select().from(ventureForks).where(eq(ventureForks.forkId, "900"));
    expect(f!.status).toBe("underfunded");
    expect((await h.ctx.db.select().from(ventures).where(eq(ventures.keyHash, "fork:4663:900"))).length).toBe(0);
  });
});

// WS04: upstream tiers, model IDs, route score, failover, canaries and balance alarms, end to end through the router
// with mock upstreams seeded from the same YAML schema as config/upstreams.yaml (Backend §4, Overview §2-§4).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { offers, providers } from "../src/db/schema.ts";
import { HealthTracker } from "../src/services/health.ts";
import { runUpstreamCanaries } from "../src/services/canaries.ts";
import { anonymoBalanceChecks, runBalanceAlarms } from "../src/providers/balance.ts";
import { parseUpstreamsYaml, seedUpstreams } from "../src/providers/tiers.ts";
import { MOCK_UPSTREAMS, mockUpstreamsDoc, servedByOf, type MockUpstream } from "../src/routing/load-test.ts";
import { familyOf } from "../src/anonymo/models.ts";
import { stickyRoutes } from "../src/routing/sticky.ts";
import { anonymoOrder } from "../src/router/select.ts";
import type { MockBehaviour } from "../src/providers/mock.ts";

const KEYS = Object.keys(MOCK_UPSTREAMS) as MockUpstream[];
let h: Harness;
let auth: Record<string, string>;
let deadUrl: string;

const mock = (k: MockUpstream) => h.mocks[`mock-${k}`];
const set = (k: MockUpstream, cfg: { behaviour?: MockBehaviour; balanceUsd?: number }) => Object.assign(mock(k).cfg, cfg);
const reqs = (k: MockUpstream) => mock(k).stats.requests;
const resetHealth = () => {
  h.ctx.health = new HealthTracker(h.ctx.cfg.routing.outageWindowMs);
};

async function chat(model: string, extra: Record<string, unknown> = {}) {
  const res = await h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model, messages: [{ role: "user", content: "hello there" }], ...extra } });
  const text = await res.text();
  let content = "";
  if (extra.stream) content = text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))?.choices?.[0]?.delta?.content ?? "").join("");
  else content = res.status === 200 ? (JSON.parse(text).choices?.[0]?.message?.content ?? "") : "";
  return { status: res.status, servedBy: servedByOf(content), body: text };
}

beforeAll(async () => {
  h = await startRouter({
    providers: KEYS.map((k) => ({ id: `mock-${k}`, name: MOCK_UPSTREAMS[k], models: [], live: false, ...(k === "chutes" ? { tee: "dev" as const } : {}) })),
    env: { FIRST_TOKEN_TIMEOUT_MS: "400" },
  });
  // A port nothing listens on: a connection failure.
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  deadUrl = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  const urls = Object.fromEntries(KEYS.map((k) => [k, mock(k).url])) as Record<MockUpstream, string>;
  await seedUpstreams(h.ctx.db, mockUpstreamsDoc(urls, { timeoutMs: 1_500 }), { appSecret: h.ctx.cfg.appSecret, production: false, env: { MOCK_UPSTREAM_KEY: "mock-upstream-key" } });
  await h.ctx.catalog.refresh();
  auth = (await h.fundedKey(50n)).auth;
});
afterAll(async () => h?.close());
beforeEach(() => {
  for (const k of KEYS) set(k, { behaviour: "ok" });
  resetHealth();
});

describe("model IDs and the route record", () => {
  test("the four model IDs and the non-Venice direct IDs resolve; no Venice model is exposed under its own name", () => {
    for (const id of ["anonymo-1", "anonymo-rp", "anonymo-council", "anonymo-sealed", "dolphin-venice-24b", "deepseek-v4.1-flash-abliterated", "glm-5.2-abliterated"])
      expect(h.ctx.catalog.resolve(id)?.model.id).toBe(id);
    expect(h.ctx.catalog.resolve("venice-uncensored")).toBeNull();
    // The direct DeepSeek ID is served only by the self-hosted route, never by the Venice route of the same model.
    expect(h.ctx.catalog.offers("deepseek-v4.1-flash-abliterated").map((o) => o.providerId)).toEqual(["sh-deepseek-flash"]);
    expect(h.ctx.catalog.offers("anonymo-rp").every((o) => o.upstream === "selfhost")).toBe(true);
    expect(h.ctx.catalog.offers("anonymo-sealed").map((o) => o.providerId)).toEqual(["chutes-glm"]);
  });

  test("family, quant, weights hash, tier and upstream are persisted on every route", async () => {
    const [row] = await h.ctx.db.select().from(offers).where(and(eq(offers.modelId, "anonymo-1"), eq(offers.providerId, "sh-dolphin-24b")));
    expect(row).toMatchObject({ family: "mistral", quant: "fp8", weightsHash: "ab".repeat(32), tier: 1, upstream: "selfhost", upstreamId: "sh-mistral", qualityRank: 80, providerModelId: "dolphin-venice-24b" });
    const venice = h.ctx.catalog.offers("anonymo-1").find((o) => o.providerId === "venice-deepseek")!;
    expect(familyOf(venice)).toBe("deepseek");
    expect(venice.tier).toBe(0);
  });

  test("the provider registry re-sync keeps the route columns and the offers", async () => {
    const { runRegistry } = await import("../src/services/registry.ts");
    await runRegistry(h.ctx);
    const rows = await h.ctx.db.select().from(offers).where(eq(offers.providerId, "venice-uncensored"));
    expect(rows.map((r) => [r.modelId, r.status, r.family, r.tier]).sort()).toEqual([["anonymo-1", "live", "mistral", 0], ["anonymo-council", "live", "mistral", 0]]);
  });

  test("the production config file parses and keeps the product rules", () => {
    const doc = parseUpstreamsYaml(readFileSync(new URL("../config/upstreams.yaml", import.meta.url), "utf8"));
    expect(doc.upstreams.map((u) => u.tier).sort()).toEqual([0, 1, 1, 1, 1, 2, 2, 2, 3]);
    expect(doc.routes.filter((r) => r.upstream === "venice").every((r) => !r.direct_id)).toBe(true);
    for (const u of doc.upstreams.filter((x) => x.prepaid)) expect(u.balance).toBeDefined();
  });
});

describe("selection: T0 first, backups behind it", () => {
  test("anonymo-1 is answered by Venice (T0) while it is healthy", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await chat("anonymo-1");
      expect(r.status).toBe(200);
      expect(r.servedBy).toBe(MOCK_UPSTREAMS.venice);
    }
  });

  test("anonymo-rp is answered only by self-hosted routes", async () => {
    const r = await chat("anonymo-rp");
    expect(r.status).toBe(200);
    expect(r.servedBy).toBe(MOCK_UPSTREAMS.selfhostMistral);
  });

  test("Venice requests never carry Venice's own system prompt", async () => {
    await chat("anonymo-1");
    expect(mock("venice").stats.lastBody.venice_parameters).toEqual({ include_venice_system_prompt: false });
    await chat("anonymo-rp");
    expect(mock("selfhostMistral").stats.lastBody.venice_parameters).toBeUndefined();
  });

  test("a Venice route with a high recent error rate loses the T0 bonus and drops behind a healthy backup", async () => {
    for (const p of ["venice-uncensored", "venice-deepseek"])
      for (let i = 0; i < 3; i++) h.ctx.health.record({ modelId: "anonymo-1", providerId: p, ok: i === 0, errorKind: i === 0 ? null : "http_5xx", latencyMs: 300 });
    // Not an outage (successes interleave with failures in the window), but the score now prefers the backup.
    h.ctx.health.record({ modelId: "anonymo-1", providerId: "venice-uncensored", ok: true, latencyMs: 300 });
    h.ctx.health.record({ modelId: "anonymo-1", providerId: "venice-deepseek", ok: true, latencyMs: 300 });
    const before = reqs("venice");
    const r = await chat("anonymo-1");
    expect(r.status).toBe(200);
    expect(r.servedBy).toBe(MOCK_UPSTREAMS.selfhostDeepseek);
    expect(reqs("venice")).toBe(before);
  });
});

describe("pre-first-token failover from Venice (Backend §4 step 3)", () => {
  const cases: [string, MockBehaviour | "dead"][] = [
    ["402 payment required", "pay402"],
    ["429 rate limited", "rate429"],
    ["500", "error500"],
    ["503", "error503"],
    ["first-byte timeout", "hang"],
    ["connection failure", "dead"],
  ];
  for (const stream of [false, true])
    for (const [name, behaviour] of cases)
      test(`${name}${stream ? " (stream)" : ""}: Venice is tried first, then the request moves to a backup and succeeds`, async () => {
        const veniceRoutes = ["venice-uncensored", "venice-deepseek"];
        const setVeniceUrl = async (url: string) => {
          await h.ctx.db.update(providers).set({ baseUrl: url }).where(inArray(providers.id, veniceRoutes));
          await h.ctx.catalog.refresh();
        };
        if (behaviour === "dead") await setVeniceUrl(deadUrl);
        else set("venice", { behaviour });
        try {
          // T0 first: the selection order is fixed by the score, not drawn.
          expect(anonymoOrder(h.ctx.catalog.offers("anonymo-1"), h.ctx.health, null).slice(0, 2).map((c) => c.upstreamId)).toEqual(["venice", "venice"]);
          const before = reqs("venice");
          const t = performance.now();
          const r = await chat("anonymo-1", stream ? { stream: true } : {});
          expect(r.status).toBe(200);
          expect([MOCK_UPSTREAMS.selfhostDeepseek, MOCK_UPSTREAMS.selfhostMistral, MOCK_UPSTREAMS.chutes]).toContain(r.servedBy!);
          if (behaviour !== "dead") expect(reqs("venice")).toBeGreaterThan(before); // Venice was tried first
          expect(performance.now() - t).toBeLessThan(6_000); // two Venice routes at most 1.5 s each, then the backup
        } finally {
          if (behaviour === "dead") await setVeniceUrl(mock("venice").url);
        }
      }, 10_000);

  test("after the first token there is no switch: a mid-stream failure ends the stream with an error", async () => {
    set("venice", { behaviour: "midstream_error" });
    const backups = () => reqs("selfhostDeepseek") + reqs("selfhostMistral") + reqs("chutes");
    const before = backups();
    const r = await chat("anonymo-1", { stream: true });
    expect(r.status).toBe(200);
    expect(r.servedBy).toBeNull(); // the partial text came from Venice; no backup text was spliced in
    expect(r.body).toContain("error");
    expect(backups()).toBe(before);
  });
});

describe("prompt-cache stickiness", () => {
  const sticky = "test-sticky-key";
  test("a conversation stays on its route while that route is healthy, and moves when it is not", async () => {
    const { selectProviders } = await import("../src/router/select.ts");
    const input = (key: string | null) => ({
      modelId: "anonymo-1",
      offers: h.ctx.catalog.offers("anonymo-1"),
      prefs: {},
      modifiers: new Set<never>(),
      requestParams: [],
      estimatedTokens: 10,
      health: h.ctx.health,
      production: false,
      attestationMaxAgeMs: 3_600_000,
      modelLane: { variant: "mainstream", servable: true } as never,
      sticky: key,
    });
    stickyRoutes.delete(sticky);
    // Venice is out: the conversation lands on the best backup.
    for (const p of ["venice-uncensored", "venice-deepseek"]) for (let i = 0; i < 2; i++) h.ctx.health.record({ modelId: "anonymo-1", providerId: p, ok: false, errorKind: "http_5xx" });
    const first = selectProviders(input(sticky)).ordered[0].providerId;
    expect(first).toBe("sh-deepseek-flash");
    // Venice recovers and would win on score again; the sticky conversation stays where its prompt cache is.
    resetHealth();
    expect(selectProviders(input(null)).ordered[0].providerId).toBe("venice-deepseek");
    expect(selectProviders(input(sticky)).ordered[0].providerId).toBe("sh-deepseek-flash");
    // Its route turns unhealthy: the conversation moves on, and stays with the new route.
    for (let i = 0; i < 3; i++) h.ctx.health.record({ modelId: "anonymo-1", providerId: "sh-deepseek-flash", ok: i === 0, errorKind: i === 0 ? null : "http_5xx" });
    h.ctx.health.record({ modelId: "anonymo-1", providerId: "sh-deepseek-flash", ok: true });
    expect(selectProviders(input(sticky)).ordered[0].providerId).toBe("venice-deepseek");
    expect(stickyRoutes.get(sticky)).toBe("venice-deepseek");
  });
});

describe("canaries", () => {
  test("a canary runs per route x model and a failed one takes the route out of selection", async () => {
    const before = reqs("venice");
    const r1 = await runUpstreamCanaries(h.ctx, { force: true });
    expect(r1.failed).toEqual([]);
    // One call per route (the Venice upstream has two), recorded for every model ID the route serves.
    expect(reqs("venice") - before).toBe(2);
    expect(h.ctx.health.lastCanaryAt("anonymo-council", "venice-uncensored")).not.toBeNull();
    // Nothing is due again inside the interval.
    expect((await runUpstreamCanaries(h.ctx)).ran).toBe(0);

    set("venice", { behaviour: "error500" });
    const r2 = await runUpstreamCanaries(h.ctx, { force: true });
    expect(r2.failed.sort()).toEqual(["venice-deepseek", "venice-uncensored"]);
    expect(h.ctx.health.outage("anonymo-1", "venice-deepseek")).toBe(true);
    const tried = reqs("venice");
    const r = await chat("anonymo-1");
    expect(r.status).toBe(200);
    expect(reqs("venice")).toBe(tried); // never tried: the canary already drained it
  });
});

describe("wallet-balance alarms", () => {
  test("a low balance raises an alarm; an empty one drains every route of that upstream until it is topped up", async () => {
    set("venice", { balanceUsd: 30 }); // below warn (50), above drain (5)
    set("nanogpt", { balanceUsd: 100 });
    let r = await runBalanceAlarms(h.ctx);
    expect(r).toMatchObject({ checked: 2, levels: { venice: "warn", nanogpt: "ok" } });
    let checks = await anonymoBalanceChecks(h.ctx);
    expect(checks).toMatchObject({ upstream_venice_balance_read: true, upstream_venice_balance_low: false, upstream_venice_drained: true, upstream_nanogpt_balance_low: true });
    expect(h.ctx.catalog.offers("anonymo-1").filter((o) => o.upstreamId === "venice").every((o) => o.status === "live")).toBe(true);

    set("venice", { balanceUsd: 2 });
    r = await runBalanceAlarms(h.ctx);
    expect(r.levels).toMatchObject({ venice: "drain" });
    checks = await anonymoBalanceChecks(h.ctx);
    expect(checks.upstream_venice_drained).toBe(false);
    expect(h.ctx.catalog.offers("anonymo-1").filter((o) => o.upstreamId === "venice").map((o) => o.status)).toEqual(["drained", "drained"]);
    const before = reqs("venice");
    const call = await chat("anonymo-1");
    expect(call.status).toBe(200);
    expect(call.servedBy).not.toBe(MOCK_UPSTREAMS.venice);
    expect(reqs("venice")).toBe(before);

    // An unreadable balance never drains or restores on its own.
    set("venice", { balanceUsd: undefined });
    await runBalanceAlarms(h.ctx);
    expect(h.ctx.catalog.offers("anonymo-1").filter((o) => o.upstreamId === "venice").every((o) => o.status === "drained")).toBe(true);

    set("venice", { balanceUsd: 500 });
    r = await runBalanceAlarms(h.ctx);
    expect(r.levels).toMatchObject({ venice: "ok" });
    expect(h.ctx.catalog.offers("anonymo-1").filter((o) => o.upstreamId === "venice").every((o) => o.status === "live")).toBe(true);
    expect((await chat("anonymo-1")).servedBy).toBe(MOCK_UPSTREAMS.venice);
  });

  test("the balance check names reach the alert notifier", async () => {
    const { runAlertNotifier } = await import("../src/services/alerts.ts");
    set("venice", { balanceUsd: 1 });
    await runBalanceAlarms(h.ctx);
    let seen: Record<string, boolean> = {};
    await runAlertNotifier(h.ctx, { evaluate: async (ctx) => (seen = await anonymoBalanceChecks(ctx)), sustainMs: 0 });
    expect(seen.upstream_venice_drained).toBe(false);
    set("venice", { balanceUsd: 500 });
    await runBalanceAlarms(h.ctx);
  });
});

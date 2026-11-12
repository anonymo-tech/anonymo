import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { modelsLane } from "../src/db/schema.ts";

// GET /v1/models additions, GET /manifest and GET /leaderboard (Backend §11). Counts and route facts only.

let h: Harness;
const m = (id: string, slug: string, quant = "bf16") => ({ id, slug, quant, prompt: "0.000001", completion: "0.000002" });
const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };

beforeAll(async () => {
  h = await startRouter({
    providers: [
      { id: "enc", name: "Enc", models: [m("ds-up", "deepseek/deepseek-v4-flash", "fp8")], tee: "dev" },
      { id: "ven", name: "Ven", models: [m("ds-up", "deepseek/deepseek-v4-flash", "bf16"), m("qwen-up", "qwen/qwen3-32b"), m("odd-up", "acme/<b>odd</b>")] },
    ],
  });
  await h.request(`/api/v1/disclosure/enc`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  await runAttestor(h.ctx);
  await h.ctx.catalog.refresh();
});
afterAll(async () => h.close());

const models = async () => ((await (await h.request("/v1/models")).json()) as any).data as any[];

describe("GET /v1/models", () => {
  test("every model carries family, quant, weights_hash, attested and refusal_rate_30d", async () => {
    const data = await models();
    const ds = data.find((x) => x.id === "deepseek/deepseek-v4-flash");
    const qw = data.find((x) => x.id === "qwen/qwen3-32b");
    expect(ds).toMatchObject({ family: "deepseek", quant: null, weights_hash: null, attested: true, refusal_rate_30d: null });
    expect(qw).toMatchObject({ family: "qwen", quant: "bf16", weights_hash: null, attested: false, refusal_rate_30d: null });
    for (const x of data) for (const k of ["family", "quant", "weights_hash", "attested", "refusal_rate_30d"]) expect(k in x).toBe(true);
  });

  test("a declared weights digest becomes weights_hash; WS03's refusal_stats becomes refusal_rate_30d", async () => {
    await h.ctx.db.insert(modelsLane).values({ modelId: "qwen/qwen3-32b", variant: "mainstream", status: "servable", weightsDigest: "sha256:" + "e".repeat(64) } as never).onConflictDoNothing();
    await h.ctx.db.execute(sql`CREATE TABLE IF NOT EXISTS refusal_stats (route_id text, day date, total int, refused int, PRIMARY KEY (route_id, day))`);
    await h.ctx.db.execute(sql`INSERT INTO refusal_stats VALUES
      ('deepseek/deepseek-v4-flash@ven', current_date, 80, 4), ('enc:deepseek/deepseek-v4-flash', current_date - 1, 20, 1),
      ('qwen/qwen3-32b@ven', current_date, 50, 10), ('qwen/qwen3-32b@ven', current_date - 40, 1000, 1000)`);
    await h.ctx.catalog.refresh();
    const data = await models();
    expect(data.find((x) => x.id === "deepseek/deepseek-v4-flash").refusal_rate_30d).toBe(0.05);
    const qw = data.find((x) => x.id === "qwen/qwen3-32b");
    // Rows older than 30 days are left out; the rate is refused / total.
    expect(qw.refusal_rate_30d).toBe(0.2);
    expect(qw.weights_hash).toBe("sha256:" + "e".repeat(64));
  });
});

describe("GET /manifest", () => {
  test("JSON: every route with upstream, family, quant, weights hash and whether it is attested now", async () => {
    const r = await h.request("/manifest");
    expect(r.headers.get("content-type")).toContain("application/json");
    const doc = (await r.json()) as any;
    const ds = doc.models.find((x: any) => x.id === "deepseek/deepseek-v4-flash");
    expect(ds.routes.map((x: any) => [x.route, x.upstream, x.family, x.quant, x.attested])).toEqual([
      ["enc:deepseek/deepseek-v4-flash", "enc", "deepseek", "fp8", true],
      ["ven:deepseek/deepseek-v4-flash", "ven", "deepseek", "bf16", false],
    ]);
    expect(ds.routes[0].attestation_hash).toBeTruthy();
    expect(ds.routes[1].attestation_hash).toBeNull();
    expect(doc.counts).toMatchObject({ routes: doc.models.reduce((s: number, x: any) => s + x.routes.length, 0), attested_routes: 1 });
  });

  test("HTML for a browser: a table, every cell escaped, no script", async () => {
    const r = await h.request("/manifest", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("<table>");
    expect(html).toContain("enc");
    expect(html).not.toContain("<b>odd</b>");
    expect(html).toContain("&lt;b&gt;odd&lt;/b&gt;");
    expect(html).not.toMatch(/<script/i);
    expect((await h.request("/manifest?format=json", { headers: { accept: "text/html" } })).headers.get("content-type")).toContain("application/json");
  });
});

describe("GET /leaderboard", () => {
  test("refusal counts and rates per route and per family, lowest rate first; counts only", async () => {
    const doc = (await (await h.request("/leaderboard")).json()) as any;
    expect(doc).toMatchObject({ available: true, window_days: 30 });
    expect(doc.routes.map((x: any) => [x.route, x.total_30d, x.refused_30d, x.refusal_rate_30d])).toEqual([
      ["deepseek/deepseek-v4-flash@ven", 80, 4, 0.05], // same rate: more requests first (WS03 writes <model>@<provider>)
      ["enc:deepseek/deepseek-v4-flash", 20, 1, 0.05],
      ["qwen/qwen3-32b@ven", 50, 10, 0.2],
    ]);
    expect(doc.families).toEqual([
      { family: "deepseek", total_30d: 100, refused_30d: 5, refusal_rate_30d: 0.05 },
      { family: "qwen", total_30d: 50, refused_30d: 10, refusal_rate_30d: 0.2 },
    ]);
    const html = await (await h.request("/leaderboard?format=html")).text();
    expect(html).toContain("20.00%");
  });

  test("without WS03's refusal_stats table every rate is unknown, not zero", async () => {
    await h.ctx.db.execute(sql`DROP TABLE refusal_stats`);
    const doc = (await (await h.request("/leaderboard")).json()) as any;
    expect(doc).toMatchObject({ available: false, routes: [], families: [] });
    await h.ctx.catalog.refresh();
    for (const x of await models()) expect(x.refusal_rate_30d).toBeNull();
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRouter, type Harness } from "./helpers.ts";
import { COUNCIL_MODEL, RETIRED_COUNCIL_MODEL, familyGroups } from "../src/router/council.ts";
import { parseReceiptHeader } from "../src/receipts/anonymo.ts";

// WS04 registers `anonymo-council` as a catalog model whose routes span several families (its offers carry `family`).
// With no pool configured, the council takes one proposer seat per family from those routes. WS04's `family` column is
// not on this branch, so the test sets `family` on the catalog's in-memory offers, the way the column will arrive.

describe("family groups", () => {
  test("groups keep routing order, first appearance first", () => {
    const routes = [
      { id: 1, f: "deepseek" },
      { id: 2, f: "glm" },
      { id: 3, f: "deepseek" },
      { id: 4, f: "qwen" },
      { id: 5, f: "glm" },
    ];
    expect(familyGroups(routes, (r) => r.f).map((g) => [g.family, g.routes.map((r) => r.id)])).toEqual([
      ["deepseek", [1, 3]],
      ["glm", [2, 5]],
      ["qwen", [4]],
    ]);
    expect(familyGroups([], () => "x")).toEqual([]);
  });
  test("anonymo-council is the dispatch id; the Anonymo id is retired", () => {
    expect(COUNCIL_MODEL).toBe("anonymo-council");
    expect(RETIRED_COUNCIL_MODEL).toBe("anonymo/council");
  });
});

describe("council over WS04's anonymo-council route pool", () => {
  let h: Harness;
  let auth: Record<string, string>;
  const FAMILY: Record<string, string> = { a: "deepseek", b: "glm", c: "qwen", d: "deepseek" };
  const reply = (prompt: string, body: any) => (prompt.includes("Write the final answer now.") ? "MERGED" : `answer from ${body.model}`);
  const pool = (id: string) => ({ id: `${id}-up`, slug: "anonymo-council", prompt: "0.000001", completion: "0.000002" });
  beforeAll(async () => {
    h = await startRouter({
      env: { ANONYMO_FEATURE_COUNCIL: "true" },
      providers: ["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase(), models: [pool(id)], reply })),
    });
    auth = (await h.fundedKey(20n)).auth;
  });
  afterAll(async () => h.close());

  const tagFamilies = async () => {
    await h.ctx.catalog.refresh();
    for (const o of h.ctx.catalog.offers("anonymo-council")) (o as unknown as Record<string, unknown>).family = FAMILY[o.providerId];
  };

  test("one proposer seat per family; every route the receipt lists is from the pool", async () => {
    await tagFamilies();
    const r = await h.request("/v1/chat/completions", { method: "POST", headers: auth, json: { model: "anonymo-council", messages: [{ role: "user", content: "hello" }], max_tokens: 50 } });
    const body = (await r.json()) as any;
    expect(r.status).toBe(200);
    const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
    const proposers = rc.routes.filter((x) => x.role === "proposer");
    expect(proposers.map((x) => x.family).sort()).toEqual(["deepseek", "glm", "qwen"]);
    expect(new Set(proposers.map((x) => x.provider)).size).toBe(3);
    expect(rc.routes.every((x) => x.model === "anonymo-council")).toBe(true);
    expect(body.choices[0].message.content).toBe("MERGED");
  });

  test("without three families in the pool the council is unavailable and nothing is sent", async () => {
    await h.ctx.catalog.refresh();
    for (const o of h.ctx.catalog.offers("anonymo-council")) (o as unknown as Record<string, unknown>).family = o.providerId === "c" ? "qwen" : "deepseek";
    const r = await h.request("/v1/chat/completions", { method: "POST", headers: auth, json: { model: "anonymo-council", messages: [{ role: "user", content: "hello" }], max_tokens: 50 } });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error.type).toBe("council_unavailable");
  });

  test("the retired anonymo/council id is a 404 that names anonymo-council", async () => {
    const r = await h.request("/v1/chat/completions", {
      method: "POST",
      headers: auth,
      json: { model: RETIRED_COUNCIL_MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 50, council: { models: ["acme/a", "acme/b"], judge: "acme/j" } }
    });
    expect(r.status).toBe(404);
    const err = ((await r.json()) as any).error;
    expect(err.type).toBe("model_not_found");
    expect(err.message).toContain("anonymo-council");
  });
});

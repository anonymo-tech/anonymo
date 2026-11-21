// Ventures is off unless ANONYMO_FEATURE_VENTURES turns it on (src/config.ts, src/anonymo/routes.ts, src/app.ts): no
// /v1/ventures route exists, and model "anonymo-swarm" never starts a run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRouter, type Harness } from "../helpers.ts";

describe("ventures switch", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => h?.close());

  test("the public inventory describes Ventures only when its routes are enabled", async () => {
    const active = await startRouter({ env: { ANONYMO_FEATURE_VENTURES: "1" } });
    try {
      for (const [router, enabled] of [[h, false], [active, true]] as const) {
        const response = await router.request("/keep/inventory.json");
        expect(response.status).toBe(200);
        const inventory = await response.text();
        expect(inventory.includes("venture_artifacts")).toBe(enabled);
        expect(inventory.includes("/v1/ventures")).toBe(enabled);
      }
    } finally {
      await active.close();
    }
  });

  test("by default no Ventures route exists and anonymo-swarm starts nothing", async () => {
    expect(h.ctx.cfg.features.ventures).toBe(false);
    const k = await h.fundedKey(1_000_000n);
    for (const [method, path] of [["GET", "/v1/ventures/pricing"], ["GET", "/v1/ventures/tier"], ["GET", "/v1/ventures"], ["POST", "/v1/ventures"], ["GET", "/v1/ventures/x"]] as const) {
      const r = await h.request(path, { method, headers: k.auth, ...(method === "POST" ? { json: { mode: "idea", brief: "a plant app" } } : {}) });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    const chat = await h.request("/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: "anonymo-swarm", messages: [{ role: "user", content: "build a plant app" }] } });
    expect(chat.status).not.toBe(200);
    expect(chat.status).not.toBe(202);
    expect(JSON.stringify(await chat.json())).not.toContain("venture");
  });
});

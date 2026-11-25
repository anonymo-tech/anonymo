import { expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { floorHitsOf } from "../src/anonymo/floor/gate.ts";
import { characters, generations, holds, kv, ledger } from "../src/db/schema.ts";
import { log } from "../src/lib/util.ts";

const env = { ANONYMO_ENV: "test", DATABASE_URL: "pglite://memory", AUTO_MIGRATE: "true", REDIS_URL: "", LOG_LEVEL: "error" };
const route = "/v1/lifeboat/check-card";
const card = ["Stone Lantern", "A story about a weather station.", "Welcome to the ridge."];
const blocked = "fixture-floor-block-marker";
const inventory = (app: Awaited<ReturnType<typeof createApp>>["app"]) => app.request("/keep/inventory.json").then((response) => response.text());
const post = (app: Awaited<ReturnType<typeof createApp>>["app"], fields: unknown) =>
  app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });

test("the check-card route is absent by default", async () => {
  const { app, close } = await createApp({ env, startJobs: false });
  try {
    expect((await post(app, card)).status).toBe(404);
    expect(await inventory(app)).not.toContain("src/anonymo/lifeboat/routes.ts");
  } finally {
    await close();
  }
});

test("a keyless card check returns a verdict without writes, cache entries or floor hits", async () => {
  const guardEnv = { ...env, ANONYMO_FEATURE_LIFEBOAT: "1", ANONYMO_FLOOR_URL: "https://guard.invalid", ANONYMO_FLOOR_MODEL: "fixture-guard" };
  const guard = spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const { prompt } = JSON.parse(String(init?.body)) as { prompt: string };
    return Response.json({ choices: [{ text: prompt.includes(blocked) ? "unsafe\nS4" : "safe" }] });
  });
  const { app, ctx, close } = await createApp({ env: guardEnv, startJobs: false });
  const stored = () => Promise.all([
    ctx.db.select().from(characters),
    ctx.db.select().from(generations),
    ctx.db.select().from(holds),
    ctx.db.select().from(ledger),
    ctx.db.select().from(kv),
  ]);
  try {
    const before = await stored();
    expect(await inventory(app)).toContain("src/anonymo/lifeboat/routes.ts");
    const hits = floorHitsOf(ctx.anonymo.floor);
    expect(hits?.size).toBe(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const allowed = await post(app, card);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("Cache-Control")).toBe("no-store");
      expect(await allowed.json()).toEqual({ allowed: true });
      const denied = await post(app, [...card, blocked]);
      expect(denied.status).toBe(451);
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
      const body = await denied.text();
      expect(JSON.parse(body)).toMatchObject({ error: { type: "floor_blocked", metadata: { category: "cbrn" } } });
      expect(body).not.toContain(blocked);
      expect(body).not.toContain(card[0]!);
    }
    // The same floor as chat: blocks leave the floor's minimal hit record (hash, length, category, never text).
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(hits?.size ?? 1).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify([...(hits?.values?.() ?? [])])).not.toContain(blocked);
    expect(await stored()).toEqual(before);
  } finally {
    await close();
    guard.mockRestore();
  }
});

test("malformed and oversized cards never reach the floor, and a floor error fails closed without echoing text", async () => {
  const floor = { check: async () => { throw new Error(blocked); } };
  const check = spyOn(floor, "check");
  const errorLog = spyOn(log, "error");
  const { app, close } = await createApp({ env: { ...env, ANONYMO_FEATURE_LIFEBOAT: true }, anonymo: { floor }, startJobs: false });
  try {
    expect((await post(app, [" "])).status).toBe(400);
    expect((await post(app, [{ text: blocked }])).status).toBe(400);
    expect((await post(app, ["a".repeat(200_001)])).status).toBe(413);
    expect(check).toHaveBeenCalledTimes(0);
    const failed = await post(app, card);
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(JSON.parse(body)).toMatchObject({ error: { type: "floor_unavailable" } });
    expect(body).not.toContain(blocked);
    expect(errorLog).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  } finally {
    await close();
    errorLog.mockRestore();
  }
});

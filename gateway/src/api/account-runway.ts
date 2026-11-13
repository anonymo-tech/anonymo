import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { readRunway } from "../account/runway.ts";
export function accountRunwayRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/account/runway", async c => {
    c.header("cache-control", "no-store");
    return c.json(await readRunway(ctx, await requireKey(ctx, c.req.header("authorization"))));
  });
}

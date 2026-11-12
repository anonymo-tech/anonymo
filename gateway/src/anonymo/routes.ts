// Every Anonymo route is mounted here, so workstreams add one line in this file instead of editing src/app.ts.
// Keep the list in workstream order; each line names its owner.

import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { abuseRoutes } from "./abuse/routes.ts";

export function anonymoRoutes(app: Hono, ctx: Ctx) {
  abuseRoutes(app, ctx); // WS02 · abuse inbox, takedowns, floor-hit reporting (region rules mount in app.ts, see region/middleware.ts)
  // WS05 · keys, deposits, withdrawals
  // WS06 · media endpoints
  // WS09 · receipts proofs, manifest, leaderboard
}

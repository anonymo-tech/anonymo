// Every Anonymo route is mounted here, so workstreams add one line in this file instead of editing src/app.ts.
// Keep the list in workstream order; each line names its owner.

import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { abuseRoutes } from "./abuse/routes.ts";
import { refusalRoutes } from "./refusal/routes.ts";
import { mediaRoutes } from "./media/routes.ts";

export function anonymoRoutes(app: Hono, ctx: Ctx) {
  abuseRoutes(app, ctx); // WS02 · abuse inbox, takedowns, floor-hit reporting (region rules mount in app.ts, see region/middleware.ts)
  refusalRoutes(app, ctx); // WS03 · per-key refusal-catch setting
  // WS05 · keys, deposits, withdrawals
  mediaRoutes(app, ctx); // WS06 · media endpoints (src/anonymo/media/routes.ts)
  // WS09 · receipts proofs, manifest, leaderboard
}

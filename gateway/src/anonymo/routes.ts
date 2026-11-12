// Every Anonymo route is mounted here, so workstreams add one line in this file instead of editing src/app.ts.
// Keep the list in workstream order; each line names its owner.

import type { Hono } from "hono";
import type { Ctx } from "../context.ts";

export function anonymoRoutes(_app: Hono, _ctx: Ctx) {
  // WS02 · abuse inbox and region rules
  // WS05 · keys, deposits, withdrawals
  // WS06 · media endpoints
  // WS09 · receipts proofs, manifest, leaderboard
}

// WS03 · refusal-catch tables (created by drizzle/0056_refusal.sql), re-exported from src/db/schema.ts.
// Counts and a per-key flag only: no prompt or reply text, ever.

import { boolean, date, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** One row per route (model@provider) per UTC day: how many replies the classifier read, and how many it refused. */
export const refusalStats = pgTable(
  "refusal_stats",
  {
    routeId: text("route_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    total: integer("total").notNull().default(0),
    refused: integer("refused").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.routeId, t.day] })],
);

/** A key's own default for the refusal catch. No row = on. */
export const refusalKeySettings = pgTable("refusal_key_settings", {
  keyHash: text("key_hash").primaryKey(),
  catchEnabled: boolean("catch_enabled").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

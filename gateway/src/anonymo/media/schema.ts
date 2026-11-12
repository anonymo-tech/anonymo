// The one table media adds (migration drizzle/0057_anonymo_media_jobs.sql): asynchronous video jobs.
// Metadata only. It never holds the prompt, the output, or anything about the caller beyond the account and key hash
// the ledger already keys on. The output itself lives only in the short-lived media store (store.ts).

import { bigint, index, integer, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const mediaJobs = pgTable(
  "media_jobs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    keyHash: text("key_hash"),
    holdId: text("hold_id").notNull(),
    model: text("model").notNull(),
    upstream: text("upstream").notNull(),
    /** The upstream's job reference (ComfyUI prompt id, Venice queue id). Null until submission was accepted. */
    upstreamRef: text("upstream_ref"),
    /** queued | running | finishing | completed | failed | blocked */
    status: text("status").notNull(),
    seconds: integer("seconds").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** Region rule at submission: false keeps explicit output off when the job completes. */
    explicitAllowed: boolean("explicit_allowed").notNull(),
    pricePico: bigint("price_pico", { mode: "bigint" }).notNull(),
    chargedPico: bigint("charged_pico", { mode: "bigint" }),
    /** A stable, machine-readable reason (media_blocked:nsfw_minor, upstream_failed, …). Never upstream text. */
    errorType: text("error_type"),
    mediaId: text("media_id"),
    mediaExpiresAt: ts("media_expires_at"),
    lastPolledAt: ts("last_polled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("media_jobs_account_idx").on(t.accountId, t.createdAt), index("media_jobs_status_idx").on(t.status, t.updatedAt)],
);

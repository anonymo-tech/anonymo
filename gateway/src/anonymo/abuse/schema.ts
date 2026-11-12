// WS02 tables (migration drizzle/0055_anonymo_floor_abuse.sql). Kept out of src/db/schema.ts, which WS01 owns.
// None of these hold prompt or output text, media, IP addresses or user agents in the clear: hashes, ids and
// AES-GCM ciphertext only.

import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** The 48-hour takedown inbox (TAKE IT DOWN Act; UK Crime and Policing Act 2026 ss.99–100). */
export const abuseReports = pgTable(
  "abuse_reports",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // ncii | csam | other
    status: text("status").notNull().default("open"), // open | actioned | rejected
    reference: text("reference"), // a receipt, generation or job id the reporter points at
    contentHashes: jsonb("hashes_sha256").$type<string[]>().notNull().default([]),
    detailsEnc: text("details_enc"), // reporter's own words, encrypted
    contactEnc: text("contact_enc"), // optional reply address, encrypted
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    actionedAt: timestamp("actioned_at", { withTimezone: true }),
    action: text("action"), // blocked | reported | rejected
    tiplineReportId: text("tipline_report_id"),
  },
  (t) => [index("abuse_reports_status_due_idx").on(t.status, t.dueAt)],
);

/** Block-by-hash: exact SHA-256 of content we must refuse as an upload. */
export const abuseHashBlocks = pgTable("abuse_hash_blocks", {
  sha256: text("sha256").primaryKey(),
  category: text("category").notNull(), // a FloorCategory
  source: text("source").notNull(), // takedown | report | operator
  reportId: text("report_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Preservation vault (18 USC 2258A(h)): written only for a reported floor hit or report, kept one year, encrypted. */
export const preservation = pgTable(
  "preservation",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(), // floor_hit | takedown
    sourceId: text("source_id").notNull(),
    category: text("category").notNull(),
    tiplineReportId: text("tipline_report_id").notNull(),
    blobEnc: text("blob_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("preservation_expires_idx").on(t.expiresAt)],
);

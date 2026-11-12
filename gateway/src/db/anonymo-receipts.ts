import { bigint, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// WS09 tables (drizzle/0058_anonymo_receipts.sql), re-exported from db/schema.ts like db/low-balance.ts. Neither table holds prompt or output text: a receipt carries ids, routes, hashes,
// token counts and amounts only.

/** One signed Anonymo receipt per served call (Backend §8). */
export const anonymoReceipts = pgTable(
  "anonymo_receipts",
  {
    id: text("id").primaryKey(), // the request id (also the X-Receipt-Id of the response)
    modelId: text("model_id").notNull(),
    payload: jsonb("payload").notNull(),
    sig: text("sig").notNull(), // base64 Ed25519 over canonical_json(payload)
    keyId: text("key_id").notNull(),
    leaf: text("leaf").notNull(), // keccak256(canonical_json(payload)), 0x-hex
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    rootHour: bigint("root_hour", { mode: "number" }), // set when the receipt joins an hourly root
    leafIndex: integer("leaf_index"),
  },
  (t) => [index("anonymo_receipts_unrooted_idx").on(t.rootHour, t.issuedAt), index("anonymo_receipts_root_idx").on(t.rootHour, t.leafIndex)],
);

/** One Merkle root per closed hour (unix hour number), posted to ReceiptRoots.post(hour, root) when a poster is set. */
export const anonymoReceiptRoots = pgTable("anonymo_receipt_roots", {
  hour: bigint("hour", { mode: "number" }).primaryKey(),
  root: text("root").notNull(),
  count: integer("count").notNull(),
  status: text("status").notNull(), // local (no poster) | pending | posted | failed
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

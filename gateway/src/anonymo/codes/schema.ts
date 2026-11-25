import { sql } from "drizzle-orm";
import { check, customType, index, numeric, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

const digest = customType<{ data: string; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (hex) => Buffer.from(hex, "hex"),
  fromDriver: (bytes) => Buffer.from(bytes).toString("hex"),
});

export const codes = pgTable("codes", {
  codeHash: digest("code_hash").primaryKey(),
  faceUsd: numeric("face_usd", { mode: "number" }).notNull(),
  batchId: uuid("batch_id").notNull(),
  resellerId: uuid("reseller_id").notNull(),
  redeemedBy: digest("redeemed_by"),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
}, (t) => [
  index("codes_reseller_batch_idx").on(t.resellerId, t.batchId),
  check("codes_face_usd_check", sql`${t.faceUsd} in (5, 10, 25, 50)`),
  check("codes_digest_check", sql`octet_length(${t.codeHash}) = 32 AND octet_length(${t.redeemedBy}) = 32`),
  check("codes_redemption_check", sql`(${t.redeemedBy} is null) = (${t.redeemedAt} is null)`),
]);

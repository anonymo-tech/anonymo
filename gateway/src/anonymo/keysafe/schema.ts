import { customType, pgTable, timestamp } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
});

export const keySafes = pgTable("key_safes", {
  safeId: bytea("safe_id").primaryKey(),
  credentialId: bytea("credential_id").notNull().unique(),
  ciphertext: bytea("ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

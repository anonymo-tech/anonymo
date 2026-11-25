import { customType, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const bytes = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
});

export const designedVoices = pgTable("designed_voices", {
  id: uuid("id").primaryKey(),
  keyHash: bytes("key_hash").notNull(),
  name: text("name").notNull(),
  embedding: bytes("embedding").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("designed_voices_key_hash_idx").on(t.keyHash)]);

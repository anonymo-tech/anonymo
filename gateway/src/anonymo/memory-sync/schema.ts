import { boolean, customType, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

const bytes = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
});

export const memoryBlobs = pgTable("memory_blobs", {
  vaultId: bytes("vault_id").notNull(),
  itemId: uuid("item_id").notNull(),
  version: integer("version").notNull(),
  ciphertext: bytes("ciphertext").notNull(),
  deleted: boolean("deleted").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.vaultId, t.itemId] })]);

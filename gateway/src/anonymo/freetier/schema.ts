import { customType, date, integer, pgTable } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const freeTokens = pgTable("free_tokens", {
  deviceToken: bytea("device_token").primaryKey(),
  day: date("day").notNull(),
  used: integer("used").notNull(),
  powDifficulty: integer("pow_difficulty").notNull(),
});

import { bigint, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const telegramLinks = pgTable("telegram_links", {
  telegramHash: text("telegram_hash").primaryKey(),
  keyHash: text("key_hash").notNull(),
});

export const telegramTokens = pgTable("telegram_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  kind: text("kind", { enum: ["link", "handoff", "session", "trial"] }).notNull(),
  telegramHash: text("telegram_hash"),
  keyHash: text("key_hash"),
  proof: text("proof"),
  expiresAt: ts("expires_at").notNull(),
}, (t) => [index("telegram_tokens_expiry_idx").on(t.expiresAt)]);

export const starsOrders = pgTable("stars_orders", {
  chargeId: text("telegram_payment_charge_id").primaryKey(),
  keyHash: text("key_hash").notNull(),
  stars: integer("stars").notNull(),
  creditedPico: bigint("credited_pico", { mode: "bigint" }).notNull(),
  ts: ts("ts").notNull().defaultNow(),
  refundedAt: ts("refunded_at"),
});

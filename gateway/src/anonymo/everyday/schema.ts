import { bigint, date, index, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const passOrders = pgTable("pass_orders", {
  orderId: text("order_id").primaryKey(),
  keyHash: text("key_hash").notNull(),
  sku: text("sku").notNull(),
});

export const passes = pgTable("passes", {
  orderId: text("order_id").primaryKey().references(() => passOrders.orderId),
  keyHash: text("key_hash").notNull(),
  sku: text("sku").notNull(),
  starts: timestamp("starts", { withTimezone: true }).notNull(),
  ends: timestamp("ends", { withTimezone: true }).notNull(),
}, (r) => [index("passes_key_ends_idx").on(r.keyHash, r.ends)]);

export const stakeLinks = pgTable("stake_links", {
  wallet: text("wallet").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
});

export const stakeCheckpoints = pgTable("stake_checkpoints", {
  contract: text("contract").notNull(),
  wallet: text("wallet").notNull(),
  at: bigint("at", { mode: "bigint" }).notNull(),
  balance: numeric("balance", { precision: 78, scale: 0 }).notNull(),
}, (r) => [primaryKey({ columns: [r.contract, r.wallet, r.at] })]);

export const dailyMoCredits = pgTable("daily_mo_credits", {
  keyHash: text("key_hash").notNull(),
  day: date("day").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
}, (r) => [primaryKey({ columns: [r.keyHash, r.day] })]);

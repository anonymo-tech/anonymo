import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const pico = (name: string) => bigint(name, { mode: "bigint" }).notNull().default(0n);

// The legacy characters table remains available to the older card API.
export const creatorCharacters = pgTable("creator_characters", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardHash: text("card_hash").notNull().unique(),
  creatorWallet: text("creator_wallet").notNull(),
  shareBps: integer("share_bps").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  personality: text("personality").notNull(),
  scenario: text("scenario").notNull(),
  tags: text("tags").array().notNull(),
  adult: boolean("adult").notNull(),
  publishedAt: ts("published_at").notNull().defaultNow(),
  floorVerdict: jsonb("floor_verdict").$type<{ allowed: true }>().notNull(),
}, (t) => [check("creator_share_bps", sql`${t.shareBps} between 0 and 1500`)]);

export const creatorAccruals = pgTable("creator_accruals", {
  characterId: uuid("character_id").notNull().references(() => creatorCharacters.id),
  day: date("day").notNull(),
  amount: pico("amount"),
  allocated: pico("allocated"),
  spend: pico("spend"),
  chats: integer("chats").notNull(),
  fundedKeys: integer("funded_keys").notNull(),
  heldUntil: ts("held_until").notNull(),
  frozen: boolean("frozen").notNull().default(false),
  reviewed: boolean("reviewed").notNull().default(false),
  payoutWeek: date("payout_week"),
}, (t) => [primaryKey({ columns: [t.characterId, t.day] })]);

export type PayoutLeaf = { wallet: `0x${string}`; amount: string; proof: { hash: `0x${string}`; sum: string }[] };

export const payoutRoots = pgTable("payout_roots", {
  week: date("week").primaryKey(),
  root: text("root").notNull(),
  total: text("total").notNull(),
  tx: text("tx"),
  leaves: jsonb("leaves").$type<PayoutLeaf[]>().notNull(),
});

export const creatorReferralLinks = pgTable("creator_referral_links", {
  code: uuid("code").primaryKey().defaultRandom(),
  inviterKeyHash: text("inviter_key_hash").notNull().unique(),
});

export const creatorReferrals = pgTable("creator_referrals", {
  inviteeKeyHash: text("invitee_key_hash").primaryKey(),
  inviteeAccountId: text("invitee_account_id").notNull().unique(),
  code: uuid("code").notNull().references(() => creatorReferralLinks.code),
  acceptedAt: ts("accepted_at").notNull().defaultNow(),
  fundedAt: ts("funded_at"),
  spendCredit: pico("spend_credit"),
  registeredTx: text("registered_tx"),
});

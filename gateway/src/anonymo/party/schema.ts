import { sql } from "drizzle-orm";
import { boolean, check, customType, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
});

export const partyRooms = pgTable("party_rooms", {
  id: uuid("id").primaryKey(),
  hostKeyHash: bytea("host_key_hash").notNull(),
  ruleset: text("ruleset").notNull(),
  players: integer("players").notNull(),
  mature: boolean("mature").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [check("party_rooms_players_check", sql`${t.players} BETWEEN 0 AND 6`)]);

export const diceCommits = pgTable("dice_commits", {
  roomId: uuid("room_id").notNull().references(() => partyRooms.id),
  rollNo: integer("roll_no").notNull(),
  commit: bytea("commit").notNull(),
  reveal: bytea("reveal"),
}, (t) => [primaryKey({ columns: [t.roomId, t.rollNo] })]);

import { sql } from "drizzle-orm";
import { check, customType, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type RegionMode = "allowed" | "blocked" | "proof_required";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const regionPolicy = pgTable("region_policy", {
  region: text("region").primaryKey(),
  mode: text("mode").$type<RegionMode>().notNull(),
  disclosureIntervalMin: integer("disclosure_interval_min"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("region_policy_mode", sql`${t.mode} in ('allowed', 'blocked', 'proof_required')`),
  check("region_policy_interval", sql`${t.disclosureIntervalMin} > 0`),
]);

export const ageProofs = pgTable("age_proofs", {
  nullifier: bytea("nullifier").primaryKey(),
  keyHash: bytea("key_hash").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("age_proofs_key_hash_idx").on(t.keyHash)]);

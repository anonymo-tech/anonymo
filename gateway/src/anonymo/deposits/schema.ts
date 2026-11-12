// WS05 tables: per-key caps and wallet binding, deposit addresses, every observed deposit (credited or held), withdrawals,
// BTCPay invoices and the multi-chain sanctions list. Migration: drizzle/0059_anonymo_money.sql.
// Nothing here holds an email, a name, an IP address or a user agent. `ip_allow` is the key owner's own allowlist.

import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Anonymo controls on top of an Anonymo `keys` row (same key_hash). */
export const anonymoKeys = pgTable("anonymo_keys", {
  keyHash: text("key_hash").primaryKey(),
  wallet: text("wallet"), // lowercase 0x address proven by SIWE; refunds go there. Null for anonymous keys.
  dailyCap: money("daily_cap"), // pico-USD, null = none
  monthlyCap: money("monthly_cap"),
  lifetimeCap: money("lifetime_cap"),
  ipAllow: text("ip_allow").array(), // CIDRs or single addresses the owner allows; null = any
  sealedOnly: boolean("sealed_only").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** The deposit identifier each key gets on each chain family: an EVM key commitment, a Solana Pay reference, a Tron address. */
export const anonymoDepositAddresses = pgTable(
  "anonymo_deposit_addresses",
  {
    keyHash: text("key_hash").notNull(),
    chain: text("chain").notNull(), // evm | solana | tron
    address: text("address").notNull(),
    derivationIndex: integer("derivation_index"), // tron: child index under the configured xpub
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.keyHash, t.chain] }), uniqueIndex("anonymo_deposit_addresses_address_uq").on(t.chain, t.address)],
);

/** Every confirmed deposit a watcher reported. `held` deposits (sanctions, or screening unavailable) were never credited. */
export const anonymoDeposits = pgTable(
  "anonymo_deposits",
  {
    ref: text("ref").primaryKey(), // `${chain}:${txHash}:${logIndex}` or `btcpay:<invoice>`
    keyHash: text("key_hash").notNull(),
    chain: text("chain").notNull(),
    token: text("token").notNull().default(""),
    amountRaw: numeric("amount_raw", { precision: 78, scale: 0 }),
    amountPico: money("amount_pico").notNull(),
    sourceAddr: text("source_addr").notNull(),
    status: text("status").notNull(), // credited | held
    reason: text("reason"), // held: sanctioned | screening_unavailable
    createdAt: ts("created_at").notNull().defaultNow(),
    creditedAt: ts("credited_at"),
  },
  (t) => [index("anonymo_deposits_key_idx").on(t.keyHash, t.chain, t.sourceAddr), index("anonymo_deposits_status_idx").on(t.status)],
);

/** Withdrawals go only to a source address of the same key. The ledger debit is posted when the row is created. */
export const anonymoWithdrawals = pgTable(
  "anonymo_withdrawals",
  {
    id: text("id").primaryKey(),
    keyHash: text("key_hash").notNull(),
    accountId: text("account_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    chain: text("chain").notNull(),
    token: text("token").notNull(),
    toAddr: text("to_addr").notNull(),
    amountPico: money("amount_pico").notNull(),
    status: text("status").notNull().default("pending"), // pending | sent | reverted
    txRef: text("tx_ref"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    sentAt: ts("sent_at"),
  },
  (t) => [uniqueIndex("anonymo_withdrawals_idem_uq").on(t.keyHash, t.idempotencyKey), index("anonymo_withdrawals_to_idx").on(t.keyHash, t.chain, t.toAddr), index("anonymo_withdrawals_status_idx").on(t.status)],
);

/** BTCPay invoices this router created. The refund address is where a withdrawal of this credit goes. */
export const anonymoBtcpayInvoices = pgTable("anonymo_btcpay_invoices", {
  invoiceId: text("invoice_id").primaryKey(),
  keyHash: text("key_hash").notNull(),
  refundChain: text("refund_chain").notNull(), // btc | ln
  refundAddr: text("refund_addr").notNull(),
  status: text("status").notNull().default("new"), // new | credited | held | expired
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** OFAC SDN digital-currency addresses for every chain we accept (the network/ list keeps EVM only). */
export const anonymoSanctions = pgTable("anonymo_sanctions", {
  address: text("address").primaryKey(), // EVM and bech32 lowercased; base58 as published
  family: text("family").notNull(), // evm | tron | solana | btc | other
  listDate: ts("list_date").notNull(),
  createdAt: ts("created_at").notNull().default(sql`now()`),
});

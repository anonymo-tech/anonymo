import type { TableDoc } from "../types.ts";

export const telegramTables: Record<string, TableDoc> = {
  telegram_links: {
    category: "keys",
    request: "no",
    purpose: "Connects a Telegram user to their Anonymo key for Stars credit and optional workspace handoff.",
    retention: "Kept until the Telegram user unlinks or links a different key.",
    columns: {
      telegram_hash: "Server-salted HMAC of the numeric Telegram user ID.",
      key_hash: "SHA-256 hash of the linked Anonymo key.",
    },
  },
  telegram_tokens: {
    category: "keys",
    request: "no",
    purpose: "One-time link codes and handoffs, temporary workspace chat credentials, and proof-of-work for one bot reply.",
    retention: "Link codes, handoffs and bot proofs are deleted when used or after their two- to five-minute expiry. A workspace chat credential expires within one hour. A minute job prunes expired rows.",
    columns: {
      token_hash: "Hash of a random token or server-salted digest identifying one armed trial.",
      kind: "Fixed purpose of the token: link, handoff, session or trial.",
      telegram_hash: "Server-salted HMAC of the Telegram user ID, when associated with a user.",
      key_hash: "SHA-256 hash of the linked key, when associated with a key.",
      proof: "For an armed trial only, a signed free-tier challenge and its numeric proof-of-work solution.",
      expires_at: "Time past which the code, handoff, trial or session cannot be used.",
    },
  },
  stars_orders: {
    category: "billing",
    request: "no",
    purpose: "Records Stars payments and refunds so each Telegram charge only credits its linked key once.",
    retention: "Kept with billing records for reconciliation and to prevent duplicate credit or refund.",
    columns: {
      telegram_payment_charge_id: "Telegram's opaque reference for a Stars charge.",
      key_hash: "SHA-256 hash of the key named in the purchase quote.",
      stars: "Total price in Stars.",
      credited_pico: "Exact amount originally credited in pico-USD, or zero if a refund arrived before the payment was recorded.",
      ts: "Time the charge was first recorded.",
      refunded_at: "Time the refund was recorded, if any.",
    },
  },
};

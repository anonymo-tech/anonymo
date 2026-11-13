import type { TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, KEPT, KEPT_APPEND, rv } from "./common.ts";

// Receipts and proofs: keys the router signs with, the roots receipts are anchored under and the append-only log of keys and
// configurations. Everything here is public by design or a hash; none of it carries request or answer text.

export const receiptTables: Record<string, TableDoc> = {
  receipt_keys: {
    category: "receipts",
    purpose: "The Ed25519 keys that sign receipts, with the dates each was valid. Public halves are published; the private half is encrypted at rest.",
    request: "no",
    retention: "Keys are rotated (RECEIPT_KEY_ROTATION_DAYS) and retired, never deleted, so old receipts stay verifiable.",
    columns: {
      id: "Key id: 16 hex characters, the first bytes of the public key's digest.",
      public_key: "The raw 32-byte public key, hex. Published at /api/v1/receipts/keys.",
      private_key_enc: "The private key, AES-256-GCM encrypted with the router's APP_SECRET. Null for a key that can no longer sign; the router then makes a new one.",
      valid_from: "When the key started signing.",
      retired_at: "When it stopped signing, once rotated out.",
      onchain_tx: "The transaction that published the public key on chain.",
      created_at: CREATED,
    },
  },

  anchors: {
    category: "receipts",
    purpose: "A Merkle root over the receipts signed in one interval, and the chain transaction that recorded it. Lets anyone check that a receipt existed at that time.",
    request: "aggregate",
    retention: KEPT_APPEND,
    columns: {
      index: "Anchor number, counting up from zero.",
      root: "The Merkle root of the interval's receipt leaves (32 bytes, hex).",
      from_ts: "Start of the interval covered.",
      to_ts: "End of the interval covered.",
      count: "How many receipts the root covers.",
      tx_hash: "The chain transaction that recorded the root.",
      status: "pending, submitted, confirmed or local.",
      created_at: CREATED,
    },
  },






};

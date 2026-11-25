import type { TableDoc } from "../types.ts";

export const creatorTables: Record<string, TableDoc> = {
  creator_characters: {
    category: "operations", request: "no", purpose: "Public character profiles approved for Discover.",
    retention: "Kept while the profile is published and for payout accounting.",
    columns: {
      id: "Random public character identifier.",
      card_hash: "Verified hash of the public card profile.",
      creator_wallet: "Public payout wallet that signed the publication.",
      share_bps: "Creator share in basis points, up to 1,500.",
      name: "Public character name supplied by the publisher.",
      description: {
        purpose: "Public character description supplied for publication.",
        review: { covers: ["name:content"], verdict: "no-request-content", why: "This is deliberately published character metadata. Runtime prompts, instructions, replies and chat histories are separate and are never put here." },
      },
      personality: "Public character traits supplied for publication.",
      scenario: "Public setting supplied for publication.",
      tags: "Public directory search tags.",
      adult: "Visibility flag for funded adult sessions.",
      published_at: "When the public profile was first registered.",
      floor_verdict: {
        purpose: "Fixed approval flag for the publication.",
        review: { covers: ["type:json"], verdict: "no-request-content", why: "The profile gate writes only a fixed allowed boolean and never copies classifier output or user text into this field." },
      },
    },
  },
  creator_accruals: {
    category: "billing", request: "aggregate", purpose: "Paid chat activity and eligible shares aggregated by character and UTC day.",
    retention: "Kept for aggregate activity reporting and payout reconciliation.",
    notes: ["The job prunes day-salt fingerprints under creators-cap-day in the key-value table after the prior UTC day. A fingerprint helps detect loss of the ephemeral Redis cap; it contains no visitor or character identifier."],
    columns: {
      character_id: "Public character that received the aggregate.",
      day: "UTC date to which the aggregate belongs.",
      amount: "Total creator share in pico-USD.",
      allocated: "Part of the creator share assigned to a payout root in pico-USD.",
      spend: "Total spend from eligible funded keys in pico-USD.",
      chats: "Number of eligible paid chat requests.",
      funded_keys: "Estimated count of distinct funded visitors that day.",
      held_until: "Earliest time the daily balance can be allocated.",
      frozen: "Whether aggregate anomaly review is blocking payout.",
      reviewed: "Whether an operator reviewed the freeze.",
      payout_week: "Root week to which the daily share was allocated.",
    },
  },
  payout_roots: {
    category: "chain", request: "aggregate", purpose: "Weekly USDG Merkle-sum roots and public wallet proofs.",
    retention: "Kept indefinitely so eligible wallets can claim later.",
    columns: {
      week: "UTC start date of the contract payout epoch.",
      root: "Merkle-sum root as a hex digest.",
      total: "Exact sum of the root in USDG base units.",
      tx: "Public chain transaction that posted the root, once confirmed.",
      leaves: {
        purpose: "Wallet, USDG amount and Merkle-sum siblings needed for a claim.",
        review: { covers: ["type:json"], verdict: "no-request-content", why: "Each leaf contains only a public payout destination, amount, and cryptographic proof. It contains no visitor identifiers or interaction data." },
      },
    },
  },
  creator_referral_links: {
    category: "keys", request: "no", purpose: "Maps an opaque referral code to the key that owns it.",
    retention: "Kept while the key's invite link can be redeemed.",
    columns: { code: "Random shareable referral code.", inviter_key_hash: "Digest of the key that can receive referral credits." },
  },
  creator_referrals: {
    category: "billing", request: "aggregate", purpose: "Deduplicates first-funding promotions and measures 90-day credit eligibility.",
    retention: "Kept for ledger reconciliation and to prevent repeated first-funding credits.",
    columns: {
      invitee_key_hash: "Digest of the invited key, used to find its first funding.",
      invitee_account_id: "Invited balance account, deduplicated across sub-keys.",
      code: "Opaque identifier of the accepted referral link.",
      accepted_at: "When the invited key accepted the offer.",
      funded_at: "When the invited key first funded its balance.",
      spend_credit: "Total 90-day referral usage credit posted in pico-USD.",
      registered_tx: "Public transaction for the inviter commitment, if submitted.",
    },
  },
};

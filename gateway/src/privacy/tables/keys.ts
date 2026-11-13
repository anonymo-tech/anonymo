import type { TableDoc } from "../types.ts";
import { CREATED, KEPT, KEPT_APPEND, rv } from "./common.ts";

// Keys and auth: API keys (kept only as hashes), the sessions built on them and the provider keys you may bring.

export const keyTables: Record<string, TableDoc> = {
  keys: {
    category: "keys",
    purpose: "One row per API key. The secret is never stored: the row holds its SHA-256 and a masked label. It also holds the key's limits, budget and spend.",
    request: "no",
    retention: "Deleting a key only disables it (DELETE /api/v1/keys/:hash sets disabled); the row stays because generations and balances refer to it.",
    columns: {
      key_hash: "SHA-256 of the key's secret. The secret itself is never stored.",
      chain_key_hash: "keccak256 of the address derived from the secret, the id the on-chain contracts use for the key.",
      key_address: {
        purpose: "The blockchain address derived from the key's secret. It is public on chain when the key is funded.",
        review: rv(["name:network"], "wallet-address", "A blockchain address derived from the key, not a network address of a caller."),
      },
      account_id: "The account the key belongs to.",
      parent_hash: "For a key made from another key (an agent session), the parent's key hash.",
      name: "The label the owner gave the key.",
      label: "A masked display form of the key, such as sk-ar-v1-abcd...wxyz: the first and last few characters only.",
      budget: "The key's spend limit in pico-USD. Empty means unlimited.",
      budget_reset: "How often the budget resets: daily, weekly or monthly, or never.",
      period_start: "When the current budget period began.",
      spent: { purpose: "Spend in the current budget period, in pico-USD.", request: "aggregate" },
      spent_total: { purpose: "All-time spend of the key, in pico-USD.", request: "aggregate" },
      rpm: "Requests-per-minute limit for the key.",
      tpm: "Tokens-per-minute limit for the key.",
      allowed_models: "If set, the only models the key may call.",
      scope: "Null keeps account access; inference permits model calls and this key’s own generation and receipt reads only.", // ZK6
      include_byok_in_limit: "Stored compatibility selection. Provider-side BYOK expenditure is not tracked; usage counts router-billed charges once.", // ZK6
      management: "Whether the key may manage other keys.",
      routing: {
        purpose: "Imported routing presets: model aliases and default provider preferences the owner set for this key.",
        review: rv(["type:json"], "config", "Routing settings written by the key's owner and validated as aliases and provider preferences; there is no field for message text."),
      },
      guardrails: {
        purpose: "The key's input guardrails: PII mode, phrases to block, a maximum input length and whether to redact output.",
        review: rv(["type:json"], "config", "The owner's filter settings. Deny phrases are words the owner wants blocked (up to 50 of 200 characters); they are rules, not requests."),
      },
      tracing: {
        purpose: "Where the key's owner asked for traces of this key's public-lane calls to go (their own OpenTelemetry collector, Langfuse or Helicone), and whether to include prompt and completion text. The destination URL and credentials are AES-256-GCM encrypted with APP_SECRET and never returned by the API.",
        review: rv(["type:json"], "config", "Destination settings written by the key's owner: a type, flags, a masked host, header names and one sealed string. The schema has no field for message text; content is only ever sent to the owner's destination, never stored here."),
      },
      topup: {
        purpose: "The key's auto top-up rule, or empty: below_usd, add_usd and max_per_week_usd. When the key has less than below_usd of its limit left, the router raises the limit by add_usd from the account's own credits, at most max_per_week_usd per UTC week.",
        review: rv(["type:json"], "config", "Three numbers written by the key's owner and checked against a strict schema; there is no field for text."),
      },
      disabled: "Whether the key is turned off.",
      expires_at: "When the key stops working, if it expires.",
      created_at: CREATED,
      last_used: { purpose: "When the key last made a call.", request: "yes" },
    },
  },

  key_topups: {
    category: "keys",
    purpose: "One row per auto top-up of a key's limit, and one per top-up the router skipped and why (once per key, reason, limit and week). No money moves: the limit is an allowance on the account's own balance. Activity and the inbox show these rows.",
    request: "aggregate",
    retention: KEPT_APPEND,
    columns: {
      id: "Random record id.",
      ref: "What triggered it: settle:<hold id> after a debit, reserve:<request id> when the key's limit would refuse a request, or skip:<key hash>:<reason>:<limit>:<week> for a skipped top-up. Unique, so each is recorded once.",
      key_hash: "The key whose limit was raised.",
      account_id: "The account the key belongs to.",
      outcome: "added, skipped_balance (the account's available credits did not cover the key's allowance after it), skipped_weekly (the rule's weekly maximum) or skipped_org_budget (the team's org budget).",
      amount_pico: "The rule's top-up amount in pico-USD.",
      limit_before_pico: "The key's limit before, in pico-USD.",
      limit_after_pico: "The key's limit after; the same as before when skipped.",
      spent_pico: { purpose: "The key's spend counted against its limit when checked, in pico-USD.", request: "aggregate" },
      available_pico: { purpose: "The account's balance minus open holds when checked, in pico-USD.", request: "aggregate" },
      week_start: "UTC Monday 00:00 of the week the top-up counts in.",
      week_total_pico: "Top-ups added to the key that week, including this one when added, in pico-USD.",
      max_per_week_pico: "The rule's weekly maximum, in pico-USD.",
      created_at: CREATED,
    },
  },

  byok_keys: {
    category: "keys",
    purpose: "A provider API key an account brought so calls to that provider use its own account there. Stored encrypted; only the router can decrypt it, to make calls for that account.",
    request: "no",
    retention: "Kept until the owner deletes it (DELETE /api/v1/byok/:provider removes the row).",
    columns: {
      id: "Row number, counting up from 1.",
      account_id: "The account that brought the key.",
      provider_id: "The provider the key is for.",
      key_enc: "The provider key, AES-256-GCM encrypted with the router's APP_SECRET.",
      label: "A masked label so the owner can tell keys apart.",
      created_at: CREATED,
    },
  },





  agent_sessions: {
    category: "keys",
    purpose: "A short-lived sub-key for one agent run, with its own budget and expiry, so an agent's spending can be capped and ended.",
    request: "no",
    retention: "Ended sessions keep their row; a session ends at its expiry, when its budget is spent or when its owner ends it.",
    columns: {
      id: "Session id.",
      account_id: "The account the session belongs to.",
      parent_key_hash: "The key that created the session.",
      key_hash: "The session's own key hash (a row in keys).",
      name: "A label the creator gave the session.",
      budget: "The session's spend cap in pico-USD; empty means only the parent key's limits apply.",
      expires_at: "When the session ends by itself.",
      ended_at: "When it ended.",
      end_reason: "ended, expired or budget.",
      metadata: {
        purpose: "Labels the creator attached to the session: up to 32 short string, number or boolean values, 2 KB in all.",
        review: rv(["type:json"], "config", "checkMetadata refuses key names that look like prompt or completion text (such as prompt or messages), at most 32 keys, string values of at most 256 characters and 2,048 bytes in all. It cannot judge what a creator types into a value, so the text is whatever the creator wrote."),
      },
      created_at: CREATED,
    },
  },



};


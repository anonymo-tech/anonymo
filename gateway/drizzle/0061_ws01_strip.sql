-- WS01: strip the gateway to what the Anonymo spec uses. Drops the tables of the removed Anonymo modules (agents,
-- agreements, the open host network, the transparency log, Oblivious HTTP and blind tokens, skills, the commerce
-- ledger, teams, identity, the paid tool market, pay-with-stock and the stock escrow, make-good refunds, low-balance
-- alerts, Telegram weekly summaries) and the columns only they read. CASCADE also removes their triggers and indexes. Nothing a kept table
-- references is dropped; keys, accounts, ledger and generations stay. The OFAC list now lives in anonymo_sanctions (WS05).
DROP TABLE IF EXISTS "agent_action_decisions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_approvals" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_feedback" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_identities" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_ledger_links" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_liveness" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_payments" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_policies" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_policy_events" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_profiles" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_track_records" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agreement_cursor" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agreement_events" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agreement_evidence" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agreement_jury" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agreement_projection" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "blind_keys" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "blind_nullifiers" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "commerce_transfers" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "escrow_deposits" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "host_anchor_leaves" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "host_anchors" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "host_bond_cursor" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "host_bond_events" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "host_bond_projection" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "host_policies" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "host_slash_evidence" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "low_balance_alerts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "makegood_payouts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "makegood_refunds" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "network_fee_ledger" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "network_payout_dispatch" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "network_receipt_links" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "network_waitlist" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "ohttp_keys" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "paywith_debts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "paywith_sessions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "paywith_swaps" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "playbook_changes" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "playbooks" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "sanctions_addresses" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "sanctions_meta" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "skill_installs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "skills" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "team_audit" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "team_members" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "team_principals" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "teams" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "tlog_checkpoints" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "tlog_cosignatures" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "tlog_entries" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "tlog_rekor_anchors" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "tool_calls" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "tool_canary_runs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "tool_listings" CASCADE;
--> statement-breakpoint
DROP FUNCTION IF EXISTS team_audit_append_only() CASCADE;
--> statement-breakpoint
DROP INDEX IF EXISTS "providers_network_wallet_endpoint_uq";
--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN IF EXISTS "network_host";
--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN IF EXISTS "network_models";
--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN IF EXISTS "network_reasons";
--> statement-breakpoint
ALTER TABLE "keys" DROP COLUMN IF EXISTS "team_id";
--> statement-breakpoint
ALTER TABLE "keys" DROP COLUMN IF EXISTS "pay_with_default";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "low_balance_pico";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "low_balance_alerted";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "last_sent_week";
--> statement-breakpoint
ALTER TABLE "kv" DROP COLUMN IF EXISTS "weekly_summary_opted_in";

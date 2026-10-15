-- Production promotional usage credit, distinct from USDC deposits and internal
-- test credit. This migration creates no campaign and grants no credit.
-- The operator must insert the one fixed campaign after the release is ready.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$'
    OR definition NOT LIKE '%burn_reserve%' OR definition NOT LIKE '%token_float%'
    OR definition LIKE '%balance_usd6%' OR definition LIKE '%promotional_funding%' THEN
    RAISE EXCEPTION 'Unexpected ledger account ownership constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
  EXECUTE format('ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check CHECK ((%s) OR (owner_id IS NULL AND kind=%L))',
    substring(definition FROM '^CHECK \((.*)\)$'),'promotional_funding');
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_kind_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$'
    OR definition NOT LIKE '%burn_reserve%' OR definition NOT LIKE '%token_float%'
    OR definition LIKE '%owner_id%' OR definition LIKE '%promotional_funding%' THEN
    RAISE EXCEPTION 'Unexpected ledger account kind constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
  EXECUTE format('ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK ((%s) OR kind=%L)',
    substring(definition FROM '^CHECK \((.*)\)$'),'promotional_funding');
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_transactions'::regclass AND conname='ledger_transactions_kind_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$'
    OR definition NOT LIKE '%token_deposit%' OR definition LIKE '%promotional_credit%' THEN
    RAISE EXCEPTION 'Unexpected ledger transaction kind constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
  EXECUTE format('ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK ((%s) OR kind=%L)',
    substring(definition FROM '^CHECK \((.*)\)$'),'promotional_credit');
END;
$$;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_promotional_funding_debit
  CHECK (kind<>'promotional_funding' OR balance_usd6<=0);
INSERT INTO ledger_accounts(id,owner_id,kind) VALUES(gen_random_uuid(),NULL,'promotional_funding')
  ON CONFLICT(owner_id,kind) DO NOTHING;

CREATE TABLE wallet_welcome_campaigns (
  id text PRIMARY KEY CHECK(id='wallet-welcome-2026-10-14'),
  amount_usd6 bigint NOT NULL CHECK(amount_usd6=5000000),
  max_grants integer NOT NULL CHECK(max_grants=20),
  budget_usd6 bigint NOT NULL CHECK(budget_usd6=100000000 AND budget_usd6=amount_usd6*max_grants),
  enabled boolean NOT NULL DEFAULT false,
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_wallet_welcome_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Welcome campaigns cannot be deleted or reset' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    (to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled')
    OR (OLD.enabled=false AND NEW.enabled=true)) THEN
    RAISE EXCEPTION 'Welcome campaign terms are immutable; an active campaign may only be paused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallet_welcome_campaign_guard BEFORE UPDATE OR DELETE ON wallet_welcome_campaigns
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_welcome_campaign();

CREATE TABLE wallet_welcome_grants (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  identity_id uuid NOT NULL UNIQUE REFERENCES identities(id),
  wallet_address text NOT NULL UNIQUE CHECK(wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  campaign_id text NOT NULL REFERENCES wallet_welcome_campaigns(id),
  amount_usd6 bigint NOT NULL CHECK(amount_usd6=5000000),
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX wallet_welcome_grants_campaign ON wallet_welcome_grants(campaign_id);
CREATE TRIGGER immutable_wallet_welcome_grants BEFORE UPDATE OR DELETE ON wallet_welcome_grants
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Every insertion, including one bypassing the TS helper, serializes on the
-- campaign row before counting immutable grants. There is no resettable counter.
CREATE FUNCTION guard_wallet_welcome_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign record; eligible boolean; granted bigint;
BEGIN
  SELECT * INTO campaign FROM wallet_welcome_campaigns WHERE id=NEW.campaign_id FOR UPDATE;
  IF campaign.id IS NULL OR NOT campaign.enabled OR campaign.starts_at>clock_timestamp()
    OR NEW.amount_usd6<>campaign.amount_usd6 THEN
    RAISE EXCEPTION 'Welcome campaign unavailable' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM accounts a JOIN identities i ON i.account_id=a.id
    WHERE a.id=NEW.account_id AND i.id=NEW.identity_id AND i.subject=NEW.wallet_address
      AND i.kind='solana' AND i.revoked_at IS NULL AND a.disabled_at IS NULL
      AND a.created_at>=campaign.starts_at AND i.created_at>=campaign.starts_at
      AND a.created_at=transaction_timestamp() AND i.created_at=transaction_timestamp()
      AND a.xmin::text=pg_current_xact_id()::text AND i.xmin::text=pg_current_xact_id()::text
  ) INTO eligible;
  IF NOT eligible THEN
    RAISE EXCEPTION 'Welcome credit requires a newly created wallet account in this transaction' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO granted FROM wallet_welcome_grants WHERE campaign_id=NEW.campaign_id;
  IF granted>=campaign.max_grants OR (granted+1)*NEW.amount_usd6>campaign.budget_usd6 THEN
    RAISE EXCEPTION 'Welcome campaign limit reached' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallet_welcome_grant_guard BEFORE INSERT ON wallet_welcome_grants
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_welcome_grant();

CREATE FUNCTION guard_promotional_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_kind text; account_kind text; account_owner uuid;
BEGIN
  SELECT kind INTO transaction_kind FROM ledger_transactions WHERE id=NEW.transaction_id;
  SELECT kind,owner_id INTO account_kind,account_owner FROM ledger_accounts WHERE id=NEW.ledger_account_id;
  IF (account_kind='promotional_funding' OR transaction_kind='promotional_credit') AND NOT (
    transaction_kind='promotional_credit' AND (
      (account_kind='promotional_funding' AND account_owner IS NULL AND NEW.amount_usd6<0) OR
      (account_kind='available' AND account_owner IS NOT NULL AND NEW.amount_usd6>0))) THEN
    RAISE EXCEPTION 'Promotional credit requires its own funding account and an available balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER promotional_credit_entry_guard BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION guard_promotional_credit_entry();

CREATE FUNCTION assert_wallet_welcome_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; grant_row record; posted record; entry_count bigint; credited numeric; debited numeric;
BEGIN
  IF TG_TABLE_NAME='ledger_transactions' THEN target:=NEW.id; ELSE target:=NEW.ledger_transaction_id; END IF;
  SELECT * INTO grant_row FROM wallet_welcome_grants WHERE ledger_transaction_id=target;
  SELECT * INTO posted FROM ledger_transactions WHERE id=target;
  IF grant_row.account_id IS NULL OR posted.id IS NULL OR posted.kind<>'promotional_credit'
    OR posted.reference<>'wallet-welcome:'||grant_row.campaign_id||':'||grant_row.account_id::text THEN
    RAISE EXCEPTION 'Promotional credit must have its immutable welcome grant' USING ERRCODE='23514';
  END IF;
  SELECT count(*),
    sum(e.amount_usd6) FILTER(WHERE a.kind='available' AND a.owner_id=grant_row.account_id),
    sum(e.amount_usd6) FILTER(WHERE a.kind='promotional_funding' AND a.owner_id IS NULL)
    INTO entry_count,credited,debited
    FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id WHERE e.transaction_id=target;
  IF entry_count<>2 OR credited IS DISTINCT FROM grant_row.amount_usd6::numeric
    OR debited IS DISTINCT FROM -grant_row.amount_usd6::numeric THEN
    RAISE EXCEPTION 'Welcome grant must match exactly two balanced promotional entries' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER wallet_welcome_credit_transaction AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='promotional_credit')
  EXECUTE FUNCTION assert_wallet_welcome_credit();
CREATE CONSTRAINT TRIGGER wallet_welcome_credit_grant AFTER INSERT ON wallet_welcome_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_welcome_credit();

ALTER TABLE wallet_welcome_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_welcome_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wallet_welcome_campaigns,wallet_welcome_grants FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_wallet_welcome_campaign(),guard_wallet_welcome_grant(),guard_promotional_credit_entry(),assert_wallet_welcome_credit() FROM PUBLIC;
-- Existing hosted installations attach exactly their service-role policy.
DO $$ BEGIN
  IF to_regprocedure('apply_row_security()') IS NOT NULL THEN PERFORM apply_row_security(); END IF;
END; $$;

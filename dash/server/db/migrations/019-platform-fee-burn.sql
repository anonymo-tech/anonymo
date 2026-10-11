-- Platform fee and platform-token buyback-and-burn reserve: off-chain accrual only.
-- A quote may carry immutable platform-fee terms fixed when it is created. A
-- capture under those terms charges the base usage amount plus the platform
-- fee, records that split, and moves the burn share of the fee from platform
-- revenue into one platform burn-reserve account. Nothing here creates a
-- token, swaps, burns on-chain or represents any market outcome. Quotes
-- without terms settle exactly as before. Balancing, entry linkage and
-- immutability are unchanged.

-- Extend the existing kind and ownership checks in place: each becomes
-- (existing definition) OR (new kind), so kinds added by earlier migrations
-- stay valid without being restated here.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%(owner_id IS NULL)%'
    OR definition LIKE '%balance_usd6%' OR definition LIKE '%burn_reserve%' THEN
    RAISE EXCEPTION 'Unexpected ledger account ownership constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
  EXECUTE format(
    'ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check CHECK ((%s) OR (owner_id IS NULL AND kind = %L))',
    substring(definition FROM '^CHECK \((.*)\)$'), 'burn_reserve');

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_kind_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%''available''%'
    OR definition LIKE '%owner_id%' OR definition LIKE '%balance_usd6%' OR definition LIKE '%burn_reserve%' THEN
    RAISE EXCEPTION 'Unexpected ledger account kind constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
  EXECUTE format(
    'ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK ((%s) OR kind = %L)',
    substring(definition FROM '^CHECK \((.*)\)$'), 'burn_reserve');

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_transactions'::regclass AND conname='ledger_transactions_kind_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%''capture''%'
    OR definition LIKE '%burn_accrual%' THEN
    RAISE EXCEPTION 'Unexpected ledger transaction kind constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
  EXECUTE format(
    'ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK ((%s) OR kind = %L)',
    substring(definition FROM '^CHECK \((.*)\)$'), 'burn_accrual');
END;
$$;

-- The reserve only accumulates until a reviewed on-chain burn path exists.
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_burn_reserve_nonnegative
  CHECK (kind <> 'burn_reserve' OR balance_usd6 >= 0);
INSERT INTO ledger_accounts(id,owner_id,kind) VALUES (gen_random_uuid(),NULL,'burn_reserve')
  ON CONFLICT (owner_id,kind) DO NOTHING;

-- A burn accrual moves platform revenue (debit) into the burn reserve (credit),
-- and the burn reserve takes part in nothing else. Spending the reserve on an
-- on-chain buyback requires a later, separately reviewed migration.
CREATE FUNCTION guard_burn_reserve_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_kind text; account_kind text; account_owner uuid;
BEGIN
  SELECT kind INTO transaction_kind FROM ledger_transactions WHERE id=NEW.transaction_id;
  SELECT kind,owner_id INTO account_kind,account_owner FROM ledger_accounts WHERE id=NEW.ledger_account_id;
  IF (account_kind='burn_reserve' OR transaction_kind='burn_accrual') AND NOT (
    transaction_kind='burn_accrual' AND account_owner IS NULL AND (
      (account_kind='burn_reserve' AND NEW.amount_usd6>0) OR
      (account_kind='revenue' AND NEW.amount_usd6<0))) THEN
    RAISE EXCEPTION 'A burn accrual may only move platform revenue into the burn reserve' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_burn_reserve_entry BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION guard_burn_reserve_entry();

-- Quote terms. The fee maximum is floor(base maximum x fee bps / 10000), and
-- the quote's maximum (and therefore its hold) is base maximum + fee maximum.
CREATE TABLE quote_platform_fees (
  quote_id uuid PRIMARY KEY REFERENCES quotes(id),
  base_maximum_usd6 bigint NOT NULL CHECK (base_maximum_usd6 > 0),
  platform_fee_bps integer NOT NULL CHECK (platform_fee_bps BETWEEN 1 AND 2000),
  burn_share_bps integer NOT NULL CHECK (burn_share_bps BETWEEN 0 AND 10000),
  platform_fee_maximum_usd6 bigint NOT NULL CHECK (platform_fee_maximum_usd6 >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (platform_fee_maximum_usd6 = div(base_maximum_usd6::numeric * platform_fee_bps, 10000))
);
CREATE TRIGGER immutable_quote_platform_fees BEFORE UPDATE OR DELETE ON quote_platform_fees
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Terms are fixed in the transaction that creates the quote, before any reservation.
CREATE FUNCTION check_quote_platform_fee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quotes q WHERE q.id=NEW.quote_id AND q.xmin=pg_current_xact_id()::xid
      AND q.max_usd6=NEW.base_maximum_usd6+NEW.platform_fee_maximum_usd6)
    OR EXISTS (SELECT 1 FROM holds WHERE quote_id=NEW.quote_id) THEN
    RAISE EXCEPTION 'Platform fee terms must be fixed with their quote' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_quote_platform_fee BEFORE INSERT ON quote_platform_fees
  FOR EACH ROW EXECUTE FUNCTION check_quote_platform_fee();

-- Per-capture split. Captured = base + fee; fee = floor(base x fee bps / 10000);
-- burn reserve = ceil(fee x burn share bps / 10000); the rest of the fee stays
-- in revenue. Zero-cost settlements release the whole hold and record nothing.
-- created_at is transaction time, like ledger entries, so period cutoffs agree.
CREATE TABLE hold_platform_fees (
  hold_id uuid PRIMARY KEY REFERENCES holds(id),
  quote_id uuid NOT NULL REFERENCES quote_platform_fees(quote_id),
  base_usd6 bigint NOT NULL CHECK (base_usd6 > 0),
  platform_fee_usd6 bigint NOT NULL CHECK (platform_fee_usd6 >= 0),
  burn_reserve_usd6 bigint NOT NULL CHECK (burn_reserve_usd6 >= 0 AND burn_reserve_usd6 <= platform_fee_usd6),
  ledger_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((burn_reserve_usd6 = 0) = (ledger_transaction_id IS NULL))
);
CREATE INDEX hold_platform_fees_created ON hold_platform_fees (created_at);
CREATE TRIGGER immutable_hold_platform_fees BEFORE UPDATE OR DELETE ON hold_platform_fees
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE FUNCTION check_hold_platform_fee() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terms quote_platform_fees; entry_count bigint; credited numeric; debited numeric;
BEGIN
  SELECT * INTO terms FROM quote_platform_fees WHERE quote_id=NEW.quote_id;
  IF terms.quote_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM holds h WHERE h.id=NEW.hold_id AND h.quote_id=NEW.quote_id AND h.state='captured'
        AND h.captured_usd6=NEW.base_usd6+NEW.platform_fee_usd6 AND h.xmin=pg_current_xact_id()::xid)
    OR NEW.base_usd6 > terms.base_maximum_usd6
    OR NEW.platform_fee_usd6 <> div(NEW.base_usd6::numeric * terms.platform_fee_bps, 10000)
    OR NEW.burn_reserve_usd6 <> div(NEW.platform_fee_usd6::numeric * terms.burn_share_bps + 9999, 10000) THEN
    RAISE EXCEPTION 'Platform fee settlement does not match its quote terms and hold' USING ERRCODE='23514';
  END IF;
  IF NEW.ledger_transaction_id IS NOT NULL THEN
    SELECT count(*),
      sum(e.amount_usd6) FILTER (WHERE a.kind='burn_reserve' AND a.owner_id IS NULL),
      sum(e.amount_usd6) FILTER (WHERE a.kind='revenue' AND a.owner_id IS NULL)
      INTO entry_count,credited,debited
      FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id
      JOIN ledger_accounts a ON a.id=e.ledger_account_id
      WHERE t.id=NEW.ledger_transaction_id AND t.kind='burn_accrual'
        AND t.reference='burn-accrual:' || NEW.hold_id::text;
    IF entry_count<>2 OR credited IS DISTINCT FROM NEW.burn_reserve_usd6::numeric
      OR debited IS DISTINCT FROM -NEW.burn_reserve_usd6::numeric THEN
      RAISE EXCEPTION 'Platform fee settlement does not match its burn accrual' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_hold_platform_fee BEFORE INSERT ON hold_platform_fees
  FOR EACH ROW EXECUTE FUNCTION check_hold_platform_fee();

-- Every burn accrual has exactly one settlement record, and every capture
-- under platform-fee terms records its split before commit.
CREATE FUNCTION assert_burn_accrual_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hold_platform_fees WHERE ledger_transaction_id=NEW.id) THEN
    RAISE EXCEPTION 'A burn accrual requires its platform fee settlement record' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER burn_accrual_recorded AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='burn_accrual')
  EXECUTE FUNCTION assert_burn_accrual_recorded();

CREATE FUNCTION assert_hold_platform_fee_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM quote_platform_fees WHERE quote_id=NEW.quote_id)
    AND NOT EXISTS (SELECT 1 FROM hold_platform_fees WHERE hold_id=NEW.id) THEN
    RAISE EXCEPTION 'A capture under platform fee terms requires its settlement record' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER hold_platform_fee_recorded AFTER UPDATE ON holds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.state='captured' AND OLD.state IS DISTINCT FROM 'captured')
  EXECUTE FUNCTION assert_hold_platform_fee_recorded();

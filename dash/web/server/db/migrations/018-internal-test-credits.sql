-- Internal test credit: prepaid balance granted only for local internal testing.
-- It is never USDC, never a deposit and never chain evidence. One dedicated
-- system account funds every grant; each grant has a unique per-account
-- reference and may move value only from that account into the owner's
-- available balance. Balancing, entry linkage and immutability are unchanged.

-- Replace the original kind/ownership checks under their existing names, after
-- confirming that each name still identifies the expected constraint.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_check';
  IF definition IS NULL OR definition NOT LIKE '%(owner_id IS NOT NULL)%'
    OR definition NOT LIKE '%(owner_id IS NULL)%' OR definition LIKE '%balance_usd6%' THEN
    RAISE EXCEPTION 'Unexpected ledger account ownership constraint' USING ERRCODE='23514';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_kind_check';
  IF definition IS NULL OR definition NOT LIKE '%''available''%' OR definition LIKE '%owner_id%'
    OR definition LIKE '%balance_usd6%' THEN
    RAISE EXCEPTION 'Unexpected ledger account kind constraint' USING ERRCODE='23514';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_transactions'::regclass AND conname='ledger_transactions_kind_check';
  IF definition IS NULL OR definition NOT LIKE '%''deposit''%' OR definition NOT LIKE '%''capture''%' THEN
    RAISE EXCEPTION 'Unexpected ledger transaction kind constraint' USING ERRCODE='23514';
  END IF;
END;
$$;

ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check
  CHECK (kind IN ('available','reserved','clearing','revenue','internal_test_funding'));
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check
  CHECK ((owner_id IS NOT NULL AND kind IN ('available','reserved')) OR
         (owner_id IS NULL AND kind IN ('clearing','revenue','internal_test_funding')));
-- The funding account only ever issues credit.
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_internal_test_funding_debit
  CHECK (kind <> 'internal_test_funding' OR balance_usd6 <= 0);
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check
  CHECK (kind IN ('deposit','hold','capture','release','refund','internal_test_credit'));

CREATE TABLE internal_test_credit_grants (
  account_id uuid NOT NULL REFERENCES accounts(id),
  reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{2,95}$'),
  amount_usd6 bigint NOT NULL CHECK (amount_usd6 BETWEEN 1 AND 100000000),
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, reference)
);
CREATE TRIGGER immutable_internal_test_credit_grants BEFORE UPDATE OR DELETE ON internal_test_credit_grants
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- The funding account participates only in test-credit grants, and a grant
-- touches only that account (debit) and an owner's available balance (credit).
CREATE FUNCTION guard_internal_test_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_kind text; account_kind text;
BEGIN
  SELECT kind INTO transaction_kind FROM ledger_transactions WHERE id=NEW.transaction_id;
  SELECT kind INTO account_kind FROM ledger_accounts WHERE id=NEW.ledger_account_id;
  IF (account_kind='internal_test_funding' OR transaction_kind='internal_test_credit') AND NOT (
    transaction_kind='internal_test_credit' AND (
      (account_kind='internal_test_funding' AND NEW.amount_usd6<0) OR
      (account_kind='available' AND NEW.amount_usd6>0))) THEN
    RAISE EXCEPTION 'Internal test credit may only move from its funding account to an available balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_internal_test_credit_entry BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION guard_internal_test_credit_entry();

-- Every test-credit transaction has exactly one matching grant record, and the
-- grant's owner, amount and reference match the posted entries.
CREATE FUNCTION assert_internal_test_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; grant_row record; posted record; entry_count bigint; credited numeric; debited numeric;
BEGIN
  IF TG_TABLE_NAME='ledger_transactions' THEN target := NEW.id; ELSE target := NEW.ledger_transaction_id; END IF;
  SELECT * INTO grant_row FROM internal_test_credit_grants WHERE ledger_transaction_id=target;
  SELECT * INTO posted FROM ledger_transactions WHERE id=target;
  IF grant_row.account_id IS NULL OR posted.id IS NULL OR posted.kind<>'internal_test_credit'
    OR posted.reference <> 'internal-test-credit:' || grant_row.account_id::text || ':' || grant_row.reference THEN
    RAISE EXCEPTION 'Internal test credit grant does not match its ledger transaction' USING ERRCODE='23514';
  END IF;
  SELECT count(*),
    sum(e.amount_usd6) FILTER (WHERE a.kind='available' AND a.owner_id=grant_row.account_id),
    sum(e.amount_usd6) FILTER (WHERE a.kind='internal_test_funding' AND a.owner_id IS NULL)
    INTO entry_count, credited, debited
    FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id WHERE e.transaction_id=target;
  IF entry_count<>2 OR credited IS DISTINCT FROM grant_row.amount_usd6::numeric
    OR debited IS DISTINCT FROM -grant_row.amount_usd6::numeric THEN
    RAISE EXCEPTION 'Internal test credit grant does not match its ledger entries' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER internal_test_credit_transaction AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='internal_test_credit')
  EXECUTE FUNCTION assert_internal_test_credit();
CREATE CONSTRAINT TRIGGER internal_test_credit_grant AFTER INSERT ON internal_test_credit_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_internal_test_credit();

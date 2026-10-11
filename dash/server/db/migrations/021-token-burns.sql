-- Platform token burn executions: the only path that may spend the burn reserve.
-- Migration 019 lets the reserve accumulate and forbids every debit. This
-- migration adds one spending shape and nothing else: a `burn_execution`
-- transaction moves an amount out of `burn_reserve` into a new platform account
-- `burn_executed` (owner NULL, one seeded row, balance >= 0), and every such
-- transaction is bound to exactly one immutable `token_burns` row that names the
-- closed UTC period it settles, the price used, the token amounts and the
-- on-chain signatures. Nothing here contacts a chain, holds a key or implies a
-- market; it records what an executor did and refuses records that do not add
-- up. Rehearsals run on a local test validator; mainnet-beta records are
-- refused for simulated funding.

-- Extend the existing kind and ownership checks in place, exactly as 019 did:
-- each becomes (existing definition) OR (new kind). 019 must already have run
-- (the definitions mention burn_reserve) and this migration must not have.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%(owner_id IS NULL)%'
    OR definition NOT LIKE '%burn_reserve%' OR definition LIKE '%balance_usd6%' OR definition LIKE '%burn_executed%' THEN
    RAISE EXCEPTION 'Unexpected ledger account ownership constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
  EXECUTE format(
    'ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check CHECK ((%s) OR (owner_id IS NULL AND kind = %L))',
    substring(definition FROM '^CHECK \((.*)\)$'), 'burn_executed');

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_kind_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%''available''%'
    OR definition NOT LIKE '%burn_reserve%' OR definition LIKE '%owner_id%' OR definition LIKE '%balance_usd6%'
    OR definition LIKE '%burn_executed%' THEN
    RAISE EXCEPTION 'Unexpected ledger account kind constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
  EXECUTE format(
    'ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK ((%s) OR kind = %L)',
    substring(definition FROM '^CHECK \((.*)\)$'), 'burn_executed');

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_transactions'::regclass AND conname='ledger_transactions_kind_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%''capture''%'
    OR definition NOT LIKE '%burn_accrual%' OR definition LIKE '%burn_execution%' THEN
    RAISE EXCEPTION 'Unexpected ledger transaction kind constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
  EXECUTE format(
    'ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK ((%s) OR kind = %L)',
    substring(definition FROM '^CHECK \((.*)\)$'), 'burn_execution');
END;
$$;

-- The executed account only ever receives; its balance is the lifetime USD6
-- value the reserve has released to on-chain burns.
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_burn_executed_nonnegative
  CHECK (kind <> 'burn_executed' OR balance_usd6 >= 0);
INSERT INTO ledger_accounts(id,owner_id,kind) VALUES (gen_random_uuid(),NULL,'burn_executed')
  ON CONFLICT (owner_id,kind) DO NOTHING;

-- Entry guard, replacing 019's. Two shapes are allowed and nothing else touches
-- either platform account:
--   burn_accrual:   revenue (-)      -> burn_reserve (+)   [unchanged from 019]
--   burn_execution: burn_reserve (-) -> burn_executed (+)
-- A burn_execution can therefore hold at most one entry per account (the
-- UNIQUE (transaction_id, ledger_account_id) and the single seeded row of each
-- kind), and the balanced-transaction trigger makes the two amounts equal. The
-- 019 CHECK ledger_accounts_burn_reserve_nonnegative keeps the reserve from
-- ever going below zero, so no execution can spend more than has accrued.
CREATE OR REPLACE FUNCTION guard_burn_reserve_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_kind text; account_kind text; account_owner uuid;
BEGIN
  SELECT kind INTO transaction_kind FROM ledger_transactions WHERE id=NEW.transaction_id;
  SELECT kind,owner_id INTO account_kind,account_owner FROM ledger_accounts WHERE id=NEW.ledger_account_id;
  IF account_kind IN ('burn_reserve','burn_executed') OR transaction_kind IN ('burn_accrual','burn_execution') THEN
    IF account_owner IS NULL AND transaction_kind='burn_accrual' AND (
        (account_kind='burn_reserve' AND NEW.amount_usd6>0) OR
        (account_kind='revenue' AND NEW.amount_usd6<0)) THEN
      RETURN NEW;
    END IF;
    IF account_owner IS NULL AND transaction_kind='burn_execution' AND (
        (account_kind='burn_reserve' AND NEW.amount_usd6<0) OR
        (account_kind='burn_executed' AND NEW.amount_usd6>0)) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'The burn reserve may only be credited by a burn accrual or debited by a burn execution'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- One immutable record per execution. Amounts are integer: USD6 for money, raw
-- token units for the token (10^token_decimals per whole token), USD6 per whole
-- token for the price. `matured_usd6` is the reserve balance that had matured
-- for the period (credits before period_end minus all earlier executions) and
-- `spent_usd6` is what this execution released from the reserve, never more
-- than matured. Periods are closed whole UTC hours and may not overlap.
-- funding_source:
--   buyback-simulation  localnet/devnet rehearsal; tokens bought with a simulated
--                       swap and burned; the USDC leg is accounting only
--   token-deposits      tokens paid in directly were burned; nothing was bought
--   jupiter             a real mainnet swap (not implemented; refused upstream)
-- record_hash is the sha256 of the canonical JSON record built by the server
-- (see server/token/burn-ledger.ts); the database checks its shape only.
CREATE TABLE token_burns (
  id uuid PRIMARY KEY,
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  matured_usd6 bigint NOT NULL CHECK (matured_usd6 > 0),
  spent_usd6 bigint NOT NULL CHECK (spent_usd6 > 0 AND spent_usd6 <= matured_usd6),
  funding_source text NOT NULL CHECK (funding_source IN ('buyback-simulation','token-deposits','jupiter')),
  cluster text NOT NULL CHECK (cluster IN ('localnet','devnet','mainnet-beta')),
  token_mint text NOT NULL CHECK (token_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  token_program text NOT NULL CHECK (token_program IN ('spl-token','token-2022')),
  token_decimals smallint NOT NULL CHECK (token_decimals BETWEEN 0 AND 9),
  price_usd6_per_token bigint NOT NULL CHECK (price_usd6_per_token > 0),
  price_source text NOT NULL CHECK (price_source IN ('simulated','pool-twap','oracle')),
  tokens_bought_raw bigint NOT NULL CHECK (tokens_bought_raw >= 0),
  tokens_burned_raw bigint NOT NULL CHECK (tokens_burned_raw > 0),
  swap_signature text CHECK (swap_signature ~ '^[1-9A-HJ-NP-Za-km-z]{87,88}$'),
  burn_signature text NOT NULL UNIQUE CHECK (burn_signature ~ '^[1-9A-HJ-NP-Za-km-z]{87,88}$'),
  finalized_slot bigint NOT NULL CHECK (finalized_slot > 0),
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Whole UTC hours, properly ordered.
  CHECK (period_start < period_end),
  CHECK (date_trunc('hour',period_start AT TIME ZONE 'UTC')=period_start AT TIME ZONE 'UTC'
    AND date_trunc('hour',period_end AT TIME ZONE 'UTC')=period_end AT TIME ZONE 'UTC'),
  -- A buyback burns exactly what it bought and must have a swap; a deposit burn
  -- bought nothing and has no swap. A simulated price never backs a mainnet record.
  CHECK (funding_source <> 'buyback-simulation' OR (tokens_bought_raw = tokens_burned_raw AND swap_signature IS NOT NULL AND cluster <> 'mainnet-beta')),
  CHECK (funding_source <> 'jupiter' OR (tokens_bought_raw = tokens_burned_raw AND swap_signature IS NOT NULL)),
  CHECK (funding_source <> 'token-deposits' OR (tokens_bought_raw = 0 AND swap_signature IS NULL)),
  CHECK (price_source <> 'simulated' OR cluster <> 'mainnet-beta'),
  CHECK (swap_signature IS NULL OR swap_signature <> burn_signature),
  -- Never more tokens than the spent USD6 buys at the recorded price (rounded up).
  CHECK (tokens_bought_raw = 0 OR tokens_bought_raw::numeric * price_usd6_per_token
    < spent_usd6::numeric * power(10::numeric, token_decimals) + price_usd6_per_token),
  -- Periods never overlap (half-open ranges).
  EXCLUDE USING gist (tstzrange(period_start,period_end,'[)') WITH &&)
);
CREATE INDEX token_burns_created ON token_burns (created_at DESC, id DESC);
CREATE TRIGGER immutable_token_burns BEFORE UPDATE OR DELETE ON token_burns
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- A token_burns row is written in the same transaction as its burn_execution,
-- after the ledger entries, and must agree with them: the reserve debit equals
-- spent_usd6, the period has closed, and matured_usd6 is exactly what the
-- ledger says had matured (credits before period_end minus every earlier
-- execution). Recomputing maturity here means the server cannot overstate it.
CREATE FUNCTION check_token_burn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_count bigint; debited numeric; credited numeric; matured numeric;
BEGIN
  IF NEW.period_end > now() THEN
    RAISE EXCEPTION 'A burn period must be closed' USING ERRCODE='23514';
  END IF;
  SELECT count(*),
    sum(e.amount_usd6) FILTER (WHERE a.kind='burn_reserve' AND a.owner_id IS NULL),
    sum(e.amount_usd6) FILTER (WHERE a.kind='burn_executed' AND a.owner_id IS NULL)
    INTO entry_count,debited,credited
    FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id
    JOIN ledger_accounts a ON a.id=e.ledger_account_id
    WHERE t.id=NEW.ledger_transaction_id AND t.kind='burn_execution'
      AND t.xmin=pg_current_xact_id()::xid;
  IF entry_count<>2 OR debited IS DISTINCT FROM -NEW.spent_usd6::numeric
    OR credited IS DISTINCT FROM NEW.spent_usd6::numeric THEN
    RAISE EXCEPTION 'A token burn record must match its burn execution' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(e.amount_usd6) FILTER (WHERE e.amount_usd6>0),0)
    - COALESCE((SELECT sum(b.spent_usd6) FROM token_burns b WHERE b.id<>NEW.id),0)
    INTO matured
    FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id
    WHERE a.owner_id IS NULL AND a.kind='burn_reserve' AND e.created_at<NEW.period_end;
  IF matured IS DISTINCT FROM NEW.matured_usd6::numeric THEN
    RAISE EXCEPTION 'A token burn record must state the matured reserve exactly' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_token_burn BEFORE INSERT ON token_burns
  FOR EACH ROW EXECUTE FUNCTION check_token_burn();

-- Every burn execution has exactly one token burn record before commit, and
-- that record's spend equals the reserve debit. Together with the entry guard
-- this means the reserve can only ever be spent against a published record.
CREATE FUNCTION assert_burn_execution_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE records bigint; spent numeric; debited numeric;
BEGIN
  SELECT count(*),sum(spent_usd6) INTO records,spent FROM token_burns WHERE ledger_transaction_id=NEW.id;
  SELECT -sum(e.amount_usd6) INTO debited FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id
    WHERE e.transaction_id=NEW.id AND a.kind='burn_reserve' AND a.owner_id IS NULL;
  IF records<>1 OR spent IS DISTINCT FROM debited THEN
    RAISE EXCEPTION 'A burn execution requires exactly one matching token burn record' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER burn_execution_recorded AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='burn_execution')
  EXECUTE FUNCTION assert_burn_execution_recorded();

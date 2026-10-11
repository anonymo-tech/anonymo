-- Pay with the platform token: quote -> exact token transfer with a reference
-- -> finalized verification -> USD6 credit at the quoted value.
--
-- An intent fixes the token amount, the reference price and the USD6 credit
-- when it is created. The verified transfer must match those terms exactly.
-- Credits are ordinary non-transferable USD6 in the owner's available balance,
-- funded by one platform `token_float` account (owner NULL, one row) that
-- stands for the tokens the treasury has received against USD6 issued; it is
-- only ever debited here. Nothing here touches a chain, swaps or burns.
-- Balancing, entry linkage and immutability are unchanged.

-- Extend the existing kind and ownership checks in place: each becomes
-- (existing definition) OR (new kind), so kinds added by earlier migrations
-- stay valid without being restated here.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%(owner_id IS NULL)%'
    OR definition LIKE '%balance_usd6%' OR definition LIKE '%token_float%' THEN
    RAISE EXCEPTION 'Unexpected ledger account ownership constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
  EXECUTE format(
    'ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check CHECK ((%s) OR (owner_id IS NULL AND kind = %L))',
    substring(definition FROM '^CHECK \((.*)\)$'), 'token_float');

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_accounts'::regclass AND conname='ledger_accounts_kind_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%''available''%'
    OR definition LIKE '%owner_id%' OR definition LIKE '%balance_usd6%' OR definition LIKE '%token_float%' THEN
    RAISE EXCEPTION 'Unexpected ledger account kind constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
  EXECUTE format(
    'ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK ((%s) OR kind = %L)',
    substring(definition FROM '^CHECK \((.*)\)$'), 'token_float');

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='ledger_transactions'::regclass AND conname='ledger_transactions_kind_check';
  IF definition IS NULL OR definition !~ '^CHECK \(.*\)$' OR definition NOT LIKE '%''deposit''%'
    OR definition LIKE '%token_deposit%' THEN
    RAISE EXCEPTION 'Unexpected ledger transaction kind constraint' USING ERRCODE='23514';
  END IF;
  ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
  EXECUTE format(
    'ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK ((%s) OR kind = %L)',
    substring(definition FROM '^CHECK \((.*)\)$'), 'token_deposit');
END;
$$;

-- The float only ever issues credit (like clearing for USDC deposits).
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_token_float_debit
  CHECK (kind <> 'token_float' OR balance_usd6 <= 0);
INSERT INTO ledger_accounts(id,owner_id,kind) VALUES (gen_random_uuid(),NULL,'token_float')
  ON CONFLICT (owner_id,kind) DO NOTHING;

-- A token deposit moves value from the float (debit) into an owner's available
-- balance (credit), and the float takes part in nothing else.
CREATE FUNCTION guard_token_float_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_kind text; account_kind text; account_owner uuid;
BEGIN
  SELECT kind INTO transaction_kind FROM ledger_transactions WHERE id=NEW.transaction_id;
  SELECT kind,owner_id INTO account_kind,account_owner FROM ledger_accounts WHERE id=NEW.ledger_account_id;
  IF (account_kind='token_float' OR transaction_kind='token_deposit') AND NOT (
    transaction_kind='token_deposit' AND (
      (account_kind='token_float' AND account_owner IS NULL AND NEW.amount_usd6<0) OR
      (account_kind='available' AND account_owner IS NOT NULL AND NEW.amount_usd6>0))) THEN
    RAISE EXCEPTION 'A token deposit may only move value from the token float into an available balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_token_float_entry BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION guard_token_float_entry();

-- Quoted terms. amount_raw is the exact raw token amount the payer must send:
-- ceil(usd6 x 10^decimals / price), so its value at the quoted price is never
-- below the credit. state: pending -> credited | expired; expired -> credited
-- is allowed because the verifier binds the payment's block time to the
-- window, so a late verification of an in-window transfer still credits.
CREATE TABLE token_deposit_intents (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  source_wallet text NOT NULL CHECK (source_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  cluster text NOT NULL CHECK (cluster IN ('localnet','devnet','mainnet-beta')),
  token_mint text NOT NULL CHECK (token_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  token_program text NOT NULL CHECK (token_program IN ('spl-token','token-2022')),
  decimals integer NOT NULL CHECK (decimals BETWEEN 0 AND 9),
  recipient_wallet text NOT NULL CHECK (recipient_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  recipient_token_account text NOT NULL CHECK (recipient_token_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  amount_raw bigint NOT NULL CHECK (amount_raw > 0),
  usd6 bigint NOT NULL CHECK (usd6 > 0),
  price_usd6_per_token bigint NOT NULL CHECK (price_usd6_per_token > 0),
  price_source text NOT NULL CHECK (price_source IN ('simulated','pool-twap','oracle')),
  price_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','credited','expired')),
  credited_signature text UNIQUE CHECK (credited_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  credited_slot bigint CHECK (credited_slot >= 0),
  ledger_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  CHECK (expires_at > created_at),
  CHECK (price_observed_at <= created_at),
  CHECK ((state='credited') = (credited_signature IS NOT NULL)),
  CHECK ((state='credited') = (credited_slot IS NOT NULL)),
  CHECK ((state='credited') = (ledger_transaction_id IS NOT NULL)),
  CHECK (source_wallet NOT IN (reference,token_mint,recipient_wallet,recipient_token_account)
    AND reference NOT IN (token_mint,recipient_wallet,recipient_token_account)
    AND token_mint NOT IN (recipient_wallet,recipient_token_account)
    AND recipient_wallet <> recipient_token_account),
  CHECK (amount_raw = div(usd6::numeric * (10::numeric ^ decimals) + price_usd6_per_token - 1, price_usd6_per_token)),
  CHECK (div(amount_raw::numeric * price_usd6_per_token, 10::numeric ^ decimals) >= usd6)
);
CREATE INDEX token_deposit_intents_owner ON token_deposit_intents(account_id,created_at DESC,id DESC);
CREATE INDEX token_deposit_intents_open ON token_deposit_intents(expires_at) WHERE state='pending';

-- One verified transfer per intent; one credit per (cluster, signature, instruction).
CREATE TABLE token_deposit_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^token:(localnet|devnet|mainnet-beta):[1-9A-HJ-NP-Za-km-z]{64,88}:[0-9]{1,2}$'),
  intent_id uuid NOT NULL UNIQUE REFERENCES token_deposit_intents(id),
  cluster text NOT NULL CHECK (cluster IN ('localnet','devnet','mainnet-beta')),
  signature text NOT NULL CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  instruction_index integer NOT NULL CHECK (instruction_index >= 0),
  amount_raw bigint NOT NULL CHECK (amount_raw > 0),
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  slot bigint NOT NULL CHECK (slot >= 0),
  block_time bigint NOT NULL CHECK (block_time >= 0),
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(cluster,signature,instruction_index),
  CHECK (event_id = 'token:' || cluster || ':' || signature || ':' || instruction_index::text)
);
CREATE TRIGGER immutable_token_deposit_events BEFORE UPDATE OR DELETE ON token_deposit_events
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- The event's ledger transaction is created in the same database transaction,
-- is a `token_deposit` referencing this event, and moves exactly the intent's
-- quoted usd6 from the float into the intent owner's available balance. The
-- transfer's amount and network match the intent's terms.
CREATE FUNCTION check_token_deposit_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent token_deposit_intents; entry_count bigint; credited numeric; debited numeric;
BEGIN
  SELECT * INTO intent FROM token_deposit_intents WHERE id=NEW.intent_id;
  IF intent.id IS NULL OR intent.state='credited' OR intent.cluster<>NEW.cluster
    OR intent.amount_raw<>NEW.amount_raw
    OR to_timestamp(NEW.block_time) < date_trunc('second',intent.created_at)
    OR to_timestamp(NEW.block_time) >= date_trunc('second',intent.expires_at) THEN
    RAISE EXCEPTION 'Token deposit event does not match its intent terms' USING ERRCODE='23514';
  END IF;
  SELECT count(*),
    sum(e.amount_usd6) FILTER (WHERE a.kind='available' AND a.owner_id=intent.account_id),
    sum(e.amount_usd6) FILTER (WHERE a.kind='token_float' AND a.owner_id IS NULL)
    INTO entry_count,credited,debited
    FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id
    JOIN ledger_accounts a ON a.id=e.ledger_account_id
    WHERE t.id=NEW.ledger_transaction_id AND t.kind='token_deposit'
      AND t.reference='token-deposit:' || NEW.event_id AND t.xmin=pg_current_xact_id()::xid;
  IF entry_count<>2 OR credited IS DISTINCT FROM intent.usd6::numeric
    OR debited IS DISTINCT FROM -intent.usd6::numeric THEN
    RAISE EXCEPTION 'Token deposit credit does not equal the quoted usd6' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_token_deposit_event BEFORE INSERT ON token_deposit_events
  FOR EACH ROW EXECUTE FUNCTION check_token_deposit_event();

-- Terms are immutable. Only the state and the credit evidence may change:
-- pending -> expired once the window has closed, and pending/expired ->
-- credited together with the event row written in this transaction.
CREATE FUNCTION preserve_token_deposit_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Token deposit intents cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','credited_signature','credited_slot','ledger_transaction_id'])
    IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','credited_signature','credited_slot','ledger_transaction_id'])
    OR OLD.state='credited' THEN
    RAISE EXCEPTION 'Token deposit terms are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state='expired' THEN
    IF OLD.state<>'pending' OR OLD.expires_at>clock_timestamp()
      OR NEW.credited_signature IS NOT NULL OR NEW.credited_slot IS NOT NULL OR NEW.ledger_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'A token deposit intent expires only after its window closes' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state='credited' THEN
    IF NOT EXISTS (SELECT 1 FROM token_deposit_events e WHERE e.intent_id=NEW.id
        AND e.cluster=NEW.cluster AND e.signature=NEW.credited_signature AND e.slot=NEW.credited_slot
        AND e.ledger_transaction_id=NEW.ledger_transaction_id AND e.xmin=pg_current_xact_id()::xid) THEN
      RAISE EXCEPTION 'A credited token deposit must match its verified event' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Invalid token deposit state transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_token_deposit_terms BEFORE UPDATE OR DELETE ON token_deposit_intents
  FOR EACH ROW EXECUTE FUNCTION preserve_token_deposit_terms();

-- Every token deposit ledger transaction has its event, and every event's
-- intent is marked credited with that event before commit.
CREATE FUNCTION assert_token_deposit_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM token_deposit_events WHERE ledger_transaction_id=NEW.id) THEN
    RAISE EXCEPTION 'A token deposit requires its verified event record' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER token_deposit_recorded AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='token_deposit')
  EXECUTE FUNCTION assert_token_deposit_recorded();

CREATE FUNCTION assert_token_deposit_credited() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM token_deposit_intents WHERE id=NEW.intent_id AND state='credited'
      AND credited_signature=NEW.signature AND ledger_transaction_id=NEW.ledger_transaction_id) THEN
    RAISE EXCEPTION 'A verified token deposit must credit its intent' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER token_deposit_credited AFTER INSERT ON token_deposit_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_token_deposit_credited();

CREATE TABLE deposit_intents (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  source_wallet text NOT NULL,
  reference text NOT NULL UNIQUE,
  amount_usd6 bigint NOT NULL CHECK (amount_usd6 > 0),
  policy jsonb NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN ('awaiting_payment','credited')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deposit_intents_owner ON deposit_intents(account_id,created_at DESC);

CREATE TABLE deposit_events (
  event_id text PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES deposit_intents(id),
  cluster text NOT NULL CHECK (cluster IN ('devnet','mainnet-beta')),
  signature text NOT NULL,
  instruction_index integer NOT NULL CHECK (instruction_index >= 0),
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  slot bigint NOT NULL,
  block_time bigint NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(cluster,signature,instruction_index)
);

CREATE FUNCTION preserve_deposit_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') OR OLD.state='credited' THEN
    RAISE EXCEPTION 'Deposit terms are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_deposit_terms BEFORE UPDATE ON deposit_intents
  FOR EACH ROW EXECUTE FUNCTION preserve_deposit_terms();
CREATE TRIGGER immutable_deposit_events BEFORE UPDATE OR DELETE ON deposit_events
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

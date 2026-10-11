-- Bind an owner's retry key to the original immutable intent without rewriting
-- historical deposit rows. Old intents remain recoverable through owned listing.
CREATE TABLE deposit_intent_requests (
  account_id uuid NOT NULL REFERENCES accounts(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-zA-Z0-9_-]{16,128}$'),
  intent_id uuid NOT NULL UNIQUE REFERENCES deposit_intents(id),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id,idempotency_key)
);
CREATE INDEX deposit_intents_owner_cursor ON deposit_intents(account_id,created_at DESC,id DESC);

CREATE FUNCTION guard_deposit_request_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM deposit_intents WHERE id=NEW.intent_id AND account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Deposit request owner mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deposit_request_owner BEFORE INSERT ON deposit_intent_requests
  FOR EACH ROW EXECUTE FUNCTION guard_deposit_request_owner();
CREATE TRIGGER immutable_deposit_request BEFORE UPDATE OR DELETE ON deposit_intent_requests
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

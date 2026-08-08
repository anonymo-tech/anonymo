-- One immutable payment message per deposit intent. A submitted marker records
-- an attempt before network I/O; it is not proof of broadcast or settlement.
CREATE TABLE deposit_payments (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES deposit_intents(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','submitted','finalized','failed','expired')),
  source_token_account text NOT NULL CHECK(source_token_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  message_base64 text NOT NULL CHECK(length(message_base64)=332 AND message_base64 ~ '^[A-Za-z0-9+/]+==$'),
  unsigned_transaction text NOT NULL CHECK(length(unsigned_transaction)=416 AND unsigned_transaction ~ '^[A-Za-z0-9+/]+$'),
  recent_blockhash text NOT NULL CHECK(recent_blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  last_valid_block_height bigint NOT NULL CHECK(last_valid_block_height BETWEEN 1 AND 9007199254740991),
  context_slot bigint NOT NULL CHECK(context_slot BETWEEN 0 AND 9007199254740991),
  fee_lamports bigint NOT NULL CHECK(fee_lamports BETWEEN 1 AND 1000000),
  prepared_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>prepared_at AND expires_at<=prepared_at+interval '90 seconds'),
  signed_transaction text CHECK(length(signed_transaction)=416 AND signed_transaction ~ '^[A-Za-z0-9+/]+$'),
  signature text UNIQUE CHECK(signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  submitted_at timestamptz,
  acknowledged_at timestamptz,
  finalized_at timestamptz,
  failure_code text CHECK(failure_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  CHECK((signed_transaction IS NULL)=(signature IS NULL)),
  CHECK((signed_transaction IS NULL)=(submitted_at IS NULL)),
  CHECK(submitted_at IS NULL OR (submitted_at>=prepared_at AND submitted_at<expires_at)),
  CHECK(acknowledged_at IS NULL OR (submitted_at IS NOT NULL AND acknowledged_at>=submitted_at)),
  CHECK((state='finalized')=(finalized_at IS NOT NULL)),
  CHECK(finalized_at IS NULL OR finalized_at>=prepared_at),
  CHECK(state NOT IN ('submitted','failed') OR signed_transaction IS NOT NULL),
  CHECK(state<>'prepared' OR signed_transaction IS NULL),
  CHECK(failure_code IS NULL OR state IN ('failed','expired')),
  CHECK(octet_length(decode(message_base64,'base64'))=247),
  CHECK(octet_length(decode(unsigned_transaction,'base64'))=312),
  CHECK(substring(decode(unsigned_transaction,'base64') FROM 1 FOR 65)=decode('01'||repeat('00',64),'hex')),
  CHECK(substring(decode(unsigned_transaction,'base64') FROM 66)=decode(message_base64,'base64')),
  CHECK(signed_transaction IS NULL OR (octet_length(decode(signed_transaction,'base64'))=312
    AND get_byte(decode(signed_transaction,'base64'),0)=1
    AND substring(decode(signed_transaction,'base64') FROM 66)=decode(message_base64,'base64')))
);
CREATE INDEX deposit_payments_owner ON deposit_payments(account_id,prepared_at DESC,id DESC);

CREATE FUNCTION guard_deposit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent record;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Deposit payment attempts cannot be deleted' USING ERRCODE='23514';
  END IF;
  SELECT * INTO intent FROM deposit_intents WHERE id=NEW.intent_id;
  IF intent.id IS NULL OR intent.account_id<>NEW.account_id OR NEW.expires_at>intent.expires_at
    OR NEW.source_token_account IN (intent.source_wallet,intent.reference,intent.policy->>'usdcMint',intent.policy->>'recipientTokenAccount',intent.policy->>'recipientWallet') THEN
    RAISE EXCEPTION 'Deposit payment ownership or terms mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.state='finalized' AND NOT EXISTS(SELECT 1 FROM deposit_events WHERE intent_id=NEW.intent_id AND signature=NEW.signature) THEN
    RAISE EXCEPTION 'Finalized payment must match the credited transaction' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'prepared' OR NEW.signed_transaction IS NOT NULL
      OR NEW.acknowledged_at IS NOT NULL OR NEW.finalized_at IS NOT NULL OR NEW.failure_code IS NOT NULL
      OR intent.state<>'awaiting_payment' OR intent.expires_at<=clock_timestamp()
      OR NEW.prepared_at>clock_timestamp() OR NEW.prepared_at<clock_timestamp()-interval '5 seconds'
      OR NEW.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Deposit payment must begin as a fresh prepared attempt' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','signed_transaction','signature','submitted_at','acknowledged_at','finalized_at','failure_code'])
      IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','signed_transaction','signature','submitted_at','acknowledged_at','finalized_at','failure_code']) THEN
      RAISE EXCEPTION 'Prepared deposit transaction is immutable' USING ERRCODE='23514';
    END IF;
    IF (OLD.signed_transaction IS NOT NULL AND
        ROW(NEW.signed_transaction,NEW.signature,NEW.submitted_at) IS DISTINCT FROM ROW(OLD.signed_transaction,OLD.signature,OLD.submitted_at))
      OR (OLD.signed_transaction IS NULL AND NEW.signed_transaction IS NOT NULL AND NOT(OLD.state='prepared' AND NEW.state='submitted'))
      OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
      OR (OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at)
      OR (OLD.failure_code IS NOT NULL AND NEW.failure_code IS DISTINCT FROM OLD.failure_code AND NEW.state<>'finalized') THEN
      RAISE EXCEPTION 'Deposit submission evidence is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT(
      (OLD.state='prepared' AND NEW.state IN ('submitted','expired'))
      OR (OLD.state='submitted' AND NEW.state IN ('failed','expired'))
      OR (OLD.state<>'finalized' AND NEW.state='finalized' AND intent.state='credited')
    ) THEN
      RAISE EXCEPTION 'Invalid deposit payment transition' USING ERRCODE='23514';
    END IF;
    IF OLD.state='prepared' AND NEW.state='submitted' AND
      (NEW.expires_at<=clock_timestamp() OR intent.state<>'awaiting_payment' OR intent.expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Deposit signing window closed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deposit_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON deposit_payments
  FOR EACH ROW EXECUTE FUNCTION guard_deposit_payment();

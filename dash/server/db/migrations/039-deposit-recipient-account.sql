-- Preserve legacy attempts and permit the one reviewed create-idempotent ATA
-- prefix. Ownership, zero unsigned signatures, message equality, immutable
-- preparation, unique intent/signature and lifecycle guards remain unchanged.
ALTER TABLE deposit_payments ADD COLUMN account_creation_lamports bigint NOT NULL DEFAULT 0
  CHECK (account_creation_lamports BETWEEN 0 AND 10000000);

DO $$
DECLARE entry record; removed integer := 0;
BEGIN
  FOR entry IN
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='deposit_payments'::regclass AND contype='c'
  LOOP
    IF position('length(message_base64)' in entry.definition)>0
      OR position('length(unsigned_transaction)' in entry.definition)>0
      OR position('length(signed_transaction)' in entry.definition)>0
      OR (position('octet_length(decode(message_base64,' in entry.definition)>0 AND position('247' in entry.definition)>0)
      OR (position('octet_length(decode(unsigned_transaction,' in entry.definition)>0 AND position('312' in entry.definition)>0)
      OR (position('octet_length(decode(signed_transaction,' in entry.definition)>0 AND position('312' in entry.definition)>0)
    THEN
      EXECUTE format('ALTER TABLE deposit_payments DROP CONSTRAINT %I', entry.conname);
      removed := removed+1;
    END IF;
  END LOOP;
  IF removed<>6 THEN RAISE EXCEPTION 'Unexpected deposit payment byte constraints'; END IF;
END;
$$;

ALTER TABLE deposit_payments
  ADD CONSTRAINT deposit_payment_reviewed_message CHECK (
    (account_creation_lamports=0 AND length(message_base64)=332
      AND message_base64 ~ '^[A-Za-z0-9+/]+==$'
      AND octet_length(decode(message_base64,'base64'))=247)
    OR
    (account_creation_lamports>0 AND length(message_base64)=472
      AND message_base64 ~ '^[A-Za-z0-9+/]+=$'
      AND octet_length(decode(message_base64,'base64'))=353)
  ),
  ADD CONSTRAINT deposit_payment_reviewed_unsigned CHECK (
    (account_creation_lamports=0 AND length(unsigned_transaction)=416
      AND unsigned_transaction ~ '^[A-Za-z0-9+/]+$'
      AND octet_length(decode(unsigned_transaction,'base64'))=312)
    OR
    (account_creation_lamports>0 AND length(unsigned_transaction)=560
      AND unsigned_transaction ~ '^[A-Za-z0-9+/]+==$'
      AND octet_length(decode(unsigned_transaction,'base64'))=418)
  ),
  ADD CONSTRAINT deposit_payment_reviewed_signed CHECK (
    signed_transaction IS NULL OR (
      get_byte(decode(signed_transaction,'base64'),0)=1
      AND substring(decode(signed_transaction,'base64') FROM 66)=decode(message_base64,'base64')
      AND ((account_creation_lamports=0 AND length(signed_transaction)=416
        AND signed_transaction ~ '^[A-Za-z0-9+/]+$'
        AND octet_length(decode(signed_transaction,'base64'))=312)
      OR (account_creation_lamports>0 AND length(signed_transaction)=560
        AND signed_transaction ~ '^[A-Za-z0-9+/]+==$'
        AND octet_length(decode(signed_transaction,'base64'))=418))
    )
  );

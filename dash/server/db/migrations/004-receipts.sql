-- Receipt signatures attest to captured ledger entries. These tables record no
-- on-chain authority: anchoring needs a separate verified chain integration.
CREATE TABLE receipts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  call_id uuid NOT NULL UNIQUE REFERENCES calls(id),
  hold_id uuid NOT NULL UNIQUE REFERENCES holds(id),
  issued_at timestamptz NOT NULL,
  batch_hour timestamptz NOT NULL,
  payload jsonb NOT NULL,
  signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{128}$'),
  CHECK (batch_hour = date_trunc('hour', issued_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (payload ?& ARRAY['version','receiptId','callId','holdId','issuedAt']),
  CHECK (payload->>'version' = '1'),
  CHECK (payload->>'receiptId' = id::text),
  CHECK (payload->>'callId' = call_id::text),
  CHECK (payload->>'holdId' = hold_id::text),
  CHECK ((payload->>'issuedAt')::timestamptz = issued_at)
);
CREATE INDEX receipts_owner ON receipts(account_id, issued_at DESC);
CREATE INDEX receipts_hour ON receipts(batch_hour, id);

CREATE TABLE receipt_batches (
  id uuid PRIMARY KEY,
  hour timestamptz NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending_anchor' CHECK (state = 'pending_anchor'),
  root jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (hour = date_trunc('hour', hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  CHECK (root ?& ARRAY['version','leafCount','hash']),
  CHECK (root->>'version' = '1'),
  CHECK ((root->>'leafCount')::integer BETWEEN 1 AND 4096),
  CHECK (root->>'hash' ~ '^[0-9a-f]{64}$')
);

CREATE TABLE receipt_batch_items (
  receipt_id uuid PRIMARY KEY REFERENCES receipts(id),
  batch_id uuid NOT NULL REFERENCES receipt_batches(id),
  leaf_index integer NOT NULL CHECK (leaf_index BETWEEN 0 AND 4095),
  proof jsonb NOT NULL,
  UNIQUE (batch_id, leaf_index),
  CHECK (proof ?& ARRAY['version','leafIndex','leafCount','siblings']),
  CHECK (proof->>'version' = '1'),
  CHECK ((proof->>'leafIndex')::integer = leaf_index)
);

CREATE FUNCTION reject_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Receipt records are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_mutation();
CREATE TRIGGER immutable_receipt_batch BEFORE UPDATE OR DELETE ON receipt_batches
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_mutation();
CREATE TRIGGER immutable_receipt_proof BEFORE UPDATE OR DELETE ON receipt_batch_items
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_mutation();

CREATE FUNCTION guard_receipt_hour() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('conclave_receipt_publication_v1'));
  IF EXISTS (SELECT 1 FROM receipt_batches WHERE hour = NEW.batch_hour) THEN
    RAISE EXCEPTION 'Receipt hour is already sealed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER closed_receipt_hour BEFORE INSERT ON receipts
  FOR EACH ROW EXECUTE FUNCTION guard_receipt_hour();

CREATE FUNCTION guard_receipt_batch_hour() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('conclave_receipt_publication_v1'));
  IF NEW.hour + interval '1 hour' > clock_timestamp() THEN
    RAISE EXCEPTION 'Receipt hour has not finished' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER completed_receipt_hour BEFORE INSERT ON receipt_batches
  FOR EACH ROW EXECUTE FUNCTION guard_receipt_batch_hour();

CREATE FUNCTION guard_receipt_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM receipt_batches b JOIN receipts r ON r.id = NEW.receipt_id
    WHERE b.id = NEW.batch_id AND b.hour = r.batch_hour
      AND b.xmin::text = pg_current_xact_id()::text
      AND NEW.leaf_index < (b.root->>'leafCount')::integer
      AND NEW.proof->>'leafCount' = b.root->>'leafCount'
  ) THEN
    RAISE EXCEPTION 'Proofs must be inserted with their batch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_proof_in_batch BEFORE INSERT ON receipt_batch_items
  FOR EACH ROW EXECUTE FUNCTION guard_receipt_proof();

CREATE FUNCTION assert_receipt_batch_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count bigint; receipt_count bigint;
BEGIN
  SELECT count(*) INTO item_count FROM receipt_batch_items WHERE batch_id = NEW.id;
  SELECT count(*) INTO receipt_count FROM receipts WHERE batch_hour = NEW.hour;
  IF item_count <> (NEW.root->>'leafCount')::integer OR item_count <> receipt_count THEN
    RAISE EXCEPTION 'Receipt batch must include its entire hour' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_receipt_batch AFTER INSERT ON receipt_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_receipt_batch_complete();

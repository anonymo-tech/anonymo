-- Owner-signed mainnet execution. No key material is stored in the database.
CREATE TABLE flywheel_activation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO flywheel_activation(singleton) VALUES(true);
CREATE TRIGGER immutable_flywheel_activation BEFORE UPDATE OR DELETE ON flywheel_activation
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TABLE flywheel_batches (
  id uuid PRIMARY KEY,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','bought','burned','cancelled')),
  amount_usd6 bigint NOT NULL CHECK(amount_usd6 > 0),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  matured_usd6 bigint NOT NULL CHECK(matured_usd6 >= amount_usd6),
  swap_signature text UNIQUE,
  bought_raw bigint CHECK(bought_raw > 0),
  burn_signature text UNIQUE,
  burn_record uuid UNIQUE REFERENCES token_burns(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(period_start < period_end),
  CHECK((state IN ('reserved','cancelled') AND swap_signature IS NULL AND bought_raw IS NULL AND burn_record IS NULL AND burn_signature IS NULL)
    OR (state='bought' AND swap_signature IS NOT NULL AND bought_raw IS NOT NULL AND burn_record IS NULL AND burn_signature IS NULL)
    OR (state='burned' AND swap_signature IS NOT NULL AND bought_raw IS NOT NULL AND burn_record IS NOT NULL AND burn_signature IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_flywheel_batch ON flywheel_batches((true)) WHERE state IN ('reserved','bought');
CREATE TABLE flywheel_burn_plans (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES flywheel_batches(id),
  message_base64 text NOT NULL,
  unsigned_transaction text NOT NULL,
  context_slot bigint NOT NULL,
  last_valid_block_height bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX flywheel_burn_plans_batch ON flywheel_burn_plans(batch_id,created_at DESC);
CREATE TRIGGER immutable_flywheel_burn_plans BEFORE UPDATE OR DELETE ON flywheel_burn_plans
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
-- Actual realized fills are not oracle quotations. The exact spend and raw
-- amount are authoritative; the displayed unit price rounds up to one USD6.
ALTER TABLE token_burns DROP CONSTRAINT token_burns_price_source_check;
ALTER TABLE token_burns ADD CONSTRAINT token_burns_price_source_check CHECK(price_source IN ('simulated','pool-twap','oracle','verified-swap'));
ALTER TABLE token_burns DROP CONSTRAINT token_burns_check8;
ALTER TABLE token_burns ADD CONSTRAINT token_burns_fill_price CHECK(
  (price_source='verified-swap' AND funding_source='jupiter' AND cluster='mainnet-beta'
    AND price_usd6_per_token=ceil(spent_usd6::numeric*power(10::numeric,token_decimals)/tokens_bought_raw))
  OR (price_source<>'verified-swap' AND (tokens_bought_raw=0 OR tokens_bought_raw::numeric*price_usd6_per_token
    < spent_usd6::numeric*power(10::numeric,token_decimals)+price_usd6_per_token)));
ALTER TABLE flywheel_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE flywheel_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE flywheel_burn_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flywheel_activation,flywheel_batches,flywheel_burn_plans FROM PUBLIC;
-- The direct application role owns these tables. No browser/Data API policy.

CREATE FUNCTION guard_flywheel_batch() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.state IN ('burned','cancelled') THEN
    RAISE EXCEPTION 'A finalized batch is immutable';
  END IF;
  IF ROW(NEW.id,NEW.amount_usd6,NEW.period_start,NEW.period_end,NEW.matured_usd6,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.amount_usd6,OLD.period_start,OLD.period_end,OLD.matured_usd6,OLD.created_at)
    OR NOT ((OLD.state='reserved' AND NEW.state IN ('bought','cancelled')) OR (OLD.state='bought' AND NEW.state='burned'))
    OR (OLD.state='bought' AND ROW(NEW.swap_signature,NEW.bought_raw) IS DISTINCT FROM ROW(OLD.swap_signature,OLD.bought_raw)) THEN
    RAISE EXCEPTION 'Invalid flywheel batch transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_flywheel_batch BEFORE UPDATE OR DELETE ON flywheel_batches FOR EACH ROW EXECUTE FUNCTION guard_flywheel_batch();
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON flywheel_activation,flywheel_batches,flywheel_burn_plans FROM %I',r);
    END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='conclave_api') THEN
    GRANT SELECT ON flywheel_activation TO conclave_api;
    GRANT SELECT,INSERT,UPDATE ON flywheel_batches TO conclave_api;
    GRANT SELECT,INSERT ON flywheel_burn_plans TO conclave_api;
    GRANT INSERT ON token_burns TO conclave_api;
    CREATE POLICY flywheel_api_read ON flywheel_activation FOR SELECT TO conclave_api USING(true);
    CREATE POLICY flywheel_api_batches ON flywheel_batches TO conclave_api USING(true) WITH CHECK(true);
    CREATE POLICY flywheel_api_plans ON flywheel_burn_plans TO conclave_api USING(true) WITH CHECK(true);
  END IF;
END;
$$;

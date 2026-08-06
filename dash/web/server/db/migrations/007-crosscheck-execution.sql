CREATE TABLE crosscheck_quotes (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES crosscheck_runs(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  maximum_usd6 bigint NOT NULL CHECK (maximum_usd6 BETWEEN 1 AND 10000000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 8192),
  review_count integer NOT NULL CHECK (review_count BETWEEN 3 AND 24),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'array' AND jsonb_array_length(terms) = review_count),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE crosscheck_quote_items (
  group_id uuid NOT NULL REFERENCES crosscheck_quotes(id),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 23),
  claim_id text NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 160),
  reviewer_id uuid NOT NULL REFERENCES route_versions(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id),
  PRIMARY KEY(group_id,position),
  UNIQUE(group_id,claim_id,reviewer_id)
);

CREATE TABLE crosscheck_executions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES crosscheck_runs(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  quote_group_id uuid NOT NULL UNIQUE REFERENCES crosscheck_quotes(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-zA-Z0-9_-]{16,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  approved_maximum_usd6 bigint NOT NULL CHECK (approved_maximum_usd6 BETWEEN 1 AND 10000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,idempotency_key)
);

-- Retry only deterministic evaluation, never paid model dispatch. Backoff keeps
-- one corrupt record from starving later completed executions in the sweep.
CREATE TABLE crosscheck_evaluation_progress (
  run_id uuid PRIMARY KEY REFERENCES crosscheck_executions(run_id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER immutable_crosscheck_quote BEFORE UPDATE OR DELETE ON crosscheck_quotes
  FOR EACH ROW EXECUTE FUNCTION reject_crosscheck_mutation();
CREATE TRIGGER immutable_crosscheck_quote_item BEFORE UPDATE OR DELETE ON crosscheck_quote_items
  FOR EACH ROW EXECUTE FUNCTION reject_crosscheck_mutation();
CREATE TRIGGER immutable_crosscheck_execution BEFORE UPDATE OR DELETE ON crosscheck_executions
  FOR EACH ROW EXECUTE FUNCTION reject_crosscheck_mutation();

CREATE FUNCTION assert_crosscheck_quote_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count bigint; total numeric;
BEGIN
  SELECT count(*),sum(q.max_usd6) INTO item_count,total FROM crosscheck_quote_items i
    JOIN quotes q ON q.id=i.quote_id JOIN crosscheck_runs r ON r.id=NEW.run_id
    WHERE i.group_id=NEW.id AND q.account_id=NEW.account_id AND r.account_id=NEW.account_id
      AND q.project_id=r.project_id AND q.route_version_id=i.reviewer_id
      AND q.max_output_tokens=NEW.max_output_tokens AND q.expires_at=NEW.expires_at
      AND i.position<NEW.review_count;
  IF item_count<>NEW.review_count OR total<>NEW.maximum_usd6 THEN
    RAISE EXCEPTION 'Cross-check quote must include every owned review' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_crosscheck_quote AFTER INSERT ON crosscheck_quotes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_crosscheck_quote_complete();

CREATE FUNCTION assert_crosscheck_execution_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count bigint; expected_count integer;
BEGIN
  SELECT q.review_count INTO expected_count FROM crosscheck_quotes q JOIN crosscheck_runs r ON r.id=q.run_id
    WHERE q.id=NEW.quote_group_id AND q.run_id=NEW.run_id AND q.account_id=NEW.account_id
      AND r.account_id=NEW.account_id AND q.maximum_usd6=NEW.approved_maximum_usd6;
  SELECT count(*) INTO item_count FROM crosscheck_review_calls rc JOIN calls c ON c.id=rc.call_id
    JOIN holds h ON h.id=c.hold_id JOIN crosscheck_quote_items i ON i.quote_id=h.quote_id
    JOIN crosscheck_runs r ON r.id=rc.run_id
    WHERE rc.run_id=NEW.run_id AND c.account_id=NEW.account_id AND h.account_id=NEW.account_id
      AND c.project_id=r.project_id AND i.group_id=NEW.quote_group_id
      AND i.claim_id=rc.claim_id AND i.reviewer_id::text=rc.reviewer_id AND c.route_version_id=i.reviewer_id;
  IF expected_count IS NULL OR item_count<>expected_count THEN
    RAISE EXCEPTION 'Cross-check execution must reserve every quoted review' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_crosscheck_execution AFTER INSERT ON crosscheck_executions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_crosscheck_execution_complete();

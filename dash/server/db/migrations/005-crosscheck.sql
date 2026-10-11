-- Source bytes, edited claims, review requests and results are encrypted by the
-- service. Roster administration and result completion have no public write API.
CREATE TABLE crosscheck_rosters (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  version integer NOT NULL CHECK (version > 0),
  reviewers jsonb NOT NULL CHECK (jsonb_typeof(reviewers) = 'array' AND jsonb_array_length(reviewers) BETWEEN 3 AND 8),
  reviewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > reviewed_at),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE crosscheck_sources (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  snapshot_ciphertext text NOT NULL CHECK (length(snapshot_ciphertext) BETWEEN 40 AND 2700000),
  source_bytes integer NOT NULL CHECK (source_bytes BETWEEN 1 AND 65536),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX crosscheck_sources_owner ON crosscheck_sources(account_id,project_id,created_at DESC,id DESC);

CREATE TABLE crosscheck_runs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  roster_id uuid NOT NULL REFERENCES crosscheck_rosters(id),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  plan_ciphertext text NOT NULL CHECK (length(plan_ciphertext) BETWEEN 40 AND 2700000),
  prepared_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at = prepared_at + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX crosscheck_runs_owner ON crosscheck_runs(account_id,project_id,created_at DESC,id DESC);
CREATE INDEX crosscheck_runs_cache ON crosscheck_runs(account_id,project_id,roster_id,request_hash,expires_at DESC);

CREATE TABLE crosscheck_results (
  run_id uuid PRIMARY KEY REFERENCES crosscheck_runs(id),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  result_ciphertext text NOT NULL CHECK (length(result_ciphertext) BETWEEN 40 AND 2700000),
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE crosscheck_review_calls (
  run_id uuid NOT NULL REFERENCES crosscheck_runs(id),
  claim_id text NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 160),
  reviewer_id text NOT NULL CHECK (length(reviewer_id) BETWEEN 1 AND 160),
  call_id uuid NOT NULL UNIQUE REFERENCES calls(id),
  PRIMARY KEY(run_id,claim_id,reviewer_id)
);

CREATE FUNCTION preserve_crosscheck_roster() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'enabled') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled') THEN
    RAISE EXCEPTION 'Publish a new reviewer roster version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_crosscheck_roster BEFORE UPDATE ON crosscheck_rosters
  FOR EACH ROW EXECUTE FUNCTION preserve_crosscheck_roster();

CREATE FUNCTION reject_crosscheck_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cross-check records are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_crosscheck_source BEFORE UPDATE OR DELETE ON crosscheck_sources
  FOR EACH ROW EXECUTE FUNCTION reject_crosscheck_mutation();
CREATE TRIGGER immutable_crosscheck_run BEFORE UPDATE OR DELETE ON crosscheck_runs
  FOR EACH ROW EXECUTE FUNCTION reject_crosscheck_mutation();
CREATE TRIGGER immutable_crosscheck_result BEFORE UPDATE OR DELETE ON crosscheck_results
  FOR EACH ROW EXECUTE FUNCTION reject_crosscheck_mutation();
CREATE TRIGGER immutable_crosscheck_review_call BEFORE UPDATE OR DELETE ON crosscheck_review_calls
  FOR EACH ROW EXECUTE FUNCTION reject_crosscheck_mutation();

CREATE FUNCTION guard_crosscheck_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM projects p JOIN accounts a ON a.id=p.account_id
    WHERE p.id=NEW.project_id AND p.account_id=NEW.account_id
      AND p.archived_at IS NULL AND a.disabled_at IS NULL FOR SHARE OF p,a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cross-check project is unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crosscheck_source_owner BEFORE INSERT ON crosscheck_sources
  FOR EACH ROW EXECUTE FUNCTION guard_crosscheck_owner();
CREATE TRIGGER crosscheck_run_owner BEFORE INSERT ON crosscheck_runs
  FOR EACH ROW EXECUTE FUNCTION guard_crosscheck_owner();

CREATE FUNCTION guard_crosscheck_review_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crosscheck_runs r JOIN calls c ON c.id=NEW.call_id
      WHERE r.id=NEW.run_id AND r.account_id=c.account_id AND r.project_id=c.project_id)
    OR EXISTS (SELECT 1 FROM crosscheck_results WHERE run_id=NEW.run_id) THEN
    RAISE EXCEPTION 'Review call must belong to its unfinished cross-check' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER owned_crosscheck_review_call BEFORE INSERT ON crosscheck_review_calls
  FOR EACH ROW EXECUTE FUNCTION guard_crosscheck_review_call();

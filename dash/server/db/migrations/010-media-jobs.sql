CREATE TABLE media_quote_inputs (
  quote_id uuid PRIMARY KEY REFERENCES quotes(id),
  input_ciphertext text NOT NULL CHECK (length(input_ciphertext) BETWEEN 20 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_media_quote_input BEFORE UPDATE OR DELETE ON media_quote_inputs
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE FUNCTION preserve_media_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM media_quote_inputs WHERE quote_id=OLD.id) THEN
    RAISE EXCEPTION 'Media quote terms are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_media_quote BEFORE UPDATE OR DELETE ON quotes
  FOR EACH ROW EXECUTE FUNCTION preserve_media_quote();

CREATE TABLE media_jobs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  route_version_id uuid NOT NULL REFERENCES route_versions(id),
  hold_id uuid NOT NULL UNIQUE REFERENCES holds(id),
  input_ciphertext text NOT NULL CHECK (length(input_ciphertext) BETWEEN 20 AND 100000),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  modality text NOT NULL CHECK (modality IN ('image','video')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','dispatching','polling','completed','failed','cancelled','reconciliation_pending')),
  provider_reference_ciphertext text,
  provider_reference_hash text UNIQUE CHECK (provider_reference_hash ~ '^[0-9a-f]{64}$'),
  result_ciphertext text,
  dispatched_at timestamptz,
  cancel_requested_at timestamptz,
  next_poll_at timestamptz,
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts BETWEEN 0 AND 2000),
  recovery_deadline timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text CHECK (error_code ~ '^[A-Z_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (state <> 'queued' OR dispatched_at IS NULL),
  CHECK (state NOT IN ('dispatching','polling','completed') OR dispatched_at IS NOT NULL),
  CHECK (state <> 'completed' OR result_ciphertext IS NOT NULL)
);
CREATE INDEX media_jobs_owner ON media_jobs(account_id,project_id,created_at DESC,id DESC);
CREATE INDEX media_jobs_runnable ON media_jobs(state,next_poll_at) WHERE state IN ('queued','polling','reconciliation_pending');

CREATE FUNCTION preserve_media_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h holds; q quotes; r route_versions;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Media billing records cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.account_id,NEW.project_id,NEW.route_version_id,NEW.hold_id,NEW.input_ciphertext,NEW.request_hash,NEW.modality,NEW.created_at,NEW.recovery_deadline)
       IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.project_id,OLD.route_version_id,OLD.hold_id,OLD.input_ciphertext,OLD.request_hash,OLD.modality,OLD.created_at,OLD.recovery_deadline)
       OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
       OR (OLD.provider_reference_hash IS NOT NULL AND NEW.provider_reference_hash IS DISTINCT FROM OLD.provider_reference_hash)
       OR (OLD.provider_reference_ciphertext IS NOT NULL AND NEW.provider_reference_ciphertext IS DISTINCT FROM OLD.provider_reference_ciphertext)
       OR (OLD.result_ciphertext IS NOT NULL AND NEW.result_ciphertext IS DISTINCT FROM OLD.result_ciphertext)
       OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
       OR NEW.poll_attempts < OLD.poll_attempts
       OR (OLD.state IN ('completed','failed','cancelled') AND NEW.state IS DISTINCT FROM OLD.state)
       OR (OLD.state='queued' AND NEW.state NOT IN ('queued','dispatching','failed','cancelled'))
       OR (OLD.state<>'queued' AND NEW.state='queued')
       OR (OLD.state IN ('polling','reconciliation_pending') AND NEW.state='dispatching')
       OR (OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL AND NOT (OLD.state='queued' AND NEW.state='dispatching')) THEN
      RAISE EXCEPTION 'Media request and settled state are immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.state<>'queued' OR NEW.dispatched_at IS NOT NULL OR NEW.provider_reference_ciphertext IS NOT NULL OR NEW.result_ciphertext IS NOT NULL OR NEW.provider_reference_hash IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.poll_attempts<>0 THEN
      RAISE EXCEPTION 'Media jobs must begin undispatched' USING ERRCODE='23514';
    END IF;
    SELECT * INTO h FROM holds WHERE id=NEW.hold_id;
    SELECT * INTO q FROM quotes WHERE id=h.quote_id;
    SELECT * INTO r FROM route_versions WHERE id=NEW.route_version_id;
    IF h.id IS NULL OR q.id IS NULL OR r.id IS NULL OR
       h.account_id<>NEW.account_id OR q.account_id<>NEW.account_id OR
       q.project_id<>NEW.project_id OR q.route_version_id<>NEW.route_version_id OR
       h.request_hash<>NEW.request_hash OR q.request_hash<>NEW.request_hash OR
       r.modality<>NEW.modality OR
       NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND account_id=NEW.account_id) OR
       NOT EXISTS(SELECT 1 FROM media_quote_inputs WHERE quote_id=q.id) THEN
      RAISE EXCEPTION 'Media request ownership or quote does not match' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_media_job BEFORE INSERT OR UPDATE OR DELETE ON media_jobs
  FOR EACH ROW EXECUTE FUNCTION preserve_media_job();

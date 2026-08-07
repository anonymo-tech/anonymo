CREATE TABLE media_ingests (
  job_id uuid PRIMARY KEY REFERENCES media_jobs(id),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','retry','completed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text CHECK(error_code ~ '^MEDIA_[A-Z_]{1,70}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK((state='processing') = (lease_token IS NOT NULL)),
  CHECK(state <> 'completed' OR error_code IS NULL)
);
CREATE INDEX media_ingests_runnable ON media_ingests(next_attempt_at,job_id)
  WHERE state IN ('queued','retry');

CREATE FUNCTION preserve_media_ingest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Media import history cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'queued' OR NEW.attempts<>0 OR NEW.lease_token IS NOT NULL THEN
      RAISE EXCEPTION 'Media imports must begin queued' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(NEW.job_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.created_at)
     OR NEW.attempts<OLD.attempts
     OR (OLD.state IN ('completed','failed') AND NEW IS DISTINCT FROM OLD)
     OR (OLD.state<>'queued' AND NEW.state='queued') THEN
    RAISE EXCEPTION 'Media import identity and terminal state are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_media_ingest BEFORE INSERT OR UPDATE OR DELETE ON media_ingests
  FOR EACH ROW EXECUTE FUNCTION preserve_media_ingest();

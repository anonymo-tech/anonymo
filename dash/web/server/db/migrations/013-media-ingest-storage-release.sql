CREATE OR REPLACE FUNCTION preserve_media_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j media_jobs;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Media asset identities cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO j FROM media_jobs WHERE id=NEW.job_id;
    IF j.id IS NULL OR j.account_id<>NEW.account_id OR j.project_id<>NEW.project_id OR j.modality<>NEW.modality OR j.state<>'queued' OR j.dispatched_at IS NOT NULL OR NEW.state<>'reserved' THEN
      RAISE EXCEPTION 'Media storage must be reserved for an owned undispatched job' USING ERRCODE='23514';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.account_id,NEW.project_id,NEW.job_id,NEW.modality,NEW.max_plaintext_bytes,NEW.reservation_bytes,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.project_id,OLD.job_id,OLD.modality,OLD.max_plaintext_bytes,OLD.reservation_bytes,OLD.created_at)
       OR NOT ((OLD.state='reserved' AND NEW.state IN ('ready','released')) OR (OLD.state='ready' AND NEW.state='deleted')) THEN
      RAISE EXCEPTION 'Media asset identity and finalized storage are immutable' USING ERRCODE='23514';
    END IF;
    SELECT * INTO j FROM media_jobs WHERE id=NEW.job_id;
    IF NEW.state='ready' AND (j.state<>'completed' OR j.result_ciphertext IS NULL) THEN
      RAISE EXCEPTION 'Media generation must finish before storage finalization' USING ERRCODE='23514';
    END IF;
    IF NEW.state='released' AND NOT (
      (j.state IN ('failed','cancelled') AND j.result_ciphertext IS NULL)
      OR (j.state='completed' AND j.result_ciphertext IS NOT NULL AND EXISTS(
        SELECT 1 FROM media_ingests i WHERE i.job_id=j.id AND i.state='failed' AND i.lease_token IS NULL AND i.lease_expires_at IS NULL
      ))
    ) THEN
      RAISE EXCEPTION 'Unresolved generation retains its storage reservation' USING ERRCODE='23514';
    END IF;
    IF NEW.state='deleted' AND ROW(NEW.chunk_count,NEW.byte_length,NEW.content_type,NEW.sha256,NEW.ready_at)
       IS DISTINCT FROM ROW(OLD.chunk_count,OLD.byte_length,OLD.content_type,OLD.sha256,OLD.ready_at) THEN
      RAISE EXCEPTION 'Deleted media retains its immutable version record' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  job_id uuid NOT NULL UNIQUE REFERENCES media_jobs(id),
  modality text NOT NULL CHECK (modality IN ('image','video')),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','ready','released','deleted')),
  max_plaintext_bytes integer NOT NULL CHECK (max_plaintext_bytes IN (20971520,104857600)),
  reservation_bytes integer NOT NULL CHECK (reservation_bytes=max_plaintext_bytes+28*((max_plaintext_bytes+1048575)/1048576)+2048),
  allocated_bytes integer NOT NULL CHECK (allocated_bytes BETWEEN 0 AND reservation_bytes),
  manifest_ciphertext text CHECK (octet_length(manifest_ciphertext) BETWEEN 20 AND 2048),
  chunk_count integer CHECK (chunk_count BETWEEN 1 AND 100),
  byte_length integer CHECK (byte_length BETWEEN 1 AND max_plaintext_bytes),
  content_type text CHECK (content_type IN ('image/png','image/jpeg','image/webp','video/mp4')),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  removed_at timestamptz,
  CHECK ((modality='image' AND max_plaintext_bytes=20971520) OR (modality='video' AND max_plaintext_bytes=104857600)),
  CHECK (content_type IS NULL OR (modality='video')=(content_type='video/mp4')),
  CHECK (chunk_count IS NULL OR chunk_count=(byte_length+1048575)/1048576),
  CHECK (
    (state='reserved' AND allocated_bytes=reservation_bytes AND manifest_ciphertext IS NULL AND chunk_count IS NULL AND byte_length IS NULL AND content_type IS NULL AND sha256 IS NULL AND ready_at IS NULL AND removed_at IS NULL)
    OR (state='ready' AND allocated_bytes=byte_length+28*chunk_count+octet_length(manifest_ciphertext) AND manifest_ciphertext IS NOT NULL AND chunk_count IS NOT NULL AND byte_length IS NOT NULL AND content_type IS NOT NULL AND sha256 IS NOT NULL AND ready_at IS NOT NULL AND removed_at IS NULL)
    OR (state='released' AND allocated_bytes=0 AND manifest_ciphertext IS NULL AND chunk_count IS NULL AND byte_length IS NULL AND content_type IS NULL AND sha256 IS NULL AND ready_at IS NULL AND removed_at IS NOT NULL)
    OR (state='deleted' AND allocated_bytes=0 AND manifest_ciphertext IS NULL AND chunk_count IS NOT NULL AND byte_length IS NOT NULL AND content_type IS NOT NULL AND sha256 IS NOT NULL AND ready_at IS NOT NULL AND removed_at IS NOT NULL)
  )
);
CREATE INDEX media_assets_capacity ON media_assets(account_id) INCLUDE(allocated_bytes) WHERE allocated_bytes>0;

CREATE TABLE media_asset_chunks (
  asset_id uuid NOT NULL REFERENCES media_assets(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 29 AND 1048604),
  PRIMARY KEY(asset_id,ordinal)
);

CREATE FUNCTION preserve_media_asset() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.state='released' AND (j.state NOT IN ('failed','cancelled') OR j.result_ciphertext IS NOT NULL) THEN
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
CREATE TRIGGER preserve_media_asset BEFORE INSERT OR UPDATE OR DELETE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION preserve_media_asset();

CREATE FUNCTION preserve_media_asset_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a media_assets;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Encrypted media chunks are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN
    SELECT * INTO a FROM media_assets WHERE id=OLD.asset_id;
    IF a.state<>'deleted' THEN
      RAISE EXCEPTION 'Only deleted assets permit chunk removal' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO a FROM media_assets WHERE id=NEW.asset_id;
  IF a.id IS NULL OR a.state<>'reserved' OR NEW.ordinal>=a.max_plaintext_bytes/1048576 THEN
    RAISE EXCEPTION 'Chunks require an active asset reservation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_media_asset_chunk BEFORE INSERT OR UPDATE OR DELETE ON media_asset_chunks
  FOR EACH ROW EXECUTE FUNCTION preserve_media_asset_chunk();

CREATE FUNCTION assert_media_asset_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a media_assets; count_chunks bigint; bytes_chunks bigint;
BEGIN
  IF TG_TABLE_NAME='media_assets' THEN
    SELECT * INTO a FROM media_assets WHERE id=NEW.id;
  ELSE
    SELECT * INTO a FROM media_assets WHERE id=COALESCE(NEW.asset_id,OLD.asset_id);
  END IF;
  SELECT count(*),COALESCE(sum(octet_length(ciphertext)),0) INTO count_chunks,bytes_chunks FROM media_asset_chunks WHERE asset_id=a.id;
  IF a.state='ready' THEN
    IF count_chunks<>a.chunk_count OR bytes_chunks<>a.byte_length+28*a.chunk_count OR EXISTS(
      SELECT 1 FROM media_asset_chunks WHERE asset_id=a.id AND (ordinal>=a.chunk_count OR octet_length(ciphertext)<>LEAST(1048576,a.byte_length-ordinal*1048576)+28)
    ) THEN
      RAISE EXCEPTION 'Media storage must finalize a complete ordered chunk set' USING ERRCODE='23514';
    END IF;
  ELSIF count_chunks<>0 THEN
    RAISE EXCEPTION 'Incomplete or removed assets cannot retain chunks' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER assert_media_asset_complete AFTER INSERT OR UPDATE ON media_assets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_media_asset_complete();
CREATE CONSTRAINT TRIGGER assert_media_asset_chunks_complete AFTER INSERT OR DELETE ON media_asset_chunks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_media_asset_complete();

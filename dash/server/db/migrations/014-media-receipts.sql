-- Keep existing chat payloads/signatures intact while admitting versioned media
-- statements into the same immutable receipt and Merkle batch tables.
ALTER TABLE receipts ALTER COLUMN call_id DROP NOT NULL;
ALTER TABLE receipts ADD COLUMN media_job_id uuid UNIQUE REFERENCES media_jobs(id);
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid='receipts'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%payload%'
  LOOP
    EXECUTE format('ALTER TABLE receipts DROP CONSTRAINT %I',item.conname);
  END LOOP;
END;
$$;
ALTER TABLE receipts ADD CONSTRAINT receipt_payload_identity CHECK ((
  jsonb_typeof(payload)='object'
  AND payload ?& ARRAY['version','receiptId','holdId','issuedAt']
  AND jsonb_typeof(payload->'version')='number'
  AND payload->>'receiptId'=id::text
  AND payload->>'holdId'=hold_id::text
  AND (payload->>'issuedAt')::timestamptz=issued_at
  AND (
    (call_id IS NOT NULL AND media_job_id IS NULL AND payload->>'version'='1'
      AND payload ? 'callId' AND payload->>'callId'=call_id::text)
    OR
    (call_id IS NULL AND media_job_id IS NOT NULL AND payload->>'version'='2'
      AND payload ?& ARRAY['kind','mediaJobId','accountCommitment','routeVersion','modelId','modality','signerKeyId','signerEpoch','actualUsd6','settlement','generationState','requestDigest','providerReferenceDigest','assetDelivery']
      AND payload->>'kind'='media' AND payload->>'mediaJobId'=media_job_id::text)
  )
) IS TRUE);

CREATE FUNCTION guard_media_receipt_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j record; h record; q record; r record; commitment text;
BEGIN
  IF NEW.media_job_id IS NULL THEN RETURN NEW; END IF;
  SELECT id,account_id,project_id,route_version_id,hold_id,request_hash,modality,state,provider_reference_hash,dispatched_at
    INTO j FROM media_jobs WHERE id=NEW.media_job_id;
  SELECT id,account_id,quote_id,request_hash,captured_usd6,state,provider_reference
    INTO h FROM holds WHERE id=NEW.hold_id;
  SELECT id,account_id,project_id,route_version_id,request_hash INTO q FROM quotes WHERE id=h.quote_id;
  SELECT id,model_id,modality INTO r FROM route_versions WHERE id=j.route_version_id;
  commitment := encode(sha256(convert_to('conclave:receipt-account:v2','UTF8')||decode('00','hex')||convert_to(NEW.account_id::text,'UTF8')||decode('00','hex')||convert_to(NEW.hold_id::text,'UTF8')),'hex');
  IF j.id IS NULL OR h.id IS NULL OR q.id IS NULL OR r.id IS NULL
    OR j.account_id<>NEW.account_id OR h.account_id<>NEW.account_id OR q.account_id<>NEW.account_id
    OR j.hold_id<>h.id OR q.project_id<>j.project_id OR q.route_version_id<>j.route_version_id
    OR q.request_hash<>j.request_hash OR h.request_hash<>j.request_hash OR r.modality<>j.modality
    OR NOT EXISTS(SELECT 1 FROM projects WHERE id=j.project_id AND account_id=NEW.account_id)
    OR j.state NOT IN ('completed','failed','cancelled')
    OR h.captured_usd6 IS NULL OR h.state NOT IN ('captured','released')
    OR (h.captured_usd6=0)<>(h.state='released')
    OR h.provider_reference IS DISTINCT FROM j.provider_reference_hash
    OR (j.state='cancelled' AND (h.captured_usd6<>0 OR j.dispatched_at IS NOT NULL OR j.provider_reference_hash IS NOT NULL))
    OR ((h.captured_usd6>0 OR j.state='completed') AND j.provider_reference_hash IS NULL)
    OR (NEW.payload->>'accountCommitment') IS DISTINCT FROM commitment
    OR (NEW.payload->>'routeVersion') IS DISTINCT FROM j.route_version_id::text
    OR (NEW.payload->>'modelId') IS DISTINCT FROM r.model_id
    OR (NEW.payload->>'modality') IS DISTINCT FROM j.modality
    OR (NEW.payload->>'actualUsd6') IS DISTINCT FROM h.captured_usd6::text
    OR (NEW.payload->>'settlement') IS DISTINCT FROM h.state
    OR (NEW.payload->>'generationState') IS DISTINCT FROM j.state
    OR (NEW.payload->>'requestDigest') IS DISTINCT FROM j.request_hash
    OR (NEW.payload->>'providerReferenceDigest') IS DISTINCT FROM j.provider_reference_hash
    OR (NEW.payload->>'assetDelivery') IS DISTINCT FROM 'not_attested' THEN
    RAISE EXCEPTION 'Media receipt does not match its owned settlement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_receipt_binding BEFORE INSERT ON receipts
  FOR EACH ROW EXECUTE FUNCTION guard_media_receipt_binding();

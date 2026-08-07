CREATE TABLE brief_documents (
  brief_id uuid PRIMARY KEY REFERENCES briefs(id) ON DELETE CASCADE,
  evidence_ciphertext text NOT NULL,
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
  analysis_ciphertext text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION protect_brief_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.brief_id IS DISTINCT FROM OLD.brief_id
     OR NEW.evidence_ciphertext IS DISTINCT FROM OLD.evidence_ciphertext
     OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
     OR NEW.saved_at IS DISTINCT FROM OLD.saved_at THEN
    RAISE EXCEPTION 'Brief evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brief_evidence_immutable BEFORE UPDATE ON brief_documents
FOR EACH ROW EXECUTE FUNCTION protect_brief_evidence();

CREATE TABLE brief_creation_keys (
  account_id uuid NOT NULL REFERENCES accounts(id),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  brief_id uuid REFERENCES briefs(id) ON DELETE SET NULL,
  PRIMARY KEY(account_id,idempotency_key)
);

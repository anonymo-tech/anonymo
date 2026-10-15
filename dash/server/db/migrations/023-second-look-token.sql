-- Token observations contain public chain data; requests and billing remain owner-scoped.
CREATE TABLE secondlook_token_quotes (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), mint text NOT NULL CHECK(length(mint) BETWEEN 32 AND 44),
 mode text NOT NULL CHECK(mode IN ('standard','deep')), idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 maximum_usd6 bigint NOT NULL CHECK(maximum_usd6 IN (0,20000,100000)), evidence_id uuid,
 quota_day date NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 UNIQUE(account_id,idempotency_key), CHECK(expires_at>created_at AND expires_at<=created_at+interval '90 seconds'),
 CHECK((mode='standard' AND maximum_usd6 IN (0,20000)) OR (mode='deep' AND maximum_usd6=100000))
);
CREATE TABLE secondlook_token_usage (
 account_id uuid NOT NULL REFERENCES accounts(id), day date NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 10), PRIMARY KEY(account_id,day)
);
CREATE TABLE secondlook_token_global_usage (day date PRIMARY KEY, used integer NOT NULL DEFAULT 0 CHECK(used>=0));
CREATE TABLE secondlook_token_reports (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), quote_id uuid NOT NULL UNIQUE REFERENCES secondlook_token_quotes(id),
 state text NOT NULL CHECK(state IN ('pending','complete','partial','failed')), billing_state text NOT NULL CHECK(billing_state IN ('free','held','captured','released')),
 maximum_usd6 bigint NOT NULL CHECK(maximum_usd6 IN (0,20000,100000)), actual_usd6 bigint CHECK(actual_usd6>=0 AND actual_usd6<=maximum_usd6),
 document jsonb NOT NULL CHECK(octet_length(document::text)<=524288), lease_id uuid NOT NULL, lease_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((billing_state='held' AND actual_usd6 IS NULL) OR (billing_state='captured' AND actual_usd6=maximum_usd6) OR (billing_state IN ('free','released') AND actual_usd6=0))
);
CREATE INDEX secondlook_token_reports_owner ON secondlook_token_reports(account_id,created_at DESC,id DESC);
CREATE INDEX secondlook_token_reports_recovery ON secondlook_token_reports(lease_expires_at) WHERE state='pending';
CREATE TABLE secondlook_token_cache (mint text PRIMARY KEY, facts jsonb NOT NULL CHECK(octet_length(facts::text)<=262144), observed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '10 minutes'));
-- Only reviewed ingestion/operator roles may insert these immutable artifacts. No HTTP writer exists.
CREATE TABLE secondlook_token_evidence (id uuid PRIMARY KEY, mint text NOT NULL, artifact jsonb NOT NULL CHECK(octet_length(artifact::text)<=2097152), artifact_hash text NOT NULL CHECK(artifact_hash ~ '^[a-f0-9]{64}$'), observed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '10 minutes'), created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX secondlook_token_evidence_mint ON secondlook_token_evidence(mint,expires_at DESC);
ALTER TABLE secondlook_token_quotes ADD FOREIGN KEY(evidence_id) REFERENCES secondlook_token_evidence(id);
CREATE TABLE secondlook_token_calibration (id uuid PRIMARY KEY, artifact jsonb NOT NULL CHECK(octet_length(artifact::text)<=16384), created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION preserve_secondlook_token_artifact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Token evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER secondlook_token_quote_immutable BEFORE UPDATE OR DELETE ON secondlook_token_quotes FOR EACH ROW EXECUTE FUNCTION preserve_secondlook_token_artifact();
CREATE TRIGGER secondlook_token_evidence_immutable BEFORE UPDATE OR DELETE ON secondlook_token_evidence FOR EACH ROW EXECUTE FUNCTION preserve_secondlook_token_artifact();
CREATE TRIGGER secondlook_token_calibration_immutable BEFORE UPDATE OR DELETE ON secondlook_token_calibration FOR EACH ROW EXECUTE FUNCTION preserve_secondlook_token_artifact();
CREATE FUNCTION preserve_secondlook_token_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.quote_id<>OLD.quote_id OR NEW.maximum_usd6<>OLD.maximum_usd6 OR NEW.lease_id<>OLD.lease_id OR NEW.lease_expires_at<>OLD.lease_expires_at OR NEW.created_at<>OLD.created_at OR (OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Token report transition rejected' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER secondlook_token_report_immutable BEFORE UPDATE ON secondlook_token_reports FOR EACH ROW EXECUTE FUNCTION preserve_secondlook_token_report();
ALTER TABLE secondlook_token_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE secondlook_token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE secondlook_token_global_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE secondlook_token_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE secondlook_token_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE secondlook_token_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE secondlook_token_calibration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON secondlook_token_quotes,secondlook_token_usage,secondlook_token_global_usage,secondlook_token_reports,secondlook_token_cache,secondlook_token_evidence,secondlook_token_calibration FROM PUBLIC;

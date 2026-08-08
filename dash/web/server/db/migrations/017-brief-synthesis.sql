CREATE TABLE brief_synthesis_plans (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  brief_id uuid REFERENCES briefs(id) ON DELETE SET NULL,
  source_brief_id uuid NOT NULL,
  quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id),
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
  prompt_version integer NOT NULL CHECK(prompt_version=1),
  output_version integer NOT NULL CHECK(output_version=1),
  snapshot_ciphertext text NOT NULL CHECK(octet_length(snapshot_ciphertext) BETWEEN 40 AND 200000),
  terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brief_synthesis_history ON brief_synthesis_plans(account_id,source_brief_id,created_at DESC,id DESC);

CREATE FUNCTION validate_brief_synthesis_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM briefs b JOIN brief_documents d ON d.brief_id=b.id
    JOIN quotes q ON q.id=NEW.quote_id
    WHERE b.id=NEW.brief_id AND NEW.source_brief_id=b.id AND b.account_id=NEW.account_id
      AND b.project_id=NEW.project_id AND d.evidence_hash=NEW.evidence_hash
      AND q.account_id=NEW.account_id AND q.project_id=NEW.project_id
      AND NEW.terms->>'id'=q.id::text AND NEW.terms->>'routeVersionId'=q.route_version_id::text
      AND NEW.terms->>'requestHash'=q.request_hash AND NEW.terms->>'maximumUsd6'=q.max_usd6::text
      AND NEW.terms->>'maxOutputTokens'=q.max_output_tokens::text
  ) THEN RAISE EXCEPTION 'Synthesis source linkage is invalid'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brief_synthesis_plan_valid BEFORE INSERT ON brief_synthesis_plans
FOR EACH ROW EXECUTE FUNCTION validate_brief_synthesis_plan();

CREATE FUNCTION protect_brief_synthesis_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Synthesis provenance is immutable'; END IF;
  IF (to_jsonb(NEW)-'brief_id') IS DISTINCT FROM (to_jsonb(OLD)-'brief_id')
     OR NOT (OLD.brief_id IS NOT NULL AND NEW.brief_id IS NULL AND pg_trigger_depth()>1) THEN
    RAISE EXCEPTION 'Synthesis plan is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brief_synthesis_plan_immutable BEFORE UPDATE OR DELETE ON brief_synthesis_plans
FOR EACH ROW EXECUTE FUNCTION protect_brief_synthesis_plan();

CREATE TABLE brief_synthesis_executions (
  plan_id uuid PRIMARY KEY REFERENCES brief_synthesis_plans(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  call_id uuid NOT NULL UNIQUE REFERENCES calls(id),
  approval_hash text NOT NULL CHECK(approval_hash ~ '^[0-9a-f]{64}$'),
  approved_maximum_usd6 bigint NOT NULL CHECK(approved_maximum_usd6>0 AND approved_maximum_usd6<=10000000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_brief_synthesis_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Synthesis record is immutable'; END;
$$;
CREATE TRIGGER brief_synthesis_execution_immutable BEFORE UPDATE OR DELETE ON brief_synthesis_executions
FOR EACH ROW EXECUTE FUNCTION protect_brief_synthesis_record();

CREATE FUNCTION validate_brief_synthesis_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM brief_synthesis_plans p JOIN quotes q ON q.id=p.quote_id
    JOIN calls c ON c.id=NEW.call_id JOIN holds h ON h.id=c.hold_id
    WHERE p.id=NEW.plan_id AND p.account_id=NEW.account_id AND c.account_id=p.account_id
      AND q.account_id=p.account_id AND h.account_id=p.account_id
      AND c.project_id=p.project_id AND q.project_id=p.project_id
      AND c.route_version_id=q.route_version_id AND h.quote_id=q.id
      AND h.request_hash=q.request_hash AND h.maximum_usd6=q.max_usd6
      AND NEW.approved_maximum_usd6=q.max_usd6 AND h.idempotency_key='bs_'||p.id::text
  ) THEN RAISE EXCEPTION 'Synthesis execution linkage is invalid'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER brief_synthesis_execution_linkage AFTER INSERT ON brief_synthesis_executions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_brief_synthesis_execution();

CREATE TABLE brief_synthesis_results (
  plan_id uuid PRIMARY KEY REFERENCES brief_synthesis_executions(plan_id),
  status text NOT NULL CHECK(status IN ('valid','invalid','failed','cancelled')),
  output_hash text CHECK(output_hash ~ '^[0-9a-f]{64}$'),
  result_ciphertext text CHECK(octet_length(result_ciphertext) BETWEEN 40 AND 150000),
  invalid_reason text CHECK(invalid_reason ~ '^[A-Z0-9_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status='valid' AND output_hash IS NOT NULL AND result_ciphertext IS NOT NULL AND invalid_reason IS NULL)
    OR (status='invalid' AND output_hash IS NOT NULL AND result_ciphertext IS NULL AND invalid_reason IS NOT NULL)
    OR (status IN ('failed','cancelled') AND result_ciphertext IS NULL AND invalid_reason IS NOT NULL))
);
CREATE TRIGGER brief_synthesis_result_immutable BEFORE UPDATE OR DELETE ON brief_synthesis_results
FOR EACH ROW EXECUTE FUNCTION protect_brief_synthesis_record();

CREATE FUNCTION validate_brief_synthesis_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM brief_synthesis_executions e JOIN calls c ON c.id=e.call_id JOIN holds h ON h.id=c.hold_id
    WHERE e.plan_id=NEW.plan_id AND h.state IN ('captured','released')
      AND ((NEW.status IN ('valid','invalid') AND c.state='succeeded') OR NEW.status=c.state)
  ) THEN RAISE EXCEPTION 'Synthesis result requires a settled terminal call'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brief_synthesis_result_valid BEFORE INSERT ON brief_synthesis_results
FOR EACH ROW EXECUTE FUNCTION validate_brief_synthesis_result();

CREATE TABLE brief_synthesis_selection (
  brief_id uuid PRIMARY KEY REFERENCES briefs(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES brief_synthesis_results(plan_id)
);
CREATE FUNCTION validate_brief_synthesis_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM brief_synthesis_plans p JOIN brief_synthesis_results r ON r.plan_id=p.id
    JOIN briefs b ON b.id=NEW.brief_id JOIN brief_documents d ON d.brief_id=b.id
    WHERE p.id=NEW.plan_id AND p.brief_id=b.id AND p.source_brief_id=b.id
      AND p.account_id=b.account_id AND p.project_id=b.project_id
      AND p.evidence_hash=d.evidence_hash AND r.status='valid'
  ) THEN RAISE EXCEPTION 'Synthesis selection is invalid'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brief_synthesis_selection_valid BEFORE INSERT OR UPDATE ON brief_synthesis_selection
FOR EACH ROW EXECUTE FUNCTION validate_brief_synthesis_selection();

CREATE TABLE brief_synthesis_evaluation_progress (
  plan_id uuid PRIMARY KEY REFERENCES brief_synthesis_executions(plan_id),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1000000),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text CHECK(last_error_code ~ '^[A-Z0-9_]{1,80}$')
);

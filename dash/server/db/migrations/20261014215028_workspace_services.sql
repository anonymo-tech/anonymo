CREATE TABLE chapters (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), project_id uuid NOT NULL UNIQUE REFERENCES projects(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), monthly_usd6 bigint NOT NULL CHECK(monthly_usd6 BETWEEN 1 AND 1000000000),
 created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE TABLE chapter_members (
 chapter_id uuid NOT NULL REFERENCES chapters(id), account_id uuid NOT NULL REFERENCES accounts(id),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 60), joined_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(chapter_id,account_id)
);
CREATE TABLE chapter_invites (
 token_hash text PRIMARY KEY, chapter_id uuid NOT NULL REFERENCES chapters(id), expires_at timestamptz NOT NULL,
 used_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chapter_questions (
 id uuid PRIMARY KEY, chapter_id uuid NOT NULL REFERENCES chapters(id), author_id uuid NOT NULL REFERENCES accounts(id),
 call_id uuid NOT NULL UNIQUE REFERENCES calls(id), request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_connections (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), project_id uuid NOT NULL REFERENCES projects(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), repository text NOT NULL, file_path text NOT NULL, git_ref text NOT NULL,
 content_ciphertext text, source_sha text, fetched_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_agents (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), project_id uuid NOT NULL REFERENCES projects(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), instructions_ciphertext text NOT NULL, family text NOT NULL,
 connection_ids uuid[] NOT NULL DEFAULT '{}', interval_hours integer NOT NULL CHECK(interval_hours BETWEEN 1 AND 168),
 per_run_usd6 bigint NOT NULL CHECK(per_run_usd6 BETWEEN 1 AND 10000000), total_usd6 bigint NOT NULL CHECK(total_usd6 BETWEEN 1 AND 1000000000),
 enabled boolean NOT NULL DEFAULT false, next_run_at timestamptz NOT NULL DEFAULT now(), last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, CHECK(total_usd6>=per_run_usd6)
);
CREATE TABLE workspace_agent_runs (
 id uuid PRIMARY KEY, agent_id uuid NOT NULL REFERENCES workspace_agents(id), call_id uuid NOT NULL UNIQUE REFERENCES calls(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_agents_due ON workspace_agents(next_run_at) WHERE enabled AND deleted_at IS NULL;
CREATE INDEX workspace_agent_runs_agent ON workspace_agent_runs(agent_id,created_at DESC);
CREATE INDEX chapter_questions_feed ON chapter_questions(chapter_id,created_at DESC);

-- This also covers owner requests made through ordinary chat APIs for the Chapter project.
CREATE FUNCTION enforce_chapter_allowance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c chapters%ROWTYPE; spent bigint;
BEGIN
 SELECT ch.* INTO c FROM chapters ch JOIN quotes q ON q.project_id=ch.project_id WHERE q.id=NEW.quote_id FOR UPDATE OF ch;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF c.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Chapter unavailable' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(CASE WHEN h.state IN ('held','running','reconciliation_pending') THEN h.maximum_usd6
   WHEN h.created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN COALESCE(h.captured_usd6,0) ELSE 0 END),0)
 INTO spent FROM holds h JOIN quotes q ON q.id=h.quote_id WHERE q.project_id=c.project_id;
 IF spent+NEW.maximum_usd6>c.monthly_usd6 THEN RAISE EXCEPTION 'Chapter monthly allowance exceeded' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chapter_allowance BEFORE INSERT ON holds FOR EACH ROW EXECUTE FUNCTION enforce_chapter_allowance();
ALTER TABLE chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapter_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapter_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapter_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_agent_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chapters,chapter_members,chapter_invites,chapter_questions,workspace_connections,workspace_agents,workspace_agent_runs FROM PUBLIC;
CREATE TABLE receipt_signer_keys (
 key_id text NOT NULL, epoch integer NOT NULL, public_key text NOT NULL,
 valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(key_id,epoch)
);
ALTER TABLE receipt_signer_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON receipt_signer_keys FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_chapter_allowance() FROM PUBLIC;
DO $$ BEGIN
 IF to_regprocedure('apply_row_security()') IS NOT NULL THEN PERFORM apply_row_security(); END IF;
END $$;

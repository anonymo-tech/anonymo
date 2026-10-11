CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE identities (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('solana', 'passkey')),
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, subject)
);

CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_account ON sessions (account_id);

CREATE TABLE rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX projects_owner ON projects (account_id, updated_at DESC);

CREATE TABLE route_versions (
  id uuid PRIMARY KEY,
  route_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  model_id text NOT NULL,
  family text NOT NULL,
  modality text NOT NULL CHECK (modality IN ('chat','image','video')),
  enabled boolean NOT NULL DEFAULT false,
  card jsonb NOT NULL,
  pricing jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, version)
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('available','reserved','clearing','revenue')),
  balance_usd6 bigint NOT NULL DEFAULT 0,
  CHECK ((owner_id IS NOT NULL AND kind IN ('available','reserved')) OR
         (owner_id IS NULL AND kind IN ('clearing','revenue'))),
  CHECK (kind NOT IN ('available','reserved') OR balance_usd6 >= 0),
  UNIQUE NULLS NOT DISTINCT (owner_id, kind)
);

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('deposit','hold','capture','release','refund')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  ledger_account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_usd6 bigint NOT NULL CHECK (amount_usd6 <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, ledger_account_id)
);
CREATE INDEX ledger_entries_account ON ledger_entries (ledger_account_id, id);

CREATE FUNCTION apply_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_transactions WHERE id = NEW.transaction_id AND xmin::text = pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Entries must be inserted with their transaction' USING ERRCODE = '23514';
  END IF;
  UPDATE ledger_accounts SET balance_usd6 = balance_usd6 + NEW.amount_usd6
    WHERE id = NEW.ledger_account_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER apply_ledger_entry AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();

CREATE FUNCTION assert_balanced_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; entry_count bigint;
BEGIN
  SELECT COALESCE(sum(amount_usd6), 0), count(*) INTO total, entry_count
    FROM ledger_entries WHERE transaction_id = NEW.id;
  IF total <> 0 OR entry_count < 2 THEN
    RAISE EXCEPTION 'Unbalanced ledger transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balanced_transaction AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_balanced_transaction();

CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger records are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_ledger_entries BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER immutable_ledger_transactions BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TABLE quotes (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  route_version_id uuid NOT NULL REFERENCES route_versions(id),
  request_hash text NOT NULL,
  max_usd6 bigint NOT NULL CHECK (max_usd6 > 0),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 32768),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE holds (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  maximum_usd6 bigint NOT NULL CHECK (maximum_usd6 > 0),
  captured_usd6 bigint CHECK (captured_usd6 >= 0 AND captured_usd6 <= maximum_usd6),
  state text NOT NULL CHECK (state IN ('held','running','captured','released','reconciliation_pending')),
  provider_reference text,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE calls (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  hold_id uuid NOT NULL UNIQUE REFERENCES holds(id),
  route_version_id uuid NOT NULL REFERENCES route_versions(id),
  input_ciphertext text NOT NULL,
  output_ciphertext text,
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled','reconciliation_pending')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_owner ON calls (account_id, project_id, created_at DESC);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  reference text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_runnable ON jobs (run_after) WHERE state = 'queued';

CREATE TABLE briefs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body_ciphertext text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

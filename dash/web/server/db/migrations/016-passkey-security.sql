ALTER TABLE identities ADD COLUMN revoked_at timestamptz;
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD CONSTRAINT sessions_public_id UNIQUE (id);
ALTER TABLE sessions ADD COLUMN identity_id uuid REFERENCES identities(id);
ALTER TABLE sessions ADD COLUMN browser_hash text CHECK (browser_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX sessions_browser ON sessions(browser_hash) WHERE browser_hash IS NOT NULL;

CREATE TABLE auth_security_grants (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES accounts(id),
  session_token_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('add-passkey','link-wallet','remove-identity','revoke-sessions')),
  target text CHECK (length(target) <= 128),
  identity_id uuid NOT NULL REFERENCES identities(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '120 seconds'),
  CHECK ((action='add-passkey') = (target IS NULL))
);
CREATE INDEX auth_security_grants_expiry ON auth_security_grants(expires_at);

CREATE TABLE auth_security_challenges (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  session_token_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('wallet-reauth','link-wallet')),
  action text NOT NULL CHECK (action IN ('add-passkey','link-wallet','remove-identity','revoke-sessions')),
  target text CHECK (length(target) <= 128),
  identity_id uuid NOT NULL REFERENCES identities(id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CHECK ((action='add-passkey') = (target IS NULL))
);
CREATE INDEX auth_security_challenges_expiry ON auth_security_challenges(expires_at);

CREATE TABLE passkey_users (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  user_handle text NOT NULL UNIQUE CHECK (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  UNIQUE(account_id,user_handle)
);
CREATE TABLE passkeys (
  credential_id text PRIMARY KEY CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) BETWEEN 1 AND 1366),
  identity_id uuid NOT NULL UNIQUE REFERENCES identities(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  user_handle text NOT NULL,
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 32 AND 4096),
  counter bigint NOT NULL CHECK (counter BETWEEN 0 AND 4294967295),
  device_type text NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up boolean NOT NULL,
  transports text[] NOT NULL DEFAULT '{}' CHECK (cardinality(transports)<=8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  FOREIGN KEY (account_id,user_handle) REFERENCES passkey_users(account_id,user_handle),
  CHECK (device_type='multiDevice' OR NOT backed_up)
);
CREATE INDEX passkeys_account ON passkeys(account_id);

CREATE TABLE passkey_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('signup','login','add','reauth')),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  account_id uuid,
  user_handle text CHECK (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  session_token_hash text REFERENCES sessions(token_hash) ON DELETE CASCADE,
  authorizer_identity_id uuid REFERENCES identities(id),
  action text CHECK (action IN ('add-passkey','link-wallet','remove-identity','revoke-sessions')),
  target text CHECK (length(target)<=128),
  origin text NOT NULL CHECK (length(origin)<=2048),
  rp_id text NOT NULL CHECK (length(rp_id)<=253),
  allowed_credentials text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_credentials)<=16),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at<=created_at+interval '5 minutes'),
  CHECK ((purpose IN ('add','reauth')) = (session_token_hash IS NOT NULL)),
  CHECK ((purpose IN ('signup','add')) = (user_handle IS NOT NULL)),
  CHECK ((purpose='add') = (authorizer_identity_id IS NOT NULL)),
  CHECK ((purpose IN ('add','reauth')) = (action IS NOT NULL)),
  CHECK ((purpose='login') = (account_id IS NULL))
);
CREATE INDEX passkey_challenges_expiry ON passkey_challenges(expires_at);

CREATE FUNCTION protect_auth_proof_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
    OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'Authentication proof terms are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_security_grants_terms BEFORE UPDATE ON auth_security_grants FOR EACH ROW EXECUTE FUNCTION protect_auth_proof_terms();
CREATE TRIGGER auth_security_challenges_terms BEFORE UPDATE ON auth_security_challenges FOR EACH ROW EXECUTE FUNCTION protect_auth_proof_terms();
CREATE TRIGGER passkey_challenges_terms BEFORE UPDATE ON passkey_challenges FOR EACH ROW EXECUTE FUNCTION protect_auth_proof_terms();

CREATE FUNCTION protect_passkey_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['counter','backed_up','last_used_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['counter','backed_up','last_used_at']) OR NEW.counter<OLD.counter THEN
    RAISE EXCEPTION 'Passkey identity and key material are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER passkey_terms BEFORE UPDATE ON passkeys FOR EACH ROW EXECUTE FUNCTION protect_passkey_terms();
CREATE FUNCTION protect_passkey_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Passkey user handles are immutable'; END $$;
CREATE TRIGGER passkey_user_terms BEFORE UPDATE ON passkey_users FOR EACH ROW EXECUTE FUNCTION protect_passkey_user();

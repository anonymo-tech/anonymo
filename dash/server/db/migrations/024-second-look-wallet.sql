-- Private, account-scoped public-chain caches. Pasted addresses never prove control.
CREATE TABLE second_look_wallets (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  cluster text NOT NULL DEFAULT 'mainnet-beta' CHECK (cluster='mainnet-beta'),
  proof text NOT NULL DEFAULT 'unverified' CHECK (proof='unverified'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,address), UNIQUE(id,account_id)
);
CREATE TABLE second_look_wallet_jobs (
  wallet_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','idle','blocked')),
  cursor text CHECK (length(cursor)<=512),
  snapshot_id text CHECK (length(snapshot_id)<=128),
  pages integer NOT NULL DEFAULT 0 CHECK (pages>=0),
  exhausted boolean NOT NULL DEFAULT false,
  coverage jsonb CHECK (coverage IS NULL OR (jsonb_typeof(coverage)='object' AND octet_length(coverage::text)<=131072)),
  mode text NOT NULL DEFAULT 'backfill' CHECK(mode IN ('backfill','head')),
  source_revision text CHECK(source_revision ~ '^[a-f0-9]{64}$'),
  source_kind text CHECK (source_kind IN ('rpc','archive')),
  lease_token uuid,
  lease_until timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_sync_at timestamptz,
  error_code text CHECK (error_code ~ '^[A-Z_]{1,64}$'),
  dropped integer NOT NULL DEFAULT 0 CHECK (dropped>=0),
  FOREIGN KEY(wallet_id,account_id) REFERENCES second_look_wallets(id,account_id) ON DELETE CASCADE,
  CHECK ((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX second_look_wallet_jobs_queue ON second_look_wallet_jobs(next_run_at,wallet_id);
CREATE TABLE second_look_wallet_transactions (
  wallet_id uuid NOT NULL,
  account_id uuid NOT NULL,
  signature text NOT NULL CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  slot numeric(20,0) NOT NULL CHECK (slot>=0),
  state text NOT NULL CHECK (state IN ('pending','confirmed','finalized','unavailable')),
  snapshot_id text CHECK(length(snapshot_id)<=128),
  ledger jsonb CHECK (ledger IS NULL OR (jsonb_typeof(ledger)='object' AND octet_length(ledger::text)<=262144)),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  last_checked_at timestamptz,
  missing_observations integer NOT NULL DEFAULT 0 CHECK (missing_observations>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(wallet_id,signature),
  FOREIGN KEY(wallet_id,account_id) REFERENCES second_look_wallets(id,account_id) ON DELETE CASCADE,
  CHECK (state NOT IN ('confirmed','finalized') OR ledger IS NOT NULL)
);
CREATE INDEX second_look_wallet_transactions_account ON second_look_wallet_transactions(account_id,wallet_id,slot);
CREATE INDEX second_look_wallet_transactions_pending ON second_look_wallet_transactions(wallet_id,state,last_checked_at);
CREATE TABLE second_look_wallet_prices (
  wallet_id uuid NOT NULL,
  account_id uuid NOT NULL,
  mint text NOT NULL CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  price_at timestamptz NOT NULL,
  price jsonb CHECK (price IS NULL OR (jsonb_typeof(price)='object' AND octet_length(price::text)<=4096)),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(wallet_id,mint,price_at),
  FOREIGN KEY(wallet_id,account_id) REFERENCES second_look_wallets(id,account_id) ON DELETE CASCADE
);
-- Browser database clients have no policies or grants. Trusted server queries must
-- bind account_id explicitly; deployment roles are configured separately.
ALTER TABLE second_look_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE second_look_wallet_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE second_look_wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE second_look_wallet_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON second_look_wallets,second_look_wallet_jobs,second_look_wallet_transactions,second_look_wallet_prices FROM PUBLIC;

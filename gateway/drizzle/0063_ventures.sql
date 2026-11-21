-- WS11 · Anonymo Ventures (Ventures Backend PART 12). No email, name, IP address or user agent; the target url is never
-- stored in clear (ventures.target_commit = keccak256(salt || url)). Artifact bodies are purged after 30 days.
CREATE TABLE ventures (
  id text PRIMARY KEY,
  key_hash text NOT NULL,
  account_id text NOT NULL,
  mode text NOT NULL,
  target_commit text,
  tier text NOT NULL,
  caps jsonb NOT NULL,
  price bigint NOT NULL CHECK (price >= 0),
  paid_balance bigint NOT NULL DEFAULT 0 CHECK (paid_balance >= 0),
  cost bigint NOT NULL DEFAULT 0 CHECK (cost >= 0),
  status text NOT NULL,
  crew_key_hash text,
  crew_key_enc text,
  repo_url text,
  webhook_url text,
  recipe_id text,
  input_sha256 text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz
);
--> statement-breakpoint
CREATE INDEX ventures_key_idx ON ventures (key_hash, created_at);
--> statement-breakpoint
CREATE TABLE venture_steps (
  id text PRIMARY KEY,
  venture_id text NOT NULL,
  key text NOT NULL,
  role text NOT NULL,
  kind text NOT NULL,
  zone text NOT NULL CHECK (zone IN ('SCOUT', 'CLEAN')),
  fanout integer NOT NULL CHECK (fanout >= 1),
  select_mode text NOT NULL,
  needs text[] NOT NULL,
  state text NOT NULL,
  cost bigint NOT NULL DEFAULT 0,
  cap bigint NOT NULL,
  receipt_ids text[] NOT NULL,
  inputs jsonb NOT NULL,
  outputs jsonb NOT NULL,
  error text,
  position integer NOT NULL,
  started_at timestamptz,
  ended_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX venture_steps_key_uq ON venture_steps (venture_id, key);
--> statement-breakpoint
CREATE TABLE venture_artifacts (
  venture_id text NOT NULL,
  sha256 text NOT NULL,
  kind text NOT NULL,
  zone text NOT NULL CHECK (zone IN ('SCOUT', 'CLEAN')),
  name text,
  mime text,
  size integer NOT NULL,
  s3_key text,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, sha256)
);
--> statement-breakpoint
CREATE INDEX venture_artifacts_created_idx ON venture_artifacts (created_at);
--> statement-breakpoint
CREATE TABLE venture_candidates (
  id text PRIMARY KEY,
  venture_id text NOT NULL,
  step_id text NOT NULL,
  family text NOT NULL,
  model text NOT NULL,
  pass_rate real,
  lint_errors integer,
  type_errors integer,
  bundle_bytes integer,
  refused boolean NOT NULL DEFAULT false,
  chosen boolean NOT NULL DEFAULT false,
  receipt_id text,
  cost bigint NOT NULL DEFAULT 0,
  error text
);
--> statement-breakpoint
CREATE TABLE venture_specs (
  sha256 text PRIMARY KEY,
  venture_id text NOT NULL,
  leakage_scan jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE venture_licence_reports (
  id text PRIMARY KEY,
  venture_id text NOT NULL,
  build_sha text NOT NULL,
  spdx jsonb NOT NULL,
  decisions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE venture_deployments (
  id text PRIMARY KEY,
  venture_id text NOT NULL,
  target text NOT NULL,
  cid text,
  url text,
  status text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE venture_designs (
  venture_id text PRIMARY KEY,
  system jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE venture_recipes (
  id text PRIMARY KEY,
  creator_key_hash text NOT NULL,
  creator_account_id text NOT NULL,
  creator_wallet text,
  title text NOT NULL,
  summary text NOT NULL,
  mode text NOT NULL,
  dag jsonb NOT NULL,
  recipe_hash text NOT NULL,
  price bigint NOT NULL CHECK (price >= 0),
  runs integer NOT NULL DEFAULT 0,
  earned bigint NOT NULL DEFAULT 0,
  published boolean NOT NULL DEFAULT true,
  source_venture_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX venture_recipes_hash_uq ON venture_recipes (recipe_hash);
--> statement-breakpoint
CREATE TABLE venture_recipe_runs (
  order_ref text PRIMARY KEY,
  recipe_id text NOT NULL,
  venture_id text NOT NULL,
  creator_share bigint NOT NULL,
  onchain_tx text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE venture_run_mode (
  venture_id text PRIMARY KEY,
  enabled boolean NOT NULL,
  daily_cap bigint NOT NULL CHECK (daily_cap >= 0),
  hours_per_day integer NOT NULL,
  tasks text[] NOT NULL,
  day text,
  spent_today bigint NOT NULL DEFAULT 0,
  ticks_today integer NOT NULL DEFAULT 0,
  next_tick_at timestamptz,
  target_enc text,
  last_spec_hash text,
  last_brief_sha text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE venture_forks (
  fork_id text PRIMARY KEY,
  chain_id integer NOT NULL,
  target_commit text NOT NULL,
  spec_hash text,
  status text NOT NULL,
  venture_id text,
  repo_hash text,
  receipt_root text,
  usdg_routed numeric,
  target_enc text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE venture_fuel (
  wallet text NOT NULL,
  day text NOT NULL,
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (wallet, day)
);
--> statement-breakpoint
CREATE TABLE venture_orders (
  order_id text PRIMARY KEY,
  chain_id integer NOT NULL,
  sku text NOT NULL,
  payer text NOT NULL,
  qty integer NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL,
  used_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

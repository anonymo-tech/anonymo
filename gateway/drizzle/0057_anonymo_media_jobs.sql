-- WS06 · Media: asynchronous video jobs. Metadata only: no prompt, no output, no client address.
CREATE TABLE media_jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  key_hash text,
  hold_id text NOT NULL,
  model text NOT NULL,
  upstream text NOT NULL,
  upstream_ref text,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'finishing', 'completed', 'failed', 'blocked')),
  seconds integer NOT NULL CHECK (seconds > 0),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  explicit_allowed boolean NOT NULL,
  price_pico bigint NOT NULL CHECK (price_pico >= 0),
  charged_pico bigint CHECK (charged_pico >= 0),
  error_type text,
  media_id text,
  media_expires_at timestamptz,
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX media_jobs_account_idx ON media_jobs(account_id, created_at);
--> statement-breakpoint
CREATE INDEX media_jobs_status_idx ON media_jobs(status, updated_at);

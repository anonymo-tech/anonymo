CREATE TABLE telegram_links (
  telegram_hash text PRIMARY KEY,
  key_hash text NOT NULL
);
--> statement-breakpoint
CREATE TABLE telegram_tokens (
  token_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('link', 'handoff', 'session', 'trial')),
  telegram_hash text,
  key_hash text,
  proof text,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX telegram_tokens_expiry_idx ON telegram_tokens (expires_at);
--> statement-breakpoint
CREATE TABLE stars_orders (
  telegram_payment_charge_id text PRIMARY KEY,
  key_hash text NOT NULL,
  stars integer NOT NULL CHECK (stars > 0),
  credited_pico bigint NOT NULL CHECK (credited_pico >= 0),
  ts timestamptz NOT NULL DEFAULT now(),
  refunded_at timestamptz
);

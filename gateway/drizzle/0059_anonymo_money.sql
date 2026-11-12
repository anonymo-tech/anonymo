CREATE TABLE anonymo_keys (
  key_hash text PRIMARY KEY,
  wallet text,
  daily_cap bigint CHECK (daily_cap >= 0),
  monthly_cap bigint CHECK (monthly_cap >= 0),
  lifetime_cap bigint CHECK (lifetime_cap >= 0),
  ip_allow text[],
  sealed_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE anonymo_deposit_addresses (
  key_hash text NOT NULL,
  chain text NOT NULL,
  address text NOT NULL,
  derivation_index integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_hash, chain)
);
--> statement-breakpoint
CREATE UNIQUE INDEX anonymo_deposit_addresses_address_uq ON anonymo_deposit_addresses (chain, address);
--> statement-breakpoint
CREATE TABLE anonymo_deposits (
  ref text PRIMARY KEY,
  key_hash text NOT NULL,
  chain text NOT NULL,
  token text NOT NULL DEFAULT '',
  amount_raw numeric(78, 0),
  amount_pico bigint NOT NULL CHECK (amount_pico > 0),
  source_addr text NOT NULL,
  status text NOT NULL CHECK (status IN ('credited', 'held')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  credited_at timestamptz
);
--> statement-breakpoint
CREATE INDEX anonymo_deposits_key_idx ON anonymo_deposits (key_hash, chain, source_addr);
--> statement-breakpoint
CREATE INDEX anonymo_deposits_status_idx ON anonymo_deposits (status);
--> statement-breakpoint
CREATE TABLE anonymo_withdrawals (
  id text PRIMARY KEY,
  key_hash text NOT NULL,
  account_id text NOT NULL,
  idempotency_key text NOT NULL,
  chain text NOT NULL,
  token text NOT NULL,
  to_addr text NOT NULL,
  amount_pico bigint NOT NULL CHECK (amount_pico > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'reverted')),
  tx_ref text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX anonymo_withdrawals_idem_uq ON anonymo_withdrawals (key_hash, idempotency_key);
--> statement-breakpoint
CREATE INDEX anonymo_withdrawals_to_idx ON anonymo_withdrawals (key_hash, chain, to_addr);
--> statement-breakpoint
CREATE INDEX anonymo_withdrawals_status_idx ON anonymo_withdrawals (status);
--> statement-breakpoint
CREATE TABLE anonymo_btcpay_invoices (
  invoice_id text PRIMARY KEY,
  key_hash text NOT NULL,
  refund_chain text NOT NULL CHECK (refund_chain IN ('btc', 'ln')),
  refund_addr text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE anonymo_sanctions (
  address text PRIMARY KEY,
  family text NOT NULL,
  list_date timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

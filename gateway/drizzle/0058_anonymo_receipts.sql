-- WS09: Anonymo receipts (Backend §8) and their hourly Merkle roots. Metadata only: ids, routes, hashes, counts and
-- amounts. No prompt or output text is stored.
CREATE TABLE anonymo_receipts (
  id text PRIMARY KEY,
  model_id text NOT NULL,
  payload jsonb NOT NULL,
  sig text NOT NULL,
  key_id text NOT NULL,
  leaf text NOT NULL,
  issued_at timestamptz NOT NULL,
  root_hour bigint,
  leaf_index integer
);
--> statement-breakpoint
CREATE INDEX anonymo_receipts_unrooted_idx ON anonymo_receipts(root_hour, issued_at);
--> statement-breakpoint
CREATE INDEX anonymo_receipts_root_idx ON anonymo_receipts(root_hour, leaf_index);
--> statement-breakpoint
CREATE TABLE anonymo_receipt_roots (
  hour bigint PRIMARY KEY,
  root text NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  status text NOT NULL CHECK (status IN ('local', 'pending', 'posted', 'failed')),
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz
);

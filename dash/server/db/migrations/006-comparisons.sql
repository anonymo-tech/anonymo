CREATE TABLE comparisons (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  blind boolean NOT NULL DEFAULT false,
  revealed_at timestamptz,
  voted_call_id uuid REFERENCES calls(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,idempotency_key)
);
CREATE INDEX comparisons_project ON comparisons(account_id,project_id,created_at DESC,id DESC);

CREATE TABLE comparison_calls (
  comparison_id uuid NOT NULL REFERENCES comparisons(id),
  call_id uuid NOT NULL UNIQUE REFERENCES calls(id),
  position integer NOT NULL CHECK(position BETWEEN 0 AND 3),
  PRIMARY KEY(comparison_id,position)
);

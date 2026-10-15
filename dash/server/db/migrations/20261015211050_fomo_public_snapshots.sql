-- Dated public research only. No account-owned reports or model responses.
CREATE TABLE fomo_public_snapshots (
  id text PRIMARY KEY CHECK (id='top10-30d'),
  generated_at timestamptz NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND octet_length(document::text)<=8000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fomo_public_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fomo_public_snapshots FROM PUBLIC;
-- Hosted service-role policies and narrow grants are applied in the deployment.

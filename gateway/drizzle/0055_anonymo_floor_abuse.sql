CREATE TABLE abuse_reports (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ncii', 'csam', 'other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'rejected')),
  reference text CHECK (reference IS NULL OR length(reference) <= 200),
  hashes_sha256 jsonb NOT NULL DEFAULT '[]'::jsonb,
  details_enc text,
  contact_enc text,
  received_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  actioned_at timestamptz,
  action text CHECK (action IS NULL OR action IN ('blocked', 'reported', 'rejected')),
  tipline_report_id text
);
--> statement-breakpoint
CREATE INDEX abuse_reports_status_due_idx ON abuse_reports(status, due_at);
--> statement-breakpoint
CREATE TABLE abuse_hash_blocks (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  category text NOT NULL CHECK (category IN ('minor', 'real_person', 'voice_clone', 'cbrn')),
  source text NOT NULL CHECK (source IN ('takedown', 'report', 'operator')),
  report_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE preservation (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('floor_hit', 'takedown')),
  source_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('minor', 'real_person', 'voice_clone', 'cbrn')),
  tipline_report_id text NOT NULL,
  blob_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX preservation_expires_idx ON preservation(expires_at);

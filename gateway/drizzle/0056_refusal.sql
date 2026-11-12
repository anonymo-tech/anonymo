-- WS03 · refusal catch (Backend §5). Counts only: no prompt or reply text is stored.
CREATE TABLE refusal_stats (
  route_id text NOT NULL,
  day date NOT NULL,
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  refused integer NOT NULL DEFAULT 0 CHECK (refused >= 0 AND refused <= total),
  PRIMARY KEY (route_id, day)
);
--> statement-breakpoint
CREATE TABLE refusal_key_settings (
  key_hash text PRIMARY KEY,
  catch_enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- WS04: the Anonymo route record (Backend §4) lives on the offer (model x provider). Every column is nullable: offers
-- that are not Anonymo routes keep routing exactly as before.
ALTER TABLE offers ADD COLUMN family text;
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN weights_hash text CHECK (weights_hash IS NULL OR weights_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN tier integer CHECK (tier IS NULL OR tier BETWEEN 0 AND 3);
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN upstream text;
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN upstream_id text;
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN quality_rank real CHECK (quality_rank IS NULL OR (quality_rank >= 0 AND quality_rank <= 100));
--> statement-breakpoint
CREATE INDEX offers_upstream_id_idx ON offers(upstream_id) WHERE upstream_id IS NOT NULL;

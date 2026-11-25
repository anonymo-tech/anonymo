CREATE TABLE "region_policy" (
  "region" text PRIMARY KEY,
  "mode" text NOT NULL CONSTRAINT "region_policy_mode" CHECK ("mode" IN ('allowed', 'blocked', 'proof_required')),
  "disclosure_interval_min" integer CONSTRAINT "region_policy_interval" CHECK ("disclosure_interval_min" > 0),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "age_proofs" (
  "nullifier" bytea PRIMARY KEY,
  "key_hash" bytea NOT NULL,
  "verified_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "age_proofs_key_hash_idx" ON "age_proofs" ("key_hash");
--> statement-breakpoint
-- Seed the legacy lists. Age-check regions can open with a proof unless separately blocked by OFAC.
INSERT INTO "region_policy" ("region", "mode")
SELECT region, CASE MAX(priority) WHEN 2 THEN 'proof_required' ELSE 'blocked' END
FROM (
  SELECT unnest(ARRAY['CU', 'IR', 'KP', 'SY', 'UA-43', 'UA-40', 'UA-14', 'UA-09', 'UA-23', 'UA-65']) AS region, 3 AS priority
  UNION ALL
  SELECT unnest(ARRAY[
    'RU', 'BY', 'SA', 'AE', 'QA', 'OM', 'KW', 'BH', 'YE', 'IQ', 'ID', 'BD', 'TR', 'MA', 'DJ', 'UG', 'TZ', 'BW', 'PK',
    'IN', 'KR', 'CN', 'EG', 'LY', 'SD', 'SO', 'ER', 'ET', 'BF', 'GQ', 'AF', 'NP', 'VN', 'TH', 'UZ', 'MY', 'BN',
    'TM', 'TJ', 'MM', 'GB', 'FR', 'DE', 'AU', 'BR', 'US-CA', 'US-CO'
  ]), 1
  UNION ALL
  SELECT unnest(ARRAY[
    'GB', 'US-AL', 'US-AR', 'US-AZ', 'US-FL', 'US-GA', 'US-IA', 'US-ID', 'US-IN', 'US-KS', 'US-KY', 'US-LA', 'US-MO',
    'US-MS', 'US-MT', 'US-NC', 'US-ND', 'US-NE', 'US-OH', 'US-OK', 'US-SC', 'US-SD', 'US-TN', 'US-TX', 'US-UT', 'US-VA',
    'US-WV', 'US-WY'
  ]), 2
) AS defaults
GROUP BY region;

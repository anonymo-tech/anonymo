CREATE TABLE "codes" (
  "code_hash" bytea PRIMARY KEY,
  "face_usd" numeric NOT NULL,
  "batch_id" uuid NOT NULL,
  "reseller_id" uuid NOT NULL,
  "redeemed_by" bytea,
  "redeemed_at" timestamptz,
  CONSTRAINT "codes_face_usd_check" CHECK ("face_usd" IN (5, 10, 25, 50)),
  CONSTRAINT "codes_digest_check" CHECK (octet_length("code_hash") = 32 AND octet_length("redeemed_by") = 32),
  CONSTRAINT "codes_redemption_check" CHECK (("redeemed_by" IS NULL) = ("redeemed_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "codes_reseller_batch_idx" ON "codes" ("reseller_id", "batch_id");

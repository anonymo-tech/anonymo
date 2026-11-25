CREATE TABLE "pass_orders" (
  "order_id" text PRIMARY KEY,
  "key_hash" text NOT NULL,
  "sku" text NOT NULL CHECK ("sku" IN ('PASS30', 'PASS30_PLUS'))
);
--> statement-breakpoint
CREATE TABLE "passes" (
  "order_id" text PRIMARY KEY REFERENCES "pass_orders" ("order_id"),
  "key_hash" text NOT NULL,
  "sku" text NOT NULL CHECK ("sku" IN ('PASS30', 'PASS30_PLUS')),
  "starts" timestamptz NOT NULL,
  "ends" timestamptz NOT NULL CHECK ("ends" > "starts")
);
--> statement-breakpoint
CREATE INDEX "passes_key_ends_idx" ON "passes" ("key_hash", "ends");
--> statement-breakpoint
CREATE TABLE "stake_links" (
  "wallet" text PRIMARY KEY,
  "key_hash" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "stake_checkpoints" (
  "contract" text NOT NULL,
  "wallet" text NOT NULL,
  "at" bigint NOT NULL,
  "balance" numeric(78,0) NOT NULL CHECK ("balance" >= 0),
  PRIMARY KEY ("contract", "wallet", "at")
);
--> statement-breakpoint
CREATE TABLE "daily_mo_credits" (
  "key_hash" text NOT NULL,
  "day" date NOT NULL,
  "amount" bigint NOT NULL CHECK ("amount" > 0),
  PRIMARY KEY ("key_hash", "day")
);
--> statement-breakpoint
CREATE INDEX "holds_everyday_bucket_idx" ON "holds" ("key_hash", (("result"->'everyday'->>'bucket')))
  WHERE "result"->'everyday' IS NOT NULL;

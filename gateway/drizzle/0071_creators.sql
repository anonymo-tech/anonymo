CREATE TABLE "creator_characters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "card_hash" text NOT NULL UNIQUE,
  "creator_wallet" text NOT NULL,
  "share_bps" integer NOT NULL CONSTRAINT "creator_share_bps" CHECK ("share_bps" BETWEEN 0 AND 1500),
  "name" text NOT NULL,
  "description" text NOT NULL,
  "personality" text NOT NULL,
  "scenario" text NOT NULL,
  "tags" text[] NOT NULL,
  "adult" boolean NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  "floor_verdict" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_accruals" (
  "character_id" uuid NOT NULL REFERENCES "creator_characters" ("id"),
  "day" date NOT NULL,
  "amount" bigint NOT NULL DEFAULT 0,
  "allocated" bigint NOT NULL DEFAULT 0,
  "spend" bigint NOT NULL DEFAULT 0,
  "chats" integer NOT NULL,
  "funded_keys" integer NOT NULL,
  "held_until" timestamptz NOT NULL,
  "frozen" boolean NOT NULL DEFAULT false,
  "reviewed" boolean NOT NULL DEFAULT false,
  "payout_week" date,
  PRIMARY KEY ("character_id", "day")
);
--> statement-breakpoint
CREATE TABLE "payout_roots" (
  "week" date PRIMARY KEY,
  "root" text NOT NULL,
  "total" text NOT NULL,
  "tx" text,
  "leaves" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_referral_links" (
  "code" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "inviter_key_hash" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "creator_referrals" (
  "invitee_key_hash" text PRIMARY KEY,
  "invitee_account_id" text NOT NULL UNIQUE,
  "code" uuid NOT NULL REFERENCES "creator_referral_links" ("code"),
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  "funded_at" timestamptz,
  "spend_credit" bigint NOT NULL DEFAULT 0,
  "registered_tx" text
);

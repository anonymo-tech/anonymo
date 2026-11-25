CREATE TABLE "party_rooms" (
  "id" uuid PRIMARY KEY,
  "host_key_hash" bytea NOT NULL,
  "ruleset" text NOT NULL,
  "players" integer NOT NULL CHECK ("players" BETWEEN 0 AND 6),
  "mature" boolean NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dice_commits" (
  "room_id" uuid NOT NULL REFERENCES "party_rooms" ("id"),
  "roll_no" integer NOT NULL,
  "commit" bytea NOT NULL,
  "reveal" bytea,
  PRIMARY KEY ("room_id", "roll_no")
);

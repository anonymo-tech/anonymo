CREATE TABLE "designed_voices" (
  "id" uuid PRIMARY KEY,
  "key_hash" bytea NOT NULL CHECK (octet_length("key_hash") = 32),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 60),
  "embedding" bytea NOT NULL CHECK (octet_length("embedding") BETWEEN 32 AND 16384 AND octet_length("embedding") % 4 = 0),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "designed_voices_key_hash_idx" ON "designed_voices" ("key_hash");

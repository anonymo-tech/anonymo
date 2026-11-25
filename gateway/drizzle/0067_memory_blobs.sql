CREATE TABLE "memory_blobs" (
  "vault_id" bytea NOT NULL CHECK (octet_length("vault_id") = 32),
  "item_id" uuid NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  "ciphertext" bytea NOT NULL,
  "deleted" boolean NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("vault_id", "item_id"),
  CHECK (("deleted" AND octet_length("ciphertext") = 0)
    OR (NOT "deleted" AND octet_length("ciphertext") BETWEEN 29 AND 8192))
);

CREATE TABLE "key_safes" (
	"safe_id" bytea PRIMARY KEY NOT NULL,
	"credential_id" bytea NOT NULL UNIQUE,
	"ciphertext" bytea NOT NULL,
	"nonce" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

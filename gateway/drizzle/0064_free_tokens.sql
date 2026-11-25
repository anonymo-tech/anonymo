CREATE TABLE "free_tokens" (
  "device_token" bytea PRIMARY KEY NOT NULL CHECK (octet_length("device_token") = 32),
  "day" date NOT NULL,
  "used" integer NOT NULL CHECK ("used" > 0),
  "pow_difficulty" integer NOT NULL CHECK ("pow_difficulty" BETWEEN 1 AND 24)
);

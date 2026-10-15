-- Encrypted preferences and reminder drafts. No execution or notification grants.
CREATE TABLE second_look_planning (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  settings_ciphertext text NOT NULL CHECK (octet_length(settings_ciphertext) <= 16384),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE second_look_exit_plans (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES second_look_planning(account_id) ON DELETE CASCADE,
  wallet_id uuid NOT NULL,
  payload_ciphertext text NOT NULL CHECK (octet_length(payload_ciphertext) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, account_id) REFERENCES second_look_wallets(id, account_id) ON DELETE CASCADE
);
CREATE INDEX second_look_exit_plans_owner ON second_look_exit_plans(account_id, created_at, id);
CREATE INDEX second_look_exit_plans_wallet ON second_look_exit_plans(wallet_id, account_id);
ALTER TABLE second_look_planning ENABLE ROW LEVEL SECURITY;
ALTER TABLE second_look_exit_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON second_look_planning, second_look_exit_plans FROM PUBLIC;

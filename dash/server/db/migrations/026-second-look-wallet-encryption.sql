-- Never silently retain or transform pre-existing plaintext account associations.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM second_look_wallets) OR EXISTS(SELECT 1 FROM second_look_wallet_jobs)
     OR EXISTS(SELECT 1 FROM second_look_wallet_transactions) OR EXISTS(SELECT 1 FROM second_look_wallet_prices) THEN
    RAISE EXCEPTION 'Wallet cache requires an explicit offline encrypted conversion before migration026';
  END IF;
END $$;
ALTER TABLE second_look_wallets DROP CONSTRAINT second_look_wallets_account_id_address_key;
ALTER TABLE second_look_wallets DROP COLUMN address, DROP COLUMN label;
ALTER TABLE second_look_wallets ADD COLUMN address_digest text NOT NULL CHECK(address_digest ~ '^[a-zA-Z0-9_-]{1,40}\.[a-f0-9]{64}$'),
  ADD COLUMN address_ciphertext text NOT NULL CHECK(length(address_ciphertext) BETWEEN 30 AND 1024),
  ADD COLUMN label_ciphertext text NOT NULL CHECK(length(label_ciphertext) BETWEEN 30 AND 2048),
  ADD COLUMN assets_ciphertext text NOT NULL CHECK(length(assets_ciphertext) BETWEEN 30 AND 131072),
  ADD UNIQUE(account_id,address_digest);
ALTER TABLE second_look_wallet_jobs DROP COLUMN cursor,DROP COLUMN snapshot_id,DROP COLUMN coverage;
ALTER TABLE second_look_wallet_jobs ADD COLUMN cursor_ciphertext text CHECK(length(cursor_ciphertext)<=2048),
  ADD COLUMN snapshot_ciphertext text CHECK(length(snapshot_ciphertext)<=1024),
  ADD COLUMN coverage_ciphertext text CHECK(length(coverage_ciphertext)<=262144);
ALTER TABLE second_look_wallet_transactions DROP CONSTRAINT second_look_wallet_transactions_pkey;
ALTER TABLE second_look_wallet_transactions DROP COLUMN signature,DROP COLUMN ledger,DROP COLUMN snapshot_id;
ALTER TABLE second_look_wallet_transactions ADD COLUMN signature_digest text NOT NULL CHECK(signature_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN locator_ciphertext text NOT NULL CHECK(length(locator_ciphertext)<=2048),
  ADD COLUMN ledger_ciphertext text CHECK(length(ledger_ciphertext)<=524288),
  ADD COLUMN snapshot_digest text CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  ADD PRIMARY KEY(wallet_id,signature_digest),
  ADD CHECK(state NOT IN ('confirmed','finalized') OR ledger_ciphertext IS NOT NULL);
ALTER TABLE second_look_wallet_prices DROP CONSTRAINT second_look_wallet_prices_pkey;
ALTER TABLE second_look_wallet_prices DROP COLUMN mint,DROP COLUMN price;
ALTER TABLE second_look_wallet_prices ADD COLUMN price_digest text NOT NULL CHECK(price_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN price_ciphertext text NOT NULL CHECK(length(price_ciphertext)<=8192),
  ADD COLUMN priced boolean NOT NULL DEFAULT false,
  ADD COLUMN kind text NOT NULL CHECK(kind IN ('historical','mark')),
  ADD PRIMARY KEY(wallet_id,price_digest);

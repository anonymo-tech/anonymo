-- Rename the provider stake column to anmo_stake. Generic on purpose: whatever *_stake column providers has, if it is
-- not already anmo_stake, is renamed; on a database that already has anmo_stake this does nothing.
DO $$
DECLARE old_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'providers' AND column_name = 'anmo_stake') THEN
    SELECT column_name INTO old_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'providers' AND column_name LIKE '%\_stake' AND column_name <> 'anmo_stake' LIMIT 1;
    IF old_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE "providers" RENAME COLUMN %I TO "anmo_stake"', old_name);
    END IF;
  END IF;
END $$;

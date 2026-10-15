CREATE TABLE second_look_telegram_links (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  telegram_user_id bigint NOT NULL UNIQUE CHECK (telegram_user_id > 0),
  delivery_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE second_look_telegram_link_challenges (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  telegram_user_id bigint CHECK (telegram_user_id > 0),
  exchanged_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK ((telegram_user_id IS NULL) = (exchanged_at IS NULL)),
  CHECK (confirmed_at IS NULL OR exchanged_at IS NOT NULL)
);
CREATE INDEX second_look_telegram_link_expiry ON second_look_telegram_link_challenges(expires_at);
CREATE TABLE second_look_telegram_updates (
  bot_id bigint NOT NULL CHECK (bot_id > 0),
  update_id bigint NOT NULL CHECK (update_id >= 0),
  telegram_user_id bigint NOT NULL CHECK (telegram_user_id > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_ciphertext text NOT NULL CHECK (length(payload_ciphertext) BETWEEN 40 AND 100000),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','complete','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_id uuid,
  lease_expires_at timestamptz,
  quota_charged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY(bot_id,update_id),
  CHECK ((state='processing') = (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX second_look_telegram_pending ON second_look_telegram_updates(bot_id,state,created_at);
CREATE TABLE second_look_telegram_outbox (
  id uuid PRIMARY KEY,
  bot_id bigint NOT NULL,
  update_id bigint NOT NULL,
  method text NOT NULL CHECK (method IN ('sendMessage','answerInlineQuery')),
  payload_ciphertext text NOT NULL CHECK (length(payload_ciphertext) BETWEEN 40 AND 100000),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatching','delivered','uncertain','failed')),
  dispatch_id uuid,
  dispatched_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(bot_id,update_id),
  FOREIGN KEY(bot_id,update_id) REFERENCES second_look_telegram_updates(bot_id,update_id),
  CHECK ((dispatch_id IS NULL) = (dispatched_at IS NULL)),
  CHECK (state <> 'pending' OR dispatch_id IS NULL)
);
CREATE INDEX second_look_telegram_delivery ON second_look_telegram_outbox(bot_id,state,created_at);
CREATE FUNCTION preserve_second_look_telegram() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'second_look_telegram_updates' THEN
    IF (NEW.bot_id,NEW.update_id,NEW.telegram_user_id,NEW.payload_hash,NEW.payload_ciphertext,NEW.created_at)
       IS DISTINCT FROM (OLD.bot_id,OLD.update_id,OLD.telegram_user_id,OLD.payload_hash,OLD.payload_ciphertext,OLD.created_at)
       OR NEW.attempts < OLD.attempts OR (OLD.quota_charged AND NOT NEW.quota_charged)
       OR (OLD.state IN ('complete','failed') AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'immutable Telegram update'; END IF;
  ELSE
    IF (NEW.id,NEW.bot_id,NEW.update_id,NEW.method,NEW.payload_ciphertext,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.bot_id,OLD.update_id,OLD.method,OLD.payload_ciphertext,OLD.created_at)
       OR (OLD.dispatched_at IS NOT NULL AND (NEW.dispatch_id,NEW.dispatched_at) IS DISTINCT FROM (OLD.dispatch_id,OLD.dispatched_at))
       OR (OLD.state IN ('delivered','uncertain','failed') AND NEW IS DISTINCT FROM OLD)
       OR (NEW.state='pending' AND OLD.state<>'pending')
    THEN RAISE EXCEPTION 'immutable Telegram delivery'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER second_look_telegram_update_immutable BEFORE UPDATE ON second_look_telegram_updates FOR EACH ROW EXECUTE FUNCTION preserve_second_look_telegram();
CREATE TRIGGER second_look_telegram_outbox_immutable BEFORE UPDATE ON second_look_telegram_outbox FOR EACH ROW EXECUTE FUNCTION preserve_second_look_telegram();

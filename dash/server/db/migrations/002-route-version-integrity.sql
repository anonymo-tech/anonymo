CREATE FUNCTION preserve_route_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'enabled') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled') THEN
    RAISE EXCEPTION 'Publish a new route version instead of changing accepted terms' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_route_version BEFORE UPDATE ON route_versions
  FOR EACH ROW EXECUTE FUNCTION preserve_route_version();

-- Chat settlement reconciliation records. Ledger shape, balancing and
-- immutability are unchanged: every resolution still settles through the one
-- capture/release/burn-accrual path.
--
-- A hold whose exact cost could not be confirmed (reconciliation_pending)
-- keeps what the worker observed: the reason, the canonical cost it last saw
-- (if any), the reported token counts and whether the run was being stopped.
-- A settlement whose canonical cost exceeded the reservation captures exactly
-- the reserved maximum and records the uncaptured excess here, never as an
-- extra debit. An operator resolves a pending hold once
-- (scripts/reconcile-holds.mjs); a resolved record is immutable.
CREATE TABLE hold_reconciliations (
  hold_id uuid PRIMARY KEY REFERENCES holds(id),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  -- The canonical base charge (after route markup, before any platform fee).
  observed_usd6 bigint CHECK (observed_usd6 >= 0),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  total_tokens integer CHECK (total_tokens >= 0),
  stopped boolean NOT NULL DEFAULT false,
  overage_usd6 bigint CHECK (overage_usd6 > 0),
  resolution text CHECK (resolution IN ('capped','settled_usage','settled_max','released')),
  -- The amount the hold finally captured, platform fee included.
  resolved_usd6 bigint CHECK (resolved_usd6 >= 0),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolution IS NULL) = (resolved_at IS NULL)),
  CHECK ((resolution IS NULL) = (resolved_usd6 IS NULL)),
  CHECK (overage_usd6 IS NULL OR resolution IN ('capped','settled_usage')),
  CHECK (resolution IS DISTINCT FROM 'capped' OR overage_usd6 IS NOT NULL),
  CHECK (resolution IS DISTINCT FROM 'released' OR resolved_usd6 = 0)
);
CREATE INDEX hold_reconciliations_open ON hold_reconciliations (created_at)
  WHERE resolution IS NULL;
CREATE INDEX holds_reconciliation_pending ON holds (updated_at)
  WHERE state = 'reconciliation_pending';

-- An open record belongs to a pending hold; a resolution must match the
-- settlement recorded on its hold in the same transaction.
CREATE FUNCTION check_hold_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reconciliation records are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.resolution IS NOT NULL OR NEW.resolution IS NULL
      OR NEW.hold_id <> OLD.hold_id OR NEW.reason_code <> OLD.reason_code
      OR NEW.observed_usd6 IS DISTINCT FROM OLD.observed_usd6
      OR NEW.input_tokens IS DISTINCT FROM OLD.input_tokens
      OR NEW.output_tokens IS DISTINCT FROM OLD.output_tokens
      OR NEW.total_tokens IS DISTINCT FROM OLD.total_tokens
      OR NEW.stopped <> OLD.stopped OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'A reconciliation record may only be resolved once' USING ERRCODE='23514';
  END IF;
  IF NEW.resolution IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM holds WHERE id=NEW.hold_id AND state='reconciliation_pending') THEN
      RAISE EXCEPTION 'An open reconciliation record requires a pending hold' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM holds h WHERE h.id=NEW.hold_id
      AND h.state IN ('captured','released') AND h.captured_usd6=NEW.resolved_usd6
      AND h.xmin=pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'A reconciliation must match the settlement of its hold' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_hold_reconciliation BEFORE INSERT OR UPDATE OR DELETE ON hold_reconciliations
  FOR EACH ROW EXECUTE FUNCTION check_hold_reconciliation();

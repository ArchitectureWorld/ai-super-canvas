CREATE FUNCTION "validate_runtime_compensation_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.command_receipt_id IS DISTINCT FROM NEW.command_receipt_id
    OR OLD.agent_binding_id IS DISTINCT FROM NEW.agent_binding_id
    OR OLD.external_resource_kind IS DISTINCT FROM NEW.external_resource_kind
    OR OLD.lookup_metadata IS DISTINCT FROM NEW.lookup_metadata
    OR OLD.dedupe_key IS DISTINCT FROM NEW.dedupe_key
    OR OLD.action IS DISTINCT FROM NEW.action
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runtime_compensations_identity_immutable',
      MESSAGE = 'Runtime compensation identity and lookup data are immutable';
  END IF;

  IF (
    OLD.canvas_session_id IS NOT NULL
    AND OLD.canvas_session_id IS DISTINCT FROM NEW.canvas_session_id
  ) OR (
    OLD.canvas_run_id IS NOT NULL
    AND OLD.canvas_run_id IS DISTINCT FROM NEW.canvas_run_id
  ) OR (
    OLD.external_resource_ref IS NOT NULL
    AND OLD.external_resource_ref IS DISTINCT FROM NEW.external_resource_ref
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runtime_compensations_resolved_identity_immutable',
      MESSAGE = 'resolved Runtime and Canvas resource identities are immutable';
  END IF;

  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runtime_compensations_attempts_monotonic',
      MESSAGE = 'Runtime compensation attempts cannot decrease';
  END IF;

  IF OLD.status = 'succeeded'
    AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runtime_compensations_succeeded_immutable',
      MESSAGE = 'succeeded Runtime compensation is immutable';
  END IF;

  IF OLD.status <> NEW.status
    AND NOT (
      (OLD.status = 'pending' AND NEW.status IN ('running', 'succeeded', 'failed'))
      OR (OLD.status = 'running' AND NEW.status IN ('pending', 'succeeded', 'failed'))
      OR (OLD.status = 'failed' AND NEW.status IN ('pending', 'running'))
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runtime_compensations_status_transition',
      MESSAGE = 'invalid Runtime compensation status transition';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "runtime_compensations_validate_update"
BEFORE UPDATE ON "runtime_compensations"
FOR EACH ROW
EXECUTE FUNCTION "validate_runtime_compensation_update"();

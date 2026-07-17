ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_hierarchy_check";--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_hierarchy_check" CHECK ((
        "domain_events"."aggregate_type" = 'workspace'
        AND "domain_events"."aggregate_id" = "domain_events"."workspace_id"
        AND "domain_events"."workflow_id" IS NULL
        AND "domain_events"."session_id" IS NULL
        AND "domain_events"."run_id" IS NULL
      ) OR (
        "domain_events"."aggregate_type" = 'workflow'
        AND "domain_events"."aggregate_id" = "domain_events"."workflow_id"
        AND "domain_events"."workflow_id" IS NOT NULL
        AND "domain_events"."session_id" IS NULL
        AND "domain_events"."run_id" IS NULL
      ) OR (
        "domain_events"."aggregate_type" = 'session'
        AND "domain_events"."aggregate_id" = "domain_events"."session_id"
        AND "domain_events"."workflow_id" IS NOT NULL
        AND "domain_events"."session_id" IS NOT NULL
        AND "domain_events"."run_id" IS NULL
      ) OR (
        "domain_events"."aggregate_type" = 'run'
        AND "domain_events"."aggregate_id" = "domain_events"."run_id"
        AND "domain_events"."workflow_id" IS NOT NULL
        AND "domain_events"."session_id" IS NOT NULL
        AND "domain_events"."run_id" IS NOT NULL
      ));
--> statement-breakpoint
CREATE FUNCTION "assert_session_has_exactly_one_node"("checked_session_id" uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  node_count integer;
BEGIN
  PERFORM 1
  FROM public.sessions
  WHERE id = checked_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer
  INTO node_count
  FROM public.session_nodes
  WHERE session_id = checked_session_id;

  IF node_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'sessions_exactly_one_node',
      MESSAGE = 'Session must have exactly one SessionNode at commit';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "validate_session_node_count_from_session_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_session_has_exactly_one_node(NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sessions_exactly_one_node"
AFTER INSERT OR UPDATE ON "sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_session_node_count_from_session_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_session_node_count_from_node_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_session_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.assert_session_has_exactly_one_node(OLD.session_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' OR OLD.session_id IS NOT DISTINCT FROM NEW.session_id THEN
    PERFORM public.assert_session_has_exactly_one_node(NEW.session_id);
    RETURN NEW;
  END IF;

  FOR affected_session_id IN
    SELECT session_id
    FROM (
      SELECT OLD.session_id AS session_id
      UNION
      SELECT NEW.session_id AS session_id
    ) affected_sessions
    ORDER BY session_id
  LOOP
    PERFORM public.assert_session_has_exactly_one_node(affected_session_id);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "session_nodes_exactly_one_per_session"
AFTER INSERT OR UPDATE OR DELETE ON "session_nodes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_session_node_count_from_node_trigger"();

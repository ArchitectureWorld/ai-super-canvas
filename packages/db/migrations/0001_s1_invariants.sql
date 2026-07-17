ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_default_agent_fk"
  FOREIGN KEY ("default_agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "workflows"
  ADD CONSTRAINT "workflows_current_trunk_revision_fk"
  FOREIGN KEY ("id", "current_trunk_revision_id")
  REFERENCES "trunk_revisions"("workflow_id", "id")
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "branch_anchors"
  ADD CONSTRAINT "branch_anchors_source_message_fk"
  FOREIGN KEY ("workflow_id", "source_message_id")
  REFERENCES "messages"("workflow_id", "id")
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_run_session_fk"
  FOREIGN KEY ("session_id", "run_id")
  REFERENCES "runs"("session_id", "id")
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "tool_grants"
  ADD CONSTRAINT "tool_grants_source_approval_fk"
  FOREIGN KEY ("source_approval_id")
  REFERENCES "tool_approval_decisions"("id")
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION "assert_account_default_agent"("checked_account_id" uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_agent_id uuid;
BEGIN
  SELECT default_agent_id
  INTO selected_agent_id
  FROM public.accounts
  WHERE id = checked_account_id
  FOR UPDATE;

  IF NOT FOUND OR selected_agent_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.agents agent
    WHERE agent.id = selected_agent_id
      AND (
        agent.owner_account_id = checked_account_id
        OR EXISTS (
          SELECT 1
          FROM public.agent_access_grants grant_row
          WHERE grant_row.agent_id = selected_agent_id
            AND grant_row.account_id = checked_account_id
            AND grant_row.revoked_at IS NULL
        )
      )
  ) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'accounts_default_agent_authorized',
    MESSAGE = 'default Agent requires owner or active AgentAccessGrant';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "validate_account_default_agent_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_account_default_agent(NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "accounts_default_agent_authorized"
AFTER INSERT OR UPDATE ON "accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_account_default_agent_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_grant_default_agent_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_account_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.assert_account_default_agent(OLD.account_id);
    RETURN OLD;
  END IF;

  FOR affected_account_id IN
    SELECT account_id
    FROM (
      SELECT OLD.account_id AS account_id
      UNION
      SELECT NEW.account_id AS account_id
    ) affected_accounts
    ORDER BY account_id
  LOOP
    PERFORM public.assert_account_default_agent(affected_account_id);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_access_grants_default_agent_authorized"
AFTER UPDATE OR DELETE ON "agent_access_grants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_grant_default_agent_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_agent_owner_default_agent_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_row record;
BEGIN
  IF OLD.owner_account_id IS NOT DISTINCT FROM NEW.owner_account_id THEN
    RETURN NEW;
  END IF;

  FOR account_row IN
    SELECT id
    FROM public.accounts
    WHERE default_agent_id = NEW.id
    ORDER BY id
    FOR UPDATE
  LOOP
    PERFORM public.assert_account_default_agent(account_row.id);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agents_default_agent_authorized"
AFTER UPDATE ON "agents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_agent_owner_default_agent_trigger"();
--> statement-breakpoint
CREATE FUNCTION "assert_session_authorized"("checked_session_id" uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  session_row record;
BEGIN
  SELECT
    session_record.created_by_account_id,
    workspace_record.id AS workspace_id,
    binding_record.agent_id,
    agent_record.owner_account_id AS agent_owner_account_id
  INTO session_row
  FROM public.sessions session_record
  JOIN public.workflows workflow_record ON workflow_record.id = session_record.workflow_id
  JOIN public.workspaces workspace_record ON workspace_record.id = workflow_record.workspace_id
  JOIN public.agent_bindings binding_record ON binding_record.id = session_record.agent_binding_id
  JOIN public.agents agent_record ON agent_record.id = binding_record.agent_id
  WHERE session_record.id = checked_session_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_members member
    WHERE member.workspace_id = session_row.workspace_id
      AND member.account_id = session_row.created_by_account_id
      AND member.role IN ('owner', 'editor', 'runner')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'sessions_workspace_authorized',
      MESSAGE = 'Session creator lacks runnable Workspace membership';
  END IF;

  IF NOT (
    session_row.agent_owner_account_id = session_row.created_by_account_id
    OR EXISTS (
      SELECT 1
      FROM public.agent_access_grants grant_row
      WHERE grant_row.agent_id = session_row.agent_id
        AND grant_row.account_id = session_row.created_by_account_id
        AND grant_row.revoked_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'sessions_agent_authorized',
      MESSAGE = 'Session creator lacks Agent access';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "validate_session_authorization_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_session_authorized(NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sessions_creator_authorized"
AFTER INSERT OR UPDATE ON "sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_session_authorization_trigger"();
--> statement-breakpoint
CREATE FUNCTION "assert_workflow_derives_acyclic"("checked_workflow_id" uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM 1
  FROM public.workflows
  WHERE id = checked_workflow_id
  FOR UPDATE;

  IF EXISTS (
    WITH RECURSIVE reach(source_node_id, target_node_id) AS (
      SELECT source_session_node_id, target_session_node_id
      FROM public.session_edges
      WHERE workflow_id = checked_workflow_id
        AND kind = 'derives'
        AND source_session_node_id IS NOT NULL
      UNION
      SELECT reach.source_node_id, edge.target_session_node_id
      FROM reach
      JOIN public.session_edges edge
        ON edge.workflow_id = checked_workflow_id
       AND edge.kind = 'derives'
       AND edge.source_session_node_id = reach.target_node_id
    )
    SELECT 1
    FROM reach
    WHERE source_node_id = target_node_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'session_edges_derives_acyclic',
      MESSAGE = 'derives edges cannot form a cycle';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "assert_session_lineage"("checked_session_id" uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  session_row record;
  target_node_id uuid;
  birth_edge record;
  has_birth boolean := false;
  source_session_id uuid;
  anchor_row record;
  anchor_message_session_id uuid;
BEGIN
  SELECT id, workflow_id, parent_session_id, fork_anchor_id
  INTO session_row
  FROM public.sessions
  WHERE id = checked_session_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT id
  INTO target_node_id
  FROM public.session_nodes
  WHERE session_id = checked_session_id;

  IF target_node_id IS NOT NULL THEN
    SELECT source_session_node_id, anchor_id
    INTO birth_edge
    FROM public.session_edges
    WHERE target_session_node_id = target_node_id
      AND kind = 'derives';
    has_birth := FOUND;
  END IF;

  IF session_row.fork_anchor_id IS NULL THEN
    IF has_birth THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'session_edges_lineage_consistent',
        MESSAGE = 'mainline Session cannot have a derives birth edge';
    END IF;
    RETURN;
  END IF;

  IF target_node_id IS NULL OR NOT has_birth THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'session_edges_lineage_consistent',
      MESSAGE = 'forked Session requires one derives birth edge';
  END IF;

  IF birth_edge.anchor_id IS DISTINCT FROM session_row.fork_anchor_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'session_edges_lineage_consistent',
      MESSAGE = 'Session fork anchor and derives edge anchor differ';
  END IF;

  SELECT source_kind, source_message_id
  INTO anchor_row
  FROM public.branch_anchors
  WHERE id = birth_edge.anchor_id
    AND workflow_id = session_row.workflow_id;

  IF birth_edge.source_session_node_id IS NULL THEN
    IF session_row.parent_session_id IS NOT NULL
      OR anchor_row.source_kind IS DISTINCT FROM 'trunk_revision' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'session_edges_lineage_consistent',
        MESSAGE = 'root derives edge requires a TrunkRevision anchor and no parent Session';
    END IF;
    RETURN;
  END IF;

  SELECT session_id
  INTO source_session_id
  FROM public.session_nodes
  WHERE id = birth_edge.source_session_node_id
    AND workflow_id = session_row.workflow_id;

  SELECT session_id
  INTO anchor_message_session_id
  FROM public.messages
  WHERE id = anchor_row.source_message_id
    AND workflow_id = session_row.workflow_id;

  IF session_row.parent_session_id IS DISTINCT FROM source_session_id
    OR anchor_row.source_kind IS DISTINCT FROM 'message'
    OR anchor_message_session_id IS DISTINCT FROM source_session_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'session_edges_lineage_consistent',
      MESSAGE = 'message fork parent, source node, and anchor Message must agree';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "validate_session_edge_lineage_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_session_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.kind = 'derives' THEN
    PERFORM assert_workflow_derives_acyclic(OLD.workflow_id);

    SELECT session_id
    INTO target_session_id
    FROM public.session_nodes
    WHERE id = OLD.target_session_node_id
      AND workflow_id = OLD.workflow_id;

    PERFORM assert_session_lineage(target_session_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.kind = 'derives' THEN
    PERFORM assert_workflow_derives_acyclic(NEW.workflow_id);

    SELECT session_id
    INTO target_session_id
    FROM public.session_nodes
    WHERE id = NEW.target_session_node_id
      AND workflow_id = NEW.workflow_id;

    PERFORM assert_session_lineage(target_session_id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "session_edges_lineage_consistent"
AFTER INSERT OR UPDATE OR DELETE ON "session_edges"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_session_edge_lineage_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_session_lineage_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.workflow_id IS DISTINCT FROM NEW.workflow_id THEN
    PERFORM assert_workflow_derives_acyclic(OLD.workflow_id);
  END IF;

  PERFORM assert_workflow_derives_acyclic(NEW.workflow_id);
  PERFORM assert_session_lineage(NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sessions_lineage_consistent"
AFTER INSERT OR UPDATE ON "sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_session_lineage_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_branch_anchor_lineage_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_session_id uuid;
BEGIN
  PERFORM assert_workflow_derives_acyclic(OLD.workflow_id);
  IF TG_OP = 'UPDATE'
    AND OLD.workflow_id IS DISTINCT FROM NEW.workflow_id THEN
    PERFORM assert_workflow_derives_acyclic(NEW.workflow_id);
  END IF;

  FOR affected_session_id IN
    SELECT session_record.id
    FROM public.sessions session_record
    WHERE session_record.fork_anchor_id = OLD.id
      OR (
        TG_OP = 'UPDATE'
        AND session_record.fork_anchor_id = NEW.id
      )
  LOOP
    PERFORM assert_session_lineage(affected_session_id);
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "branch_anchors_lineage_consistent"
AFTER UPDATE OR DELETE ON "branch_anchors"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_branch_anchor_lineage_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_message_lineage_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_session_id uuid;
BEGIN
  PERFORM assert_workflow_derives_acyclic(OLD.workflow_id);
  IF TG_OP = 'UPDATE'
    AND OLD.workflow_id IS DISTINCT FROM NEW.workflow_id THEN
    PERFORM assert_workflow_derives_acyclic(NEW.workflow_id);
  END IF;

  FOR affected_session_id IN
    SELECT DISTINCT session_record.id
    FROM public.sessions session_record
    JOIN public.branch_anchors anchor_record
      ON anchor_record.id = session_record.fork_anchor_id
    WHERE anchor_record.source_message_id = OLD.id
      OR (
        TG_OP = 'UPDATE'
        AND anchor_record.source_message_id = NEW.id
      )
  LOOP
    PERFORM assert_session_lineage(affected_session_id);
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "messages_lineage_consistent"
AFTER UPDATE OR DELETE ON "messages"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_message_lineage_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_session_node_lineage_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected_session_id uuid;
BEGIN
  PERFORM assert_workflow_derives_acyclic(OLD.workflow_id);
  IF TG_OP = 'UPDATE'
    AND OLD.workflow_id IS DISTINCT FROM NEW.workflow_id THEN
    PERFORM assert_workflow_derives_acyclic(NEW.workflow_id);
  END IF;

  PERFORM assert_session_lineage(OLD.session_id);
  IF TG_OP = 'UPDATE'
    AND OLD.session_id IS DISTINCT FROM NEW.session_id THEN
    PERFORM assert_session_lineage(NEW.session_id);
  END IF;

  FOR affected_session_id IN
    SELECT DISTINCT target_node.session_id
    FROM public.session_edges edge_record
    JOIN public.session_nodes target_node
      ON target_node.id = edge_record.target_session_node_id
     AND target_node.workflow_id = edge_record.workflow_id
    WHERE edge_record.kind = 'derives'
      AND (
        edge_record.source_session_node_id = OLD.id
        OR (
          TG_OP = 'UPDATE'
          AND edge_record.source_session_node_id = NEW.id
        )
      )
  LOOP
    PERFORM assert_session_lineage(affected_session_id);
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "session_nodes_lineage_consistent"
AFTER UPDATE OR DELETE ON "session_nodes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_session_node_lineage_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_command_receipt_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.workflow_id IS DISTINCT FROM NEW.workflow_id
    OR OLD.account_id IS DISTINCT FROM NEW.account_id
    OR OLD.command_key IS DISTINCT FROM NEW.command_key
    OR OLD.command_type IS DISTINCT FROM NEW.command_type
    OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
    OR OLD.payload_canonical IS DISTINCT FROM NEW.payload_canonical
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'command_receipts_identity_immutable',
      MESSAGE = 'command identity and canonical payload are immutable';
  END IF;

  IF OLD.orchestration_phase = 'attached'
    AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'command_receipts_attached_immutable',
      MESSAGE = 'attached command receipt is immutable';
  END IF;

  IF (
    OLD.external_resource_kind IS NOT NULL
    AND OLD.external_resource_kind IS DISTINCT FROM NEW.external_resource_kind
  ) OR (
    OLD.external_resource_ref IS NOT NULL
    AND OLD.external_resource_ref IS DISTINCT FROM NEW.external_resource_ref
  ) OR (
    OLD.external_lookup_metadata <> '{}'::jsonb
    AND OLD.external_lookup_metadata IS DISTINCT FROM NEW.external_lookup_metadata
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'command_receipts_external_identity_immutable',
      MESSAGE = 'recorded Runtime identity and lookup metadata are immutable';
  END IF;

  IF (
    OLD.result_type IS NOT NULL
    AND OLD.result_type IS DISTINCT FROM NEW.result_type
  ) OR (
    OLD.result_id IS NOT NULL
    AND OLD.result_id IS DISTINCT FROM NEW.result_id
  ) OR (
    OLD.result_payload IS NOT NULL
    AND OLD.result_payload IS DISTINCT FROM NEW.result_payload
  ) OR (
    OLD.completed_at IS NOT NULL
    AND OLD.completed_at IS DISTINCT FROM NEW.completed_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'command_receipts_result_immutable',
      MESSAGE = 'recorded command result and completion timestamp are immutable';
  END IF;

  IF OLD.orchestration_phase = NEW.orchestration_phase THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (
      OLD.orchestration_phase = 'canvas_prepared'
      AND NEW.orchestration_phase IN (
        'runtime_dispatched', 'retryable_failure', 'terminal_failure'
      )
    ) OR (
      OLD.orchestration_phase = 'runtime_dispatched'
      AND NEW.orchestration_phase IN (
        'runtime_known', 'reconciling', 'retryable_failure', 'terminal_failure'
      )
    ) OR (
      OLD.orchestration_phase = 'runtime_known'
      AND NEW.orchestration_phase IN ('attached', 'reconciling', 'terminal_failure')
    ) OR (
      OLD.orchestration_phase = 'reconciling'
      AND NEW.orchestration_phase IN (
        'runtime_known', 'attached', 'retryable_failure', 'terminal_failure'
      )
    ) OR (
      OLD.orchestration_phase = 'retryable_failure'
      AND NEW.orchestration_phase IN ('runtime_dispatched', 'terminal_failure')
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'command_receipts_phase_transition',
      MESSAGE = 'invalid command orchestration phase transition';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "command_receipts_validate_update"
BEFORE UPDATE ON "command_receipts"
FOR EACH ROW
EXECUTE FUNCTION "validate_command_receipt_update"();
--> statement-breakpoint
CREATE FUNCTION "validate_bootstrap_receipt_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.auth_subject IS DISTINCT FROM NEW.auth_subject
    OR OLD.command_key IS DISTINCT FROM NEW.command_key
    OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
    OR OLD.payload_canonical IS DISTINCT FROM NEW.payload_canonical
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'bootstrap_receipts_identity_immutable',
      MESSAGE = 'bootstrap identity and canonical payload are immutable';
  END IF;

  IF OLD.status = 'completed'
    AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'bootstrap_receipts_completed_immutable',
      MESSAGE = 'completed bootstrap receipt is immutable';
  END IF;

  IF (
    OLD.account_id IS NOT NULL
    AND OLD.account_id IS DISTINCT FROM NEW.account_id
  ) OR (
    OLD.agent_id IS NOT NULL
    AND OLD.agent_id IS DISTINCT FROM NEW.agent_id
  ) OR (
    OLD.agent_binding_id IS NOT NULL
    AND OLD.agent_binding_id IS DISTINCT FROM NEW.agent_binding_id
  ) OR (
    OLD.workspace_id IS NOT NULL
    AND OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
  ) OR (
    OLD.workflow_id IS NOT NULL
    AND OLD.workflow_id IS DISTINCT FROM NEW.workflow_id
  ) OR (
    OLD.result_payload IS NOT NULL
    AND OLD.result_payload IS DISTINCT FROM NEW.result_payload
  ) OR (
    OLD.completed_at IS NOT NULL
    AND OLD.completed_at IS DISTINCT FROM NEW.completed_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'bootstrap_receipts_result_immutable',
      MESSAGE = 'recorded bootstrap resources and result are immutable';
  END IF;

  IF OLD.status <> NEW.status
    AND NOT (OLD.status = 'pending' AND NEW.status = 'completed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'bootstrap_receipts_status_transition',
      MESSAGE = 'invalid bootstrap receipt status transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "bootstrap_receipts_validate_update"
BEFORE UPDATE ON "bootstrap_receipts"
FOR EACH ROW
EXECUTE FUNCTION "validate_bootstrap_receipt_update"();
--> statement-breakpoint
CREATE FUNCTION "assert_runtime_compensation_hierarchy"(
  "checked_compensation_id" uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  compensation_row record;
BEGIN
  SELECT
    compensation_record.canvas_session_id,
    compensation_record.canvas_run_id,
    compensation_record.agent_binding_id,
    receipt_record.workflow_id AS receipt_workflow_id,
    session_record.workflow_id AS session_workflow_id,
    session_record.agent_binding_id AS session_binding_id,
    run_record.session_id AS run_session_id,
    run_record.agent_binding_id AS run_binding_id
  INTO compensation_row
  FROM public.runtime_compensations compensation_record
  JOIN public.command_receipts receipt_record
    ON receipt_record.id = compensation_record.command_receipt_id
  LEFT JOIN public.sessions session_record
    ON session_record.id = compensation_record.canvas_session_id
  LEFT JOIN public.runs run_record
    ON run_record.id = compensation_record.canvas_run_id
  WHERE compensation_record.id = checked_compensation_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF compensation_row.canvas_run_id IS NOT NULL
    AND compensation_row.canvas_session_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runtime_compensations_run_requires_session',
      MESSAGE = 'Canvas Run compensation requires its Canvas Session';
  END IF;

  IF compensation_row.canvas_session_id IS NOT NULL
    AND (
      compensation_row.session_workflow_id
        IS DISTINCT FROM compensation_row.receipt_workflow_id
      OR compensation_row.session_binding_id
        IS DISTINCT FROM compensation_row.agent_binding_id
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runtime_compensations_session_hierarchy',
      MESSAGE = 'compensation Session must match receipt Workflow and AgentBinding';
  END IF;

  IF compensation_row.canvas_run_id IS NOT NULL
    AND (
      compensation_row.run_session_id
        IS DISTINCT FROM compensation_row.canvas_session_id
      OR compensation_row.run_binding_id
        IS DISTINCT FROM compensation_row.agent_binding_id
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runtime_compensations_run_hierarchy',
      MESSAGE = 'compensation Run must match its Session and AgentBinding';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "validate_runtime_compensation_hierarchy_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM assert_runtime_compensation_hierarchy(NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "runtime_compensations_hierarchy_consistent"
AFTER INSERT OR UPDATE ON "runtime_compensations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_runtime_compensation_hierarchy_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_session_compensation_hierarchy_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  compensation_id uuid;
BEGIN
  FOR compensation_id IN
    SELECT id
    FROM public.runtime_compensations
    WHERE canvas_session_id = OLD.id
      OR canvas_session_id = NEW.id
  LOOP
    PERFORM assert_runtime_compensation_hierarchy(compensation_id);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sessions_compensation_hierarchy_consistent"
AFTER UPDATE ON "sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_session_compensation_hierarchy_trigger"();
--> statement-breakpoint
CREATE FUNCTION "validate_run_compensation_hierarchy_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  compensation_id uuid;
BEGIN
  FOR compensation_id IN
    SELECT id
    FROM public.runtime_compensations
    WHERE canvas_run_id = OLD.id
      OR canvas_run_id = NEW.id
  LOOP
    PERFORM assert_runtime_compensation_hierarchy(compensation_id);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "runs_compensation_hierarchy_consistent"
AFTER UPDATE ON "runs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_run_compensation_hierarchy_trigger"();
--> statement-breakpoint
CREATE FUNCTION "protect_domain_events"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'DomainEvent ledger is append-only';
  END IF;

  IF current_setting('ai_super_canvas.domain_event_publish', true) = '1'
    AND current_user = (
      SELECT pg_catalog.pg_get_userbyid(function_record.proowner)
      FROM pg_catalog.pg_proc function_record
      WHERE function_record.oid =
        'public.mark_domain_event_published(uuid,timestamptz)'::pg_catalog.regprocedure
    )
    AND (
      to_jsonb(NEW) - 'published_at' - 'publish_attempts'
    ) IS NOT DISTINCT FROM (
      to_jsonb(OLD) - 'published_at' - 'publish_attempts'
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'DomainEvent ledger is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "domain_events_append_only"
BEFORE UPDATE OR DELETE ON "domain_events"
FOR EACH ROW
EXECUTE FUNCTION "protect_domain_events"();
--> statement-breakpoint
CREATE FUNCTION "mark_domain_event_published"(
  "event_id" uuid,
  "published_timestamp" timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM set_config('ai_super_canvas.domain_event_publish', '1', true);
  UPDATE public.domain_events
  SET published_at = published_timestamp,
      publish_attempts = publish_attempts + 1
  WHERE id = event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'DomainEvent does not exist';
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "mark_domain_event_published"(uuid, timestamptz) FROM PUBLIC;

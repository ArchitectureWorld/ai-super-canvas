CREATE TYPE "public"."binding_status" AS ENUM('provisioning', 'ready', 'degraded', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "public"."context_scope" AS ENUM('account', 'agent', 'workflow', 'session', 'run');--> statement-breakpoint
CREATE TYPE "public"."context_visibility" AS ENUM('private', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."growth_state" AS ENUM('active', 'dormant', 'metabolized');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'waiting_approval', 'reconciling', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."runtime_kind" AS ENUM('fake', 'hermes-acp', 'letta', 'langgraph', 'canvas-native');--> statement-breakpoint
CREATE TYPE "public"."session_edge_kind" AS ENUM('derives', 'references', 'supports', 'contradicts', 'depends_on');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('provisioning', 'active', 'dormant', 'closed', 'archived', 'error');--> statement-breakpoint
CREATE TYPE "public"."tool_grant_effect" AS ENUM('allow', 'deny', 'require_approval');--> statement-breakpoint
CREATE TYPE "public"."tool_grant_scope" AS ENUM('account', 'agent', 'workflow', 'session', 'run');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('active', 'dormant', 'archived');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"auth_subject" text NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"default_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_auth_subject_unique" UNIQUE("auth_subject")
);
--> statement-breakpoint
CREATE TABLE "agent_access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_access_grants_role_check" CHECK ("agent_access_grants"."role" IN ('use', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "agent_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"runtime_kind" "runtime_kind" NOT NULL,
	"external_agent_ref" text,
	"isolation_key" text NOT NULL,
	"endpoint_ref" text,
	"secret_ref" text,
	"runtime_version" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "binding_status" DEFAULT 'provisioning' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"default_model_key" text,
	"memory_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_owner_id_unique" UNIQUE("owner_account_id","id"),
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" IN ('active', 'disabled', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_pk" PRIMARY KEY("workspace_id","account_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" IN ('owner', 'editor', 'runner', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branch_anchors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"context_trunk_revision_id" uuid NOT NULL,
	"source_trunk_revision_id" uuid,
	"source_message_id" uuid,
	"source_artifact_id" uuid,
	"selector" jsonb NOT NULL,
	"quote" text,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_anchors_workflow_id_unique" UNIQUE("workflow_id","id"),
	CONSTRAINT "branch_anchors_s1_source_check" CHECK ("branch_anchors"."source_artifact_id" IS NULL AND (
        (
          "branch_anchors"."source_kind" = 'trunk_revision'
          AND "branch_anchors"."source_trunk_revision_id" IS NOT NULL
          AND "branch_anchors"."source_message_id" IS NULL
        ) OR (
          "branch_anchors"."source_kind" = 'message'
          AND "branch_anchors"."source_trunk_revision_id" IS NULL
          AND "branch_anchors"."source_message_id" IS NOT NULL
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "session_edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"source_session_node_id" uuid,
	"target_session_node_id" uuid NOT NULL,
	"kind" "session_edge_kind" NOT NULL,
	"anchor_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_edges_not_self" CHECK ("session_edges"."source_session_node_id" IS NULL OR "session_edges"."source_session_node_id" <> "session_edges"."target_session_node_id"),
	CONSTRAINT "session_edges_anchor_by_kind" CHECK ((
        "session_edges"."kind" = 'derives' AND "session_edges"."anchor_id" IS NOT NULL
      ) OR (
        "session_edges"."kind" <> 'derives' AND "session_edges"."anchor_id" IS NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "session_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"title" text NOT NULL,
	"node_kind" text NOT NULL,
	"growth_state" "growth_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_nodes_workflow_id_unique" UNIQUE("workflow_id","id"),
	CONSTRAINT "session_nodes_workflow_session_unique" UNIQUE("workflow_id","session_id"),
	CONSTRAINT "session_nodes_kind_check" CHECK ("session_nodes"."node_kind" IN ('mainline', 'branch', 'review'))
);
--> statement-breakpoint
CREATE TABLE "session_runtime_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_binding_id" uuid NOT NULL,
	"external_session_ref" text NOT NULL,
	"runtime_version" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sync_cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_session_ref_unique" UNIQUE("agent_binding_id","external_session_ref"),
	CONSTRAINT "session_runtime_refs_status_check" CHECK ("session_runtime_refs"."status" IN ('active', 'historical', 'error'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"agent_binding_id" uuid NOT NULL,
	"parent_session_id" uuid,
	"fork_anchor_id" uuid,
	"status" "session_status" DEFAULT 'provisioning' NOT NULL,
	"transcript_version" integer DEFAULT 0 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "sessions_workflow_id_unique" UNIQUE("workflow_id","id"),
	CONSTRAINT "sessions_id_binding_unique" UNIQUE("id","agent_binding_id"),
	CONSTRAINT "sessions_parent_requires_anchor" CHECK ("sessions"."parent_session_id" IS NULL OR "sessions"."fork_anchor_id" IS NOT NULL),
	CONSTRAINT "sessions_transcript_version_nonnegative" CHECK ("sessions"."transcript_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trunk_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"parent_revision_id" uuid,
	"revision_number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_from_proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trunk_revisions_workflow_number_unique" UNIQUE("workflow_id","revision_number"),
	CONSTRAINT "trunk_revisions_workflow_id_unique" UNIQUE("workflow_id","id"),
	CONSTRAINT "trunk_revisions_number_positive" CHECK ("trunk_revisions"."revision_number" > 0),
	CONSTRAINT "trunk_revisions_s1_proposal_null" CHECK ("trunk_revisions"."created_from_proposal_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "workflow_status" DEFAULT 'active' NOT NULL,
	"current_trunk_revision_id" uuid,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"ordinal" bigint NOT NULL,
	"role" "message_role" NOT NULL,
	"actor_account_id" uuid,
	"actor_agent_id" uuid,
	"content" jsonb NOT NULL,
	"status" text NOT NULL,
	"external_message_ref" text,
	"source_runtime_event_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_session_ordinal_unique" UNIQUE("session_id","ordinal"),
	CONSTRAINT "messages_session_id_unique" UNIQUE("session_id","id"),
	CONSTRAINT "messages_workflow_id_unique" UNIQUE("workflow_id","id"),
	CONSTRAINT "messages_ordinal_nonnegative" CHECK ("messages"."ordinal" >= 0),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" IN ('partial', 'completed', 'failed')),
	CONSTRAINT "messages_actor_by_role_check" CHECK ((
        "messages"."role" = 'user'
        AND "messages"."actor_account_id" IS NOT NULL
        AND "messages"."actor_agent_id" IS NULL
      ) OR (
        "messages"."role" = 'assistant'
        AND "messages"."actor_account_id" IS NULL
        AND "messages"."actor_agent_id" IS NOT NULL
      ) OR "messages"."role" IN ('system', 'tool')),
	CONSTRAINT "messages_runtime_event_requires_run" CHECK ("messages"."source_runtime_event_key" IS NULL OR "messages"."run_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "model_catalog_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"runtime_kind" "runtime_kind" NOT NULL,
	"provider_key" text NOT NULL,
	"model_key" text NOT NULL,
	"display_name" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"availability" text NOT NULL,
	"discovery_source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_catalog_entries_runtime_provider_model_unique" UNIQUE("runtime_kind","provider_key","model_key"),
	CONSTRAINT "model_catalog_entries_availability_check" CHECK ("model_catalog_entries"."availability" IN ('available', 'degraded', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"external_event_ref" text,
	"runtime_event_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_sequence_unique" UNIQUE("run_id","sequence"),
	CONSTRAINT "run_events_runtime_key_unique" UNIQUE("run_id","runtime_event_key"),
	CONSTRAINT "run_events_sequence_nonnegative" CHECK ("run_events"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_binding_id" uuid NOT NULL,
	"config_revision_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"runtime_run_ref" text,
	"model_snapshot" jsonb NOT NULL,
	"tool_policy_snapshot" jsonb NOT NULL,
	"context_policy_snapshot" jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_session_idempotency_unique" UNIQUE("session_id","idempotency_key"),
	CONSTRAINT "runs_session_id_unique" UNIQUE("session_id","id")
);
--> statement-breakpoint
CREATE TABLE "session_config_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"model_entry_id" uuid,
	"instructions_overlay" text,
	"tool_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_config_revisions_session_version_unique" UNIQUE("session_id","version"),
	CONSTRAINT "session_config_revisions_session_id_unique" UNIQUE("session_id","id"),
	CONSTRAINT "session_config_revisions_version_positive" CHECK ("session_config_revisions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "context_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid,
	"workflow_id" uuid,
	"session_id" uuid,
	"run_id" uuid,
	"scope" "context_scope" NOT NULL,
	"visibility" "context_visibility" NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"snapshot" jsonb,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "context_refs_scope_columns_check" CHECK ((
        "context_refs"."scope" = 'account'
        AND "context_refs"."agent_id" IS NULL
        AND "context_refs"."workflow_id" IS NULL
        AND "context_refs"."session_id" IS NULL
        AND "context_refs"."run_id" IS NULL
      ) OR (
        "context_refs"."scope" = 'agent'
        AND "context_refs"."agent_id" IS NOT NULL
        AND "context_refs"."workflow_id" IS NULL
        AND "context_refs"."session_id" IS NULL
        AND "context_refs"."run_id" IS NULL
      ) OR (
        "context_refs"."scope" = 'workflow'
        AND "context_refs"."agent_id" IS NULL
        AND "context_refs"."workflow_id" IS NOT NULL
        AND "context_refs"."session_id" IS NULL
        AND "context_refs"."run_id" IS NULL
      ) OR (
        "context_refs"."scope" = 'session'
        AND "context_refs"."agent_id" IS NULL
        AND "context_refs"."workflow_id" IS NOT NULL
        AND "context_refs"."session_id" IS NOT NULL
        AND "context_refs"."run_id" IS NULL
      ) OR (
        "context_refs"."scope" = 'run'
        AND "context_refs"."agent_id" IS NULL
        AND "context_refs"."workflow_id" IS NOT NULL
        AND "context_refs"."session_id" IS NOT NULL
        AND "context_refs"."run_id" IS NOT NULL
      )),
	CONSTRAINT "context_refs_workspace_visibility_scope_check" CHECK ("context_refs"."visibility" = 'private' OR "context_refs"."scope" IN ('workflow', 'session', 'run'))
);
--> statement-breakpoint
CREATE TABLE "tool_approval_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_ref" text NOT NULL,
	"approval_ref" text NOT NULL,
	"reviewer_account_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"created_grant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_approval_decisions_run_ref_unique" UNIQUE("run_id","approval_ref"),
	CONSTRAINT "tool_approval_decisions_decision_check" CHECK ("tool_approval_decisions"."decision" IN ('allow_once', 'allow_session', 'deny'))
);
--> statement-breakpoint
CREATE TABLE "tool_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"scope" "tool_grant_scope" NOT NULL,
	"agent_id" uuid,
	"workflow_id" uuid,
	"session_id" uuid,
	"run_id" uuid,
	"tool_key" text NOT NULL,
	"effect" "tool_grant_effect" NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"issued_by_account_id" uuid NOT NULL,
	"source_approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_grants_scope_columns_check" CHECK ((
        "tool_grants"."scope" = 'account'
        AND "tool_grants"."agent_id" IS NULL
        AND "tool_grants"."workflow_id" IS NULL
        AND "tool_grants"."session_id" IS NULL
        AND "tool_grants"."run_id" IS NULL
      ) OR (
        "tool_grants"."scope" = 'agent'
        AND "tool_grants"."agent_id" IS NOT NULL
        AND "tool_grants"."workflow_id" IS NULL
        AND "tool_grants"."session_id" IS NULL
        AND "tool_grants"."run_id" IS NULL
      ) OR (
        "tool_grants"."scope" = 'workflow'
        AND "tool_grants"."agent_id" IS NULL
        AND "tool_grants"."workflow_id" IS NOT NULL
        AND "tool_grants"."session_id" IS NULL
        AND "tool_grants"."run_id" IS NULL
      ) OR (
        "tool_grants"."scope" = 'session'
        AND "tool_grants"."agent_id" IS NULL
        AND "tool_grants"."workflow_id" IS NOT NULL
        AND "tool_grants"."session_id" IS NOT NULL
        AND "tool_grants"."run_id" IS NULL
      ) OR (
        "tool_grants"."scope" = 'run'
        AND "tool_grants"."agent_id" IS NULL
        AND "tool_grants"."workflow_id" IS NOT NULL
        AND "tool_grants"."session_id" IS NOT NULL
        AND "tool_grants"."run_id" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "bootstrap_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"auth_subject" text NOT NULL,
	"command_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_canonical" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"account_id" uuid,
	"agent_id" uuid,
	"agent_binding_id" uuid,
	"workspace_id" uuid,
	"workflow_id" uuid,
	"result_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bootstrap_receipts_subject_key_unique" UNIQUE("auth_subject","command_key"),
	CONSTRAINT "bootstrap_receipts_status_check" CHECK ("bootstrap_receipts"."status" IN ('pending', 'completed')),
	CONSTRAINT "bootstrap_receipts_completion_check" CHECK ("bootstrap_receipts"."status" = 'pending' OR (
        "bootstrap_receipts"."account_id" IS NOT NULL
        AND "bootstrap_receipts"."agent_id" IS NOT NULL
        AND "bootstrap_receipts"."agent_binding_id" IS NOT NULL
        AND "bootstrap_receipts"."workspace_id" IS NOT NULL
        AND "bootstrap_receipts"."workflow_id" IS NOT NULL
        AND "bootstrap_receipts"."result_payload" IS NOT NULL
        AND "bootstrap_receipts"."completed_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "command_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"command_key" text NOT NULL,
	"command_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_canonical" text NOT NULL,
	"orchestration_phase" text DEFAULT 'canvas_prepared' NOT NULL,
	"external_resource_kind" text,
	"external_resource_ref" text,
	"external_lookup_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_type" text,
	"result_id" uuid,
	"result_payload" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "command_receipts_workflow_key_unique" UNIQUE("workflow_id","command_key"),
	CONSTRAINT "command_receipts_phase_check" CHECK ("command_receipts"."orchestration_phase" IN (
        'canvas_prepared',
        'runtime_dispatched',
        'runtime_known',
        'attached',
        'reconciling',
        'retryable_failure',
        'terminal_failure'
      )),
	CONSTRAINT "command_receipts_external_identity_check" CHECK ("command_receipts"."external_resource_ref" IS NULL OR "command_receipts"."external_resource_kind" IS NOT NULL),
	CONSTRAINT "command_receipts_result_pair_check" CHECK (("command_receipts"."result_type" IS NULL) = ("command_receipts"."result_id" IS NULL)),
	CONSTRAINT "command_receipts_phase_payload_check" CHECK ((
        "command_receipts"."orchestration_phase" NOT IN ('runtime_known', 'attached')
        OR (
          "command_receipts"."external_resource_kind" IS NOT NULL
          AND (
            "command_receipts"."external_resource_ref" IS NOT NULL
            OR "command_receipts"."external_lookup_metadata" <> '{}'::jsonb
          )
        )
      ) AND (
        "command_receipts"."orchestration_phase" <> 'attached'
        OR (
          "command_receipts"."result_id" IS NOT NULL
          AND "command_receipts"."result_payload" IS NOT NULL
          AND "command_receipts"."completed_at" IS NOT NULL
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid,
	"session_id" uuid,
	"run_id" uuid,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "domain_events_aggregate_sequence_unique" UNIQUE("aggregate_type","aggregate_id","aggregate_sequence"),
	CONSTRAINT "domain_events_aggregate_sequence_positive" CHECK ("domain_events"."aggregate_sequence" > 0),
	CONSTRAINT "domain_events_event_version_positive" CHECK ("domain_events"."event_version" > 0),
	CONSTRAINT "domain_events_publish_attempts_nonnegative" CHECK ("domain_events"."publish_attempts" >= 0),
	CONSTRAINT "domain_events_hierarchy_check" CHECK ((
        "domain_events"."session_id" IS NULL OR "domain_events"."workflow_id" IS NOT NULL
      ) AND (
        "domain_events"."run_id" IS NULL OR "domain_events"."session_id" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "runtime_compensations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"command_receipt_id" uuid NOT NULL,
	"agent_binding_id" uuid NOT NULL,
	"canvas_session_id" uuid,
	"canvas_run_id" uuid,
	"external_resource_kind" text NOT NULL,
	"external_resource_ref" text,
	"lookup_metadata" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_compensations_dedupe_unique" UNIQUE("command_receipt_id","external_resource_kind","dedupe_key","action"),
	CONSTRAINT "runtime_compensations_action_check" CHECK ("runtime_compensations"."action" IN ('adopt', 'destroy', 'reconcile')),
	CONSTRAINT "runtime_compensations_status_check" CHECK ("runtime_compensations"."status" IN ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "runtime_compensations_attempts_nonnegative" CHECK ("runtime_compensations"."attempts" >= 0),
	CONSTRAINT "runtime_compensations_lookup_check" CHECK ("runtime_compensations"."external_resource_ref" IS NOT NULL OR (
        jsonb_typeof("runtime_compensations"."lookup_metadata") = 'object'
        AND "runtime_compensations"."lookup_metadata" <> '{}'::jsonb
        AND "runtime_compensations"."lookup_metadata" ? 'commandId'
        AND (
          "runtime_compensations"."lookup_metadata" ? 'canvasSessionId'
          OR "runtime_compensations"."lookup_metadata" ? 'canvasRunId'
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "agent_access_grants" ADD CONSTRAINT "agent_access_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_grants" ADD CONSTRAINT "agent_access_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_grants" ADD CONSTRAINT "agent_access_grants_granted_by_account_id_accounts_id_fk" FOREIGN KEY ("granted_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bindings" ADD CONSTRAINT "agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_anchors" ADD CONSTRAINT "branch_anchors_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_anchors" ADD CONSTRAINT "branch_anchors_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_anchors" ADD CONSTRAINT "branch_anchors_context_trunk_fk" FOREIGN KEY ("workflow_id","context_trunk_revision_id") REFERENCES "public"."trunk_revisions"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_anchors" ADD CONSTRAINT "branch_anchors_source_trunk_fk" FOREIGN KEY ("workflow_id","source_trunk_revision_id") REFERENCES "public"."trunk_revisions"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_edges" ADD CONSTRAINT "session_edges_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_edges" ADD CONSTRAINT "session_edges_source_workflow_fk" FOREIGN KEY ("workflow_id","source_session_node_id") REFERENCES "public"."session_nodes"("workflow_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_edges" ADD CONSTRAINT "session_edges_target_workflow_fk" FOREIGN KEY ("workflow_id","target_session_node_id") REFERENCES "public"."session_nodes"("workflow_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_edges" ADD CONSTRAINT "session_edges_anchor_workflow_fk" FOREIGN KEY ("workflow_id","anchor_id") REFERENCES "public"."branch_anchors"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_session_workflow_fk" FOREIGN KEY ("workflow_id","session_id") REFERENCES "public"."sessions"("workflow_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_runtime_refs" ADD CONSTRAINT "session_runtime_refs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_runtime_refs" ADD CONSTRAINT "session_runtime_refs_agent_binding_id_agent_bindings_id_fk" FOREIGN KEY ("agent_binding_id") REFERENCES "public"."agent_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_runtime_refs" ADD CONSTRAINT "session_runtime_refs_binding_fk" FOREIGN KEY ("session_id","agent_binding_id") REFERENCES "public"."sessions"("id","agent_binding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_binding_id_agent_bindings_id_fk" FOREIGN KEY ("agent_binding_id") REFERENCES "public"."agent_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_workflow_fk" FOREIGN KEY ("workflow_id","parent_session_id") REFERENCES "public"."sessions"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_anchor_workflow_fk" FOREIGN KEY ("workflow_id","fork_anchor_id") REFERENCES "public"."branch_anchors"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trunk_revisions" ADD CONSTRAINT "trunk_revisions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trunk_revisions" ADD CONSTRAINT "trunk_revisions_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trunk_revisions" ADD CONSTRAINT "trunk_revisions_parent_workflow_fk" FOREIGN KEY ("workflow_id","parent_revision_id") REFERENCES "public"."trunk_revisions"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_workflow_fk" FOREIGN KEY ("workflow_id","session_id") REFERENCES "public"."sessions"("workflow_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_binding_id_agent_bindings_id_fk" FOREIGN KEY ("agent_binding_id") REFERENCES "public"."agent_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_config_revision_id_session_config_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."session_config_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_binding_fk" FOREIGN KEY ("session_id","agent_binding_id") REFERENCES "public"."sessions"("id","agent_binding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_config_fk" FOREIGN KEY ("session_id","config_revision_id") REFERENCES "public"."session_config_revisions"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_trigger_message_fk" FOREIGN KEY ("session_id","trigger_message_id") REFERENCES "public"."messages"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_config_revisions" ADD CONSTRAINT "session_config_revisions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_config_revisions" ADD CONSTRAINT "session_config_model_entry_fk" FOREIGN KEY ("model_entry_id") REFERENCES "public"."model_catalog_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_config_revisions" ADD CONSTRAINT "session_config_revisions_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_refs" ADD CONSTRAINT "context_refs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_refs" ADD CONSTRAINT "context_refs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_refs" ADD CONSTRAINT "context_refs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_refs" ADD CONSTRAINT "context_refs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_refs" ADD CONSTRAINT "context_refs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_refs" ADD CONSTRAINT "context_refs_session_workflow_fk" FOREIGN KEY ("workflow_id","session_id") REFERENCES "public"."sessions"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_refs" ADD CONSTRAINT "context_refs_run_session_fk" FOREIGN KEY ("session_id","run_id") REFERENCES "public"."runs"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval_decisions" ADD CONSTRAINT "tool_approval_decisions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval_decisions" ADD CONSTRAINT "tool_approval_decisions_reviewer_account_id_accounts_id_fk" FOREIGN KEY ("reviewer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval_decisions" ADD CONSTRAINT "tool_approval_decisions_created_grant_id_tool_grants_id_fk" FOREIGN KEY ("created_grant_id") REFERENCES "public"."tool_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_issued_by_account_id_accounts_id_fk" FOREIGN KEY ("issued_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_session_workflow_fk" FOREIGN KEY ("workflow_id","session_id") REFERENCES "public"."sessions"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_run_session_fk" FOREIGN KEY ("session_id","run_id") REFERENCES "public"."runs"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_receipts" ADD CONSTRAINT "bootstrap_receipts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_receipts" ADD CONSTRAINT "bootstrap_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_receipts" ADD CONSTRAINT "bootstrap_receipts_agent_binding_id_agent_bindings_id_fk" FOREIGN KEY ("agent_binding_id") REFERENCES "public"."agent_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_receipts" ADD CONSTRAINT "bootstrap_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_receipts" ADD CONSTRAINT "bootstrap_receipts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_workflow_workspace_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_session_workflow_fk" FOREIGN KEY ("workflow_id","session_id") REFERENCES "public"."sessions"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_run_session_fk" FOREIGN KEY ("session_id","run_id") REFERENCES "public"."runs"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD CONSTRAINT "runtime_compensations_command_receipt_id_command_receipts_id_fk" FOREIGN KEY ("command_receipt_id") REFERENCES "public"."command_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD CONSTRAINT "runtime_compensations_agent_binding_id_agent_bindings_id_fk" FOREIGN KEY ("agent_binding_id") REFERENCES "public"."agent_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD CONSTRAINT "runtime_compensations_canvas_session_id_sessions_id_fk" FOREIGN KEY ("canvas_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD CONSTRAINT "runtime_compensations_canvas_run_id_runs_id_fk" FOREIGN KEY ("canvas_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD CONSTRAINT "runtime_compensations_run_session_fk" FOREIGN KEY ("canvas_session_id","canvas_run_id") REFERENCES "public"."runs"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_lower_unique" ON "accounts" USING btree (lower("email")) WHERE "accounts"."email" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_access_active_unique" ON "agent_access_grants" USING btree ("agent_id","account_id") WHERE "agent_access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_bindings_agent_status_idx" ON "agent_bindings" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_bindings_primary_unique" ON "agent_bindings" USING btree ("agent_id") WHERE "agent_bindings"."is_primary" = true AND "agent_bindings"."status" IN ('ready', 'degraded');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_bindings_external_unique" ON "agent_bindings" USING btree ("runtime_kind","external_agent_ref") WHERE "agent_bindings"."external_agent_ref" IS NOT NULL AND "agent_bindings"."status" <> 'disabled';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_bindings_isolation_unique" ON "agent_bindings" USING btree ("runtime_kind","isolation_key") WHERE "agent_bindings"."status" <> 'disabled';--> statement-breakpoint
CREATE INDEX "agents_owner_status_idx" ON "agents" USING btree ("owner_account_id","status");--> statement-breakpoint
CREATE INDEX "workspaces_owner_updated_idx" ON "workspaces" USING btree ("owner_account_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "branch_anchors_workflow_source_idx" ON "branch_anchors" USING btree ("workflow_id","source_kind");--> statement-breakpoint
CREATE INDEX "branch_anchors_source_trunk_idx" ON "branch_anchors" USING btree ("source_trunk_revision_id") WHERE "branch_anchors"."source_trunk_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "branch_anchors_source_message_idx" ON "branch_anchors" USING btree ("source_message_id") WHERE "branch_anchors"."source_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "branch_anchors_source_artifact_idx" ON "branch_anchors" USING btree ("source_artifact_id") WHERE "branch_anchors"."source_artifact_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_edges_source_target_kind_unique" ON "session_edges" USING btree ("source_session_node_id","target_session_node_id","kind") WHERE "session_edges"."source_session_node_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_edges_one_birth_unique" ON "session_edges" USING btree ("target_session_node_id") WHERE "session_edges"."kind" = 'derives';--> statement-breakpoint
CREATE INDEX "session_edges_workflow_source_idx" ON "session_edges" USING btree ("workflow_id","source_session_node_id");--> statement-breakpoint
CREATE INDEX "session_edges_workflow_target_idx" ON "session_edges" USING btree ("workflow_id","target_session_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_nodes_session_unique" ON "session_nodes" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_session_active_primary_unique" ON "session_runtime_refs" USING btree ("session_id") WHERE "session_runtime_refs"."is_primary" = true AND "session_runtime_refs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "runtime_session_session_idx" ON "session_runtime_refs" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "sessions_workflow_updated_idx" ON "sessions" USING btree ("workflow_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_binding_status_idx" ON "sessions" USING btree ("agent_binding_id","status");--> statement-breakpoint
CREATE INDEX "trunk_revisions_workflow_created_idx" ON "trunk_revisions" USING btree ("workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflows_workspace_updated_idx" ON "workflows" USING btree ("workspace_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_runtime_projection_unique" ON "messages" USING btree ("run_id","source_runtime_event_key") WHERE "messages"."source_runtime_event_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_session_created_idx" ON "messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_external_ref_unique" ON "run_events" USING btree ("run_id","external_event_ref") WHERE "run_events"."external_event_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "run_events_run_sequence_idx" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_session" ON "runs" USING btree ("session_id") WHERE "runs"."status" IN ('queued', 'running', 'waiting_approval', 'reconciling');--> statement-breakpoint
CREATE INDEX "runs_session_created_idx" ON "runs" USING btree ("session_id","created_at" DESC NULLS LAST);

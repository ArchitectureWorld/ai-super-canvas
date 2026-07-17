import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { runs } from './execution';
import { accounts, agentBindings, agents, workspaces } from './identity';
import { sessions, workflows } from './workflows';

export const commandReceipts = pgTable(
  'command_receipts',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    commandKey: text('command_key').notNull(),
    commandType: text('command_type').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payloadCanonical: text('payload_canonical').notNull(),
    orchestrationPhase: text('orchestration_phase')
      .notNull()
      .default('canvas_prepared'),
    externalResourceKind: text('external_resource_kind'),
    externalResourceRef: text('external_resource_ref'),
    externalLookupMetadata: jsonb('external_lookup_metadata').notNull().default({}),
    resultType: text('result_type'),
    resultId: uuid('result_id'),
    resultPayload: jsonb('result_payload'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'command_receipts_phase_check',
      sql`${table.orchestrationPhase} IN (
        'canvas_prepared',
        'runtime_dispatched',
        'runtime_known',
        'attached',
        'reconciling',
        'retryable_failure',
        'terminal_failure'
      )`,
    ),
    check(
      'command_receipts_external_identity_check',
      sql`${table.externalResourceRef} IS NULL OR ${table.externalResourceKind} IS NOT NULL`,
    ),
    check(
      'command_receipts_lookup_metadata_check',
      sql`jsonb_typeof(${table.externalLookupMetadata}) = 'object' AND (
        ${table.externalLookupMetadata} = '{}'::jsonb
        OR (
          ${table.externalLookupMetadata} ? 'commandId'
          AND jsonb_typeof(${table.externalLookupMetadata} -> 'commandId') = 'string'
          AND length(${table.externalLookupMetadata} ->> 'commandId') > 0
          AND (
            (
              ${table.externalLookupMetadata} ? 'canvasSessionId'
              AND jsonb_typeof(${table.externalLookupMetadata} -> 'canvasSessionId') = 'string'
              AND length(${table.externalLookupMetadata} ->> 'canvasSessionId') > 0
            ) OR (
              ${table.externalLookupMetadata} ? 'canvasRunId'
              AND jsonb_typeof(${table.externalLookupMetadata} -> 'canvasRunId') = 'string'
              AND length(${table.externalLookupMetadata} ->> 'canvasRunId') > 0
            )
          )
        )
      )`,
    ),
    check(
      'command_receipts_result_pair_check',
      sql`(${table.resultType} IS NULL) = (${table.resultId} IS NULL)`,
    ),
    check(
      'command_receipts_phase_payload_check',
      sql`(
        ${table.orchestrationPhase} NOT IN ('runtime_known', 'attached')
        OR (
          ${table.externalResourceKind} IS NOT NULL
          AND (
            ${table.externalResourceRef} IS NOT NULL
            OR ${table.externalLookupMetadata} <> '{}'::jsonb
          )
        )
      ) AND (
        ${table.orchestrationPhase} <> 'attached'
        OR (
          ${table.resultId} IS NOT NULL
          AND ${table.resultPayload} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
        )
      )`,
    ),
    unique('command_receipts_workflow_key_unique').on(
      table.workflowId,
      table.commandKey,
    ),
  ],
);

export const bootstrapReceipts = pgTable(
  'bootstrap_receipts',
  {
    id: uuid('id').primaryKey(),
    authSubject: text('auth_subject').notNull(),
    commandKey: text('command_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payloadCanonical: text('payload_canonical').notNull(),
    status: text('status').notNull().default('pending'),
    accountId: uuid('account_id').references(() => accounts.id),
    agentId: uuid('agent_id').references(() => agents.id),
    agentBindingId: uuid('agent_binding_id').references(() => agentBindings.id),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    workflowId: uuid('workflow_id').references(() => workflows.id),
    resultPayload: jsonb('result_payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'bootstrap_receipts_status_check',
      sql`${table.status} IN ('pending', 'completed')`,
    ),
    check(
      'bootstrap_receipts_completion_check',
      sql`${table.status} = 'pending' OR (
        ${table.accountId} IS NOT NULL
        AND ${table.agentId} IS NOT NULL
        AND ${table.agentBindingId} IS NOT NULL
        AND ${table.workspaceId} IS NOT NULL
        AND ${table.workflowId} IS NOT NULL
        AND ${table.resultPayload} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
      )`,
    ),
    unique('bootstrap_receipts_subject_key_unique').on(
      table.authSubject,
      table.commandKey,
    ),
  ],
);

export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    workflowId: uuid('workflow_id').references(() => workflows.id),
    sessionId: uuid('session_id').references(() => sessions.id),
    runId: uuid('run_id').references(() => runs.id),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateSequence: bigint('aggregate_sequence', { mode: 'number' }).notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishAttempts: integer('publish_attempts').notNull().default(0),
  },
  (table) => [
    check(
      'domain_events_aggregate_sequence_positive',
      sql`${table.aggregateSequence} > 0`,
    ),
    check('domain_events_event_version_positive', sql`${table.eventVersion} > 0`),
    check(
      'domain_events_publish_attempts_nonnegative',
      sql`${table.publishAttempts} >= 0`,
    ),
    check(
      'domain_events_hierarchy_check',
      sql`(
        ${table.aggregateType} = 'workspace'
        AND ${table.aggregateId} = ${table.workspaceId}
        AND ${table.workflowId} IS NULL
        AND ${table.sessionId} IS NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.aggregateType} = 'workflow'
        AND ${table.aggregateId} = ${table.workflowId}
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.aggregateType} = 'session'
        AND ${table.aggregateId} = ${table.sessionId}
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NOT NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.aggregateType} = 'run'
        AND ${table.aggregateId} = ${table.runId}
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NOT NULL
        AND ${table.runId} IS NOT NULL
      )`,
    ),
    unique('domain_events_aggregate_sequence_unique').on(
      table.aggregateType,
      table.aggregateId,
      table.aggregateSequence,
    ),
    foreignKey({
      name: 'domain_events_workflow_workspace_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    foreignKey({
      name: 'domain_events_session_workflow_fk',
      columns: [table.workflowId, table.sessionId],
      foreignColumns: [sessions.workflowId, sessions.id],
    }),
    foreignKey({
      name: 'domain_events_run_session_fk',
      columns: [table.sessionId, table.runId],
      foreignColumns: [runs.sessionId, runs.id],
    }),
  ],
);

export const runtimeCompensations = pgTable(
  'runtime_compensations',
  {
    id: uuid('id').primaryKey(),
    commandReceiptId: uuid('command_receipt_id')
      .notNull()
      .references(() => commandReceipts.id),
    agentBindingId: uuid('agent_binding_id')
      .notNull()
      .references(() => agentBindings.id),
    canvasSessionId: uuid('canvas_session_id').references(() => sessions.id),
    canvasRunId: uuid('canvas_run_id').references(() => runs.id),
    externalResourceKind: text('external_resource_kind').notNull(),
    externalResourceRef: text('external_resource_ref'),
    lookupMetadata: jsonb('lookup_metadata').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    action: text('action').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    resolutionEvidence: jsonb('resolution_evidence').notNull().default({}),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'runtime_compensations_action_check',
      sql`${table.action} IN ('adopt', 'destroy', 'reconcile')`,
    ),
    check(
      'runtime_compensations_status_check',
      sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check(
      'runtime_compensations_attempts_nonnegative',
      sql`${table.attempts} >= 0`,
    ),
    check(
      'runtime_compensations_lookup_check',
      sql`jsonb_typeof(${table.lookupMetadata}) = 'object'
        AND ${table.lookupMetadata} ? 'commandId'
        AND jsonb_typeof(${table.lookupMetadata} -> 'commandId') = 'string'
        AND length(${table.lookupMetadata} ->> 'commandId') > 0
        AND (
          (
            ${table.lookupMetadata} ? 'canvasSessionId'
            AND jsonb_typeof(${table.lookupMetadata} -> 'canvasSessionId') = 'string'
            AND length(${table.lookupMetadata} ->> 'canvasSessionId') > 0
          ) OR (
            ${table.lookupMetadata} ? 'canvasRunId'
            AND jsonb_typeof(${table.lookupMetadata} -> 'canvasRunId') = 'string'
            AND length(${table.lookupMetadata} ->> 'canvasRunId') > 0
          )
        )
      `,
    ),
    check(
      'runtime_compensations_run_requires_session',
      sql`${table.canvasRunId} IS NULL OR ${table.canvasSessionId} IS NOT NULL`,
    ),
    check(
      'runtime_compensations_resolution_check',
      sql`jsonb_typeof(${table.resolutionEvidence}) = 'object' AND (
        (
          ${table.status} = 'succeeded'
          AND ${table.resolvedAt} IS NOT NULL
          AND ${table.resolutionEvidence} <> '{}'::jsonb
        ) OR (
          ${table.status} <> 'succeeded'
          AND ${table.resolvedAt} IS NULL
        )
      )`,
    ),
    foreignKey({
      name: 'runtime_compensations_run_session_fk',
      columns: [table.canvasSessionId, table.canvasRunId],
      foreignColumns: [runs.sessionId, runs.id],
    }),
    unique('runtime_compensations_dedupe_unique').on(
      table.commandReceiptId,
      table.externalResourceKind,
      table.dedupeKey,
      table.action,
    ),
  ],
);

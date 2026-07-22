import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { accounts, agentBindings, agents } from './identity';
import { messageRole, runStatus, runtimeKind } from './enums';
import { sessions } from './workflows';

export const modelCatalogEntries = pgTable(
  'model_catalog_entries',
  {
    id: uuid('id').primaryKey(),
    runtimeKind: runtimeKind('runtime_kind').notNull(),
    providerKey: text('provider_key').notNull(),
    modelKey: text('model_key').notNull(),
    displayName: text('display_name').notNull(),
    capabilities: jsonb('capabilities').notNull().default({}),
    availability: text('availability').notNull(),
    discoverySource: text('discovery_source').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'model_catalog_entries_availability_check',
      sql`${table.availability} IN ('available', 'degraded', 'disabled')`,
    ),
    unique('model_catalog_entries_runtime_provider_model_unique').on(
      table.runtimeKind,
      table.providerKey,
      table.modelKey,
    ),
  ],
);

export const sessionConfigRevisions = pgTable(
  'session_config_revisions',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    modelEntryId: uuid('model_entry_id'),
    instructionsOverlay: text('instructions_overlay'),
    toolPolicy: jsonb('tool_policy').notNull().default({}),
    contextPolicy: jsonb('context_policy').notNull().default({}),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => accounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('session_config_revisions_version_positive', sql`${table.version} > 0`),
    unique('session_config_revisions_session_version_unique').on(
      table.sessionId,
      table.version,
    ),
    unique('session_config_revisions_session_id_unique').on(
      table.sessionId,
      table.id,
    ),
    foreignKey({
      name: 'session_config_model_entry_fk',
      columns: [table.modelEntryId],
      foreignColumns: [modelCatalogEntries.id],
    }),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id'),
    ordinal: bigint('ordinal', { mode: 'number' }).notNull(),
    role: messageRole('role').notNull(),
    actorAccountId: uuid('actor_account_id').references(() => accounts.id),
    actorAgentId: uuid('actor_agent_id').references(() => agents.id),
    content: jsonb('content').notNull(),
    status: text('status').notNull(),
    externalMessageRef: text('external_message_ref'),
    sourceRuntimeEventKey: text('source_runtime_event_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('messages_ordinal_nonnegative', sql`${table.ordinal} >= 0`),
    check(
      'messages_status_check',
      sql`${table.status} IN ('partial', 'completed', 'failed')`,
    ),
    check(
      'messages_actor_by_role_check',
      sql`(
        ${table.role} = 'user'
        AND ${table.actorAccountId} IS NOT NULL
        AND ${table.actorAgentId} IS NULL
      ) OR (
        ${table.role} = 'assistant'
        AND ${table.actorAccountId} IS NULL
        AND ${table.actorAgentId} IS NOT NULL
      ) OR ${table.role} IN ('system', 'tool')`,
    ),
    check(
      'messages_runtime_event_requires_run',
      sql`${table.sourceRuntimeEventKey} IS NULL OR ${table.runId} IS NOT NULL`,
    ),
    unique('messages_session_ordinal_unique').on(table.sessionId, table.ordinal),
    unique('messages_session_id_unique').on(table.sessionId, table.id),
    unique('messages_workflow_id_unique').on(table.workflowId, table.id),
    foreignKey({
      name: 'messages_session_workflow_fk',
      columns: [table.workflowId, table.sessionId],
      foreignColumns: [sessions.workflowId, sessions.id],
    }).onDelete('cascade'),
    uniqueIndex('messages_runtime_projection_unique')
      .on(table.runId, table.sourceRuntimeEventKey)
      .where(sql`${table.sourceRuntimeEventKey} IS NOT NULL`),
    index('messages_session_created_idx').on(table.sessionId, table.createdAt),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentBindingId: uuid('agent_binding_id')
      .notNull()
      .references(() => agentBindings.id),
    configRevisionId: uuid('config_revision_id')
      .notNull()
      .references(() => sessionConfigRevisions.id),
    triggerMessageId: uuid('trigger_message_id')
      .notNull()
      .references(() => messages.id),
    idempotencyKey: text('idempotency_key').notNull(),
    status: runStatus('status').notNull().default('queued'),
    runtimeRunRef: text('runtime_run_ref'),
    modelSnapshot: jsonb('model_snapshot').notNull(),
    toolPolicySnapshot: jsonb('tool_policy_snapshot').notNull(),
    contextPolicySnapshot: jsonb('context_policy_snapshot').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('runs_session_idempotency_unique').on(
      table.sessionId,
      table.idempotencyKey,
    ),
    unique('runs_session_id_unique').on(table.sessionId, table.id),
    foreignKey({
      name: 'runs_session_binding_fk',
      columns: [table.sessionId, table.agentBindingId],
      foreignColumns: [sessions.id, sessions.agentBindingId],
    }),
    foreignKey({
      name: 'runs_session_config_fk',
      columns: [table.sessionId, table.configRevisionId],
      foreignColumns: [
        sessionConfigRevisions.sessionId,
        sessionConfigRevisions.id,
      ],
    }),
    foreignKey({
      name: 'runs_session_trigger_message_fk',
      columns: [table.sessionId, table.triggerMessageId],
      foreignColumns: [messages.sessionId, messages.id],
    }),
    uniqueIndex('runs_one_active_per_session')
      .on(table.sessionId)
      .where(
        sql`${table.status} IN ('queued', 'running', 'waiting_approval', 'reconciling')`,
      ),
    index('runs_session_created_idx').on(table.sessionId, table.createdAt.desc()),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    externalEventRef: text('external_event_ref'),
    runtimeEventKey: text('runtime_event_key').notNull(),
    eventFingerprint: text('event_fingerprint').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('run_events_sequence_nonnegative', sql`${table.sequence} >= 0`),
    unique('run_events_sequence_unique').on(table.runId, table.sequence),
    unique('run_events_runtime_key_unique').on(table.runId, table.runtimeEventKey),
    uniqueIndex('run_events_external_ref_unique')
      .on(table.runId, table.externalEventRef)
      .where(sql`${table.externalEventRef} IS NOT NULL`),
    index('run_events_run_sequence_idx').on(table.runId, table.sequence),
  ],
);

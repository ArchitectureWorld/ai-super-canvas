import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  contextScope,
  contextVisibility,
  toolGrantEffect,
  toolGrantScope,
} from './enums';
import { accounts, agents } from './identity';
import { runs } from './execution';
import { sessions, workflows } from './workflows';

export const toolGrants = pgTable(
  'tool_grants',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    scope: toolGrantScope('scope').notNull(),
    agentId: uuid('agent_id').references(() => agents.id),
    workflowId: uuid('workflow_id').references(() => workflows.id),
    sessionId: uuid('session_id').references(() => sessions.id),
    runId: uuid('run_id').references(() => runs.id),
    toolKey: text('tool_key').notNull(),
    effect: toolGrantEffect('effect').notNull(),
    constraints: jsonb('constraints').notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    issuedByAccountId: uuid('issued_by_account_id')
      .notNull()
      .references(() => accounts.id),
    sourceApprovalId: uuid('source_approval_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'tool_grants_scope_columns_check',
      sql`(
        ${table.scope} = 'account'
        AND ${table.agentId} IS NULL
        AND ${table.workflowId} IS NULL
        AND ${table.sessionId} IS NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.scope} = 'agent'
        AND ${table.agentId} IS NOT NULL
        AND ${table.workflowId} IS NULL
        AND ${table.sessionId} IS NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.scope} = 'workflow'
        AND ${table.agentId} IS NULL
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.scope} = 'session'
        AND ${table.agentId} IS NULL
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NOT NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.scope} = 'run'
        AND ${table.agentId} IS NULL
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NOT NULL
        AND ${table.runId} IS NOT NULL
      )`,
    ),
    foreignKey({
      name: 'tool_grants_session_workflow_fk',
      columns: [table.workflowId, table.sessionId],
      foreignColumns: [sessions.workflowId, sessions.id],
    }),
    foreignKey({
      name: 'tool_grants_run_session_fk',
      columns: [table.sessionId, table.runId],
      foreignColumns: [runs.sessionId, runs.id],
    }),
  ],
);

export const toolApprovalDecisions = pgTable(
  'tool_approval_decisions',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    toolCallRef: text('tool_call_ref').notNull(),
    approvalRef: text('approval_ref').notNull(),
    reviewerAccountId: uuid('reviewer_account_id')
      .notNull()
      .references(() => accounts.id),
    decision: text('decision').notNull(),
    createdGrantId: uuid('created_grant_id').references(() => toolGrants.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'tool_approval_decisions_decision_check',
      sql`${table.decision} IN ('allow_once', 'allow_session', 'deny')`,
    ),
    unique('tool_approval_decisions_run_ref_unique').on(
      table.runId,
      table.approvalRef,
    ),
  ],
);

export const contextRefs = pgTable(
  'context_refs',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    agentId: uuid('agent_id').references(() => agents.id),
    workflowId: uuid('workflow_id').references(() => workflows.id),
    sessionId: uuid('session_id').references(() => sessions.id),
    runId: uuid('run_id').references(() => runs.id),
    scope: contextScope('scope').notNull(),
    visibility: contextVisibility('visibility').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceRef: text('source_ref').notNull(),
    snapshot: jsonb('snapshot'),
    provenance: jsonb('provenance').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'context_refs_scope_columns_check',
      sql`(
        ${table.scope} = 'account'
        AND ${table.agentId} IS NULL
        AND ${table.workflowId} IS NULL
        AND ${table.sessionId} IS NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.scope} = 'agent'
        AND ${table.agentId} IS NOT NULL
        AND ${table.workflowId} IS NULL
        AND ${table.sessionId} IS NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.scope} = 'workflow'
        AND ${table.agentId} IS NULL
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.scope} = 'session'
        AND ${table.agentId} IS NULL
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NOT NULL
        AND ${table.runId} IS NULL
      ) OR (
        ${table.scope} = 'run'
        AND ${table.agentId} IS NULL
        AND ${table.workflowId} IS NOT NULL
        AND ${table.sessionId} IS NOT NULL
        AND ${table.runId} IS NOT NULL
      )`,
    ),
    check(
      'context_refs_workspace_visibility_scope_check',
      sql`${table.visibility} = 'private' OR ${table.scope} IN ('workflow', 'session', 'run')`,
    ),
    foreignKey({
      name: 'context_refs_session_workflow_fk',
      columns: [table.workflowId, table.sessionId],
      foreignColumns: [sessions.workflowId, sessions.id],
    }),
    foreignKey({
      name: 'context_refs_run_session_fk',
      columns: [table.sessionId, table.runId],
      foreignColumns: [runs.sessionId, runs.id],
    }),
  ],
);

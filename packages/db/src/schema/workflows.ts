import { sql } from 'drizzle-orm';
import {
  boolean,
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

import { growthState, sessionEdgeKind, sessionStatus, workflowStatus } from './enums';
import {
  accounts,
  agentBindings,
  workspaces,
} from './identity';

const timestampColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: workflowStatus('status').notNull().default('active'),
    currentTrunkRevisionId: uuid('current_trunk_revision_id'),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => accounts.id),
    ...timestampColumns(),
  },
  (table) => [
    unique('workflows_workspace_id_unique').on(table.workspaceId, table.id),
    index('workflows_workspace_updated_idx').on(
      table.workspaceId,
      table.updatedAt.desc(),
    ),
  ],
);

export const trunkRevisions = pgTable(
  'trunk_revisions',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    parentRevisionId: uuid('parent_revision_id'),
    revisionNumber: integer('revision_number').notNull(),
    content: jsonb('content').notNull(),
    contentHash: text('content_hash').notNull(),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => accounts.id),
    createdFromProposalId: uuid('created_from_proposal_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('trunk_revisions_number_positive', sql`${table.revisionNumber} > 0`),
    check(
      'trunk_revisions_s1_proposal_null',
      sql`${table.createdFromProposalId} IS NULL`,
    ),
    unique('trunk_revisions_workflow_number_unique').on(
      table.workflowId,
      table.revisionNumber,
    ),
    unique('trunk_revisions_workflow_id_unique').on(table.workflowId, table.id),
    foreignKey({
      name: 'trunk_revisions_parent_workflow_fk',
      columns: [table.workflowId, table.parentRevisionId],
      foreignColumns: [table.workflowId, table.id],
    }),
    index('trunk_revisions_workflow_created_idx').on(
      table.workflowId,
      table.createdAt.desc(),
    ),
  ],
);

export const branchAnchors = pgTable(
  'branch_anchors',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    contextTrunkRevisionId: uuid('context_trunk_revision_id').notNull(),
    sourceTrunkRevisionId: uuid('source_trunk_revision_id'),
    sourceMessageId: uuid('source_message_id'),
    sourceArtifactId: uuid('source_artifact_id'),
    selector: jsonb('selector').notNull(),
    quote: text('quote'),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => accounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('branch_anchors_workflow_id_unique').on(table.workflowId, table.id),
    foreignKey({
      name: 'branch_anchors_context_trunk_fk',
      columns: [table.workflowId, table.contextTrunkRevisionId],
      foreignColumns: [trunkRevisions.workflowId, trunkRevisions.id],
    }),
    foreignKey({
      name: 'branch_anchors_source_trunk_fk',
      columns: [table.workflowId, table.sourceTrunkRevisionId],
      foreignColumns: [trunkRevisions.workflowId, trunkRevisions.id],
    }),
    check(
      'branch_anchors_s1_source_check',
      sql`${table.sourceArtifactId} IS NULL AND (
        (
          ${table.sourceKind} = 'trunk_revision'
          AND ${table.sourceTrunkRevisionId} IS NOT NULL
          AND ${table.sourceMessageId} IS NULL
        ) OR (
          ${table.sourceKind} = 'message'
          AND ${table.sourceTrunkRevisionId} IS NULL
          AND ${table.sourceMessageId} IS NOT NULL
        )
      )`,
    ),
    index('branch_anchors_workflow_source_idx').on(
      table.workflowId,
      table.sourceKind,
    ),
    index('branch_anchors_source_trunk_idx')
      .on(table.sourceTrunkRevisionId)
      .where(sql`${table.sourceTrunkRevisionId} IS NOT NULL`),
    index('branch_anchors_source_message_idx')
      .on(table.sourceMessageId)
      .where(sql`${table.sourceMessageId} IS NOT NULL`),
    index('branch_anchors_source_artifact_idx')
      .on(table.sourceArtifactId)
      .where(sql`${table.sourceArtifactId} IS NOT NULL`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    agentBindingId: uuid('agent_binding_id')
      .notNull()
      .references(() => agentBindings.id),
    parentSessionId: uuid('parent_session_id'),
    forkAnchorId: uuid('fork_anchor_id'),
    status: sessionStatus('status').notNull().default('provisioning'),
    transcriptVersion: integer('transcript_version').notNull().default(0),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => accounts.id),
    ...timestampColumns(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'sessions_parent_requires_anchor',
      sql`${table.parentSessionId} IS NULL OR ${table.forkAnchorId} IS NOT NULL`,
    ),
    check(
      'sessions_transcript_version_nonnegative',
      sql`${table.transcriptVersion} >= 0`,
    ),
    unique('sessions_workflow_id_unique').on(table.workflowId, table.id),
    unique('sessions_id_binding_unique').on(table.id, table.agentBindingId),
    foreignKey({
      name: 'sessions_parent_workflow_fk',
      columns: [table.workflowId, table.parentSessionId],
      foreignColumns: [table.workflowId, table.id],
    }),
    foreignKey({
      name: 'sessions_anchor_workflow_fk',
      columns: [table.workflowId, table.forkAnchorId],
      foreignColumns: [branchAnchors.workflowId, branchAnchors.id],
    }),
    index('sessions_workflow_updated_idx').on(
      table.workflowId,
      table.updatedAt.desc(),
    ),
    index('sessions_binding_status_idx').on(table.agentBindingId, table.status),
  ],
);

export const sessionRuntimeRefs = pgTable(
  'session_runtime_refs',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentBindingId: uuid('agent_binding_id')
      .notNull()
      .references(() => agentBindings.id),
    externalSessionRef: text('external_session_ref').notNull(),
    runtimeVersion: text('runtime_version').notNull(),
    isPrimary: boolean('is_primary').notNull().default(true),
    status: text('status').notNull().default('active'),
    syncCursor: jsonb('sync_cursor').notNull().default({}),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (table) => [
    check(
      'session_runtime_refs_status_check',
      sql`${table.status} IN ('active', 'historical', 'error')`,
    ),
    unique('runtime_session_ref_unique').on(
      table.agentBindingId,
      table.externalSessionRef,
    ),
    unique('session_runtime_refs_session_binding_id_ref_unique').on(
      table.sessionId,
      table.agentBindingId,
      table.id,
      table.externalSessionRef,
    ),
    foreignKey({
      name: 'session_runtime_refs_binding_fk',
      columns: [table.sessionId, table.agentBindingId],
      foreignColumns: [sessions.id, sessions.agentBindingId],
    }),
    uniqueIndex('runtime_session_active_primary_unique')
      .on(table.sessionId)
      .where(sql`${table.isPrimary} = true AND ${table.status} = 'active'`),
    index('runtime_session_session_idx').on(table.sessionId, table.status),
  ],
);

export const sessionNodes = pgTable(
  'session_nodes',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    title: text('title').notNull(),
    nodeKind: text('node_kind').notNull(),
    growthState: growthState('growth_state').notNull(),
    ...timestampColumns(),
  },
  (table) => [
    check(
      'session_nodes_kind_check',
      sql`${table.nodeKind} IN ('mainline', 'branch', 'review')`,
    ),
    unique('session_nodes_workflow_id_unique').on(table.workflowId, table.id),
    uniqueIndex('session_nodes_session_unique').on(table.sessionId),
    unique('session_nodes_workflow_session_unique').on(
      table.workflowId,
      table.sessionId,
    ),
    foreignKey({
      name: 'session_nodes_session_workflow_fk',
      columns: [table.workflowId, table.sessionId],
      foreignColumns: [sessions.workflowId, sessions.id],
    }).onDelete('cascade'),
  ],
);

export const sessionEdges = pgTable(
  'session_edges',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    sourceSessionNodeId: uuid('source_session_node_id'),
    targetSessionNodeId: uuid('target_session_node_id').notNull(),
    kind: sessionEdgeKind('kind').notNull(),
    anchorId: uuid('anchor_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'session_edges_not_self',
      sql`${table.sourceSessionNodeId} IS NULL OR ${table.sourceSessionNodeId} <> ${table.targetSessionNodeId}`,
    ),
    check(
      'session_edges_anchor_by_kind',
      sql`(
        ${table.kind} = 'derives' AND ${table.anchorId} IS NOT NULL
      ) OR (
        ${table.kind} <> 'derives' AND ${table.anchorId} IS NULL
      )`,
    ),
    foreignKey({
      name: 'session_edges_source_workflow_fk',
      columns: [table.workflowId, table.sourceSessionNodeId],
      foreignColumns: [sessionNodes.workflowId, sessionNodes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'session_edges_target_workflow_fk',
      columns: [table.workflowId, table.targetSessionNodeId],
      foreignColumns: [sessionNodes.workflowId, sessionNodes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'session_edges_anchor_workflow_fk',
      columns: [table.workflowId, table.anchorId],
      foreignColumns: [branchAnchors.workflowId, branchAnchors.id],
    }),
    uniqueIndex('session_edges_source_target_kind_unique')
      .on(table.sourceSessionNodeId, table.targetSessionNodeId, table.kind)
      .where(sql`${table.sourceSessionNodeId} IS NOT NULL`),
    uniqueIndex('session_edges_one_birth_unique')
      .on(table.targetSessionNodeId)
      .where(sql`${table.kind} = 'derives'`),
    index('session_edges_workflow_source_idx').on(
      table.workflowId,
      table.sourceSessionNodeId,
    ),
    index('session_edges_workflow_target_idx').on(
      table.workflowId,
      table.targetSessionNodeId,
    ),
  ],
);

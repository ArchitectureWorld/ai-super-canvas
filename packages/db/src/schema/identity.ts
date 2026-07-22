import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bindingStatus, runtimeKind } from './enums';

const timestampColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    authSubject: text('auth_subject').notNull().unique(),
    email: text('email'),
    displayName: text('display_name').notNull(),
    defaultAgentId: uuid('default_agent_id'),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('accounts_email_lower_unique')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} IS NOT NULL`),
  ],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    defaultModelKey: text('default_model_key'),
    memoryPolicy: jsonb('memory_policy').notNull().default({}),
    ...timestampColumns(),
  },
  (table) => [
    check('agents_status_check', sql`${table.status} IN ('active', 'disabled', 'archived')`),
    index('agents_owner_status_idx').on(table.ownerAccountId, table.status),
    unique('agents_owner_id_unique').on(table.ownerAccountId, table.id),
  ],
);

export const agentAccessGrants = pgTable(
  'agent_access_grants',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    role: text('role').notNull(),
    grantedByAccountId: uuid('granted_by_account_id')
      .notNull()
      .references(() => accounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    check('agent_access_grants_role_check', sql`${table.role} IN ('use', 'admin')`),
    uniqueIndex('agent_access_active_unique')
      .on(table.agentId, table.accountId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const agentBindings = pgTable(
  'agent_bindings',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    runtimeKind: runtimeKind('runtime_kind').notNull(),
    externalAgentRef: text('external_agent_ref'),
    isolationKey: text('isolation_key').notNull(),
    endpointRef: text('endpoint_ref'),
    secretRef: text('secret_ref'),
    runtimeVersion: text('runtime_version'),
    capabilities: jsonb('capabilities').notNull().default({}),
    status: bindingStatus('status').notNull().default('provisioning'),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...timestampColumns(),
  },
  (table) => [
    index('agent_bindings_agent_status_idx').on(table.agentId, table.status),
    uniqueIndex('agent_bindings_primary_unique')
      .on(table.agentId)
      .where(sql`${table.isPrimary} = true AND ${table.status} IN ('ready', 'degraded')`),
    uniqueIndex('agent_bindings_external_unique')
      .on(table.runtimeKind, table.externalAgentRef)
      .where(sql`${table.externalAgentRef} IS NOT NULL AND ${table.status} <> 'disabled'`),
    uniqueIndex('agent_bindings_isolation_unique')
      .on(table.runtimeKind, table.isolationKey)
      .where(sql`${table.status} <> 'disabled'`),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    ...timestampColumns(),
  },
  (table) => [
    index('workspaces_owner_updated_idx').on(
      table.ownerAccountId,
      table.updatedAt.desc(),
    ),
  ],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'workspace_members_pk',
      columns: [table.workspaceId, table.accountId],
    }),
    check(
      'workspace_members_role_check',
      sql`${table.role} IN ('owner', 'editor', 'runner', 'viewer')`,
    ),
  ],
);

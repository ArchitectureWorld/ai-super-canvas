import { pgEnum } from 'drizzle-orm/pg-core';

export const runtimeKind = pgEnum('runtime_kind', [
  'fake',
  'hermes-acp',
  'letta',
  'langgraph',
  'canvas-native',
]);

export const bindingStatus = pgEnum('binding_status', [
  'provisioning',
  'ready',
  'degraded',
  'disabled',
  'error',
]);

export const workflowStatus = pgEnum('workflow_status', [
  'active',
  'dormant',
  'archived',
]);

export const sessionStatus = pgEnum('session_status', [
  'provisioning',
  'active',
  'dormant',
  'closed',
  'archived',
  'error',
]);

export const growthState = pgEnum('growth_state', [
  'active',
  'dormant',
  'metabolized',
]);

export const sessionEdgeKind = pgEnum('session_edge_kind', [
  'derives',
  'references',
  'supports',
  'contradicts',
  'depends_on',
]);

export const runStatus = pgEnum('run_status', [
  'queued',
  'running',
  'waiting_approval',
  'reconciling',
  'succeeded',
  'failed',
  'cancelled',
]);

export const messageRole = pgEnum('message_role', [
  'user',
  'assistant',
  'system',
  'tool',
]);

export const toolGrantEffect = pgEnum('tool_grant_effect', [
  'allow',
  'deny',
  'require_approval',
]);

export const toolGrantScope = pgEnum('tool_grant_scope', [
  'account',
  'agent',
  'workflow',
  'session',
  'run',
]);

export const contextScope = pgEnum('context_scope', [
  'account',
  'agent',
  'workflow',
  'session',
  'run',
]);

export const contextVisibility = pgEnum('context_visibility', [
  'private',
  'workspace',
]);

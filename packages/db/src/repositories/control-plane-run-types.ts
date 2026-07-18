import type { ActorContext } from '@ai-super-canvas/core';

import type { OrchestrationPhase, StoredMessage } from './control-plane-repository';

export type StoredRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface RuntimeBindingSnapshot {
  canvasAgentBindingId: string;
  agentId: string;
  runtimeKind: string;
  isolationKey: string;
  endpointRef?: string;
  secretRef?: string;
}

export interface RuntimeModelSnapshot {
  providerKey: string;
  modelKey: string;
}

export interface RuntimeToolPolicySnapshot {
  allowedToolKeys: string[];
  deniedToolKeys: string[];
  approvalRequiredToolKeys: string[];
}

export interface RuntimeContextSnapshot {
  canvasContextRefId: string;
  scope: 'account' | 'agent' | 'workflow' | 'session' | 'run';
  visibility: 'private' | 'workspace';
  content: unknown;
  provenance: Record<string, unknown>;
}

export interface PreparedRun {
  commandReceiptId: string;
  phase: OrchestrationPhase;
  workflowId: string;
  sessionId: string;
  runId: string;
  status: StoredRunStatus;
  prompt: {
    canvasMessageId: string;
    role: 'user';
    content: string;
  };
  runtime: {
    binding: RuntimeBindingSnapshot;
    externalSessionRef: string;
    expectedHistoryDigest: string;
    model: RuntimeModelSnapshot;
    toolPolicy: RuntimeToolPolicySnapshot;
    context: RuntimeContextSnapshot[];
  };
}

export interface PrepareRunInput {
  actor: ActorContext;
  commandId: string;
  idempotencyKey: string;
  sessionId: string;
  content: string;
}

export interface RuntimeRunAttachment {
  externalRunRef: string;
  acceptedAt: string;
}

export interface StoredRunEvent {
  runId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  externalEventRef: string | null;
  runtimeEventKey: string;
  occurredAt: string;
}

export interface PersistableRunEvent {
  runtimeEventKey: string;
  eventType: string;
  payload: unknown;
  externalEventRef?: string;
  occurredAt: string;
  message?: {
    role: 'assistant' | 'tool';
    content: unknown;
    externalMessageRef?: string;
  };
  terminal?: {
    status: 'succeeded' | 'failed' | 'cancelled';
    errorCode?: string;
    errorMessage?: string;
  };
}

export interface RunRuntimeContext {
  actor: ActorContext;
  workflowId: string;
  sessionId: string;
  runId: string;
  status: StoredRunStatus;
  binding: RuntimeBindingSnapshot;
  externalSessionRef: string;
  externalRunRef: string | null;
}

export interface StoredSessionSnapshot {
  sessionId: string;
  status: string;
  messages: StoredMessage[];
  activeRun: null | {
    runId: string;
    status: StoredRunStatus;
  };
  runtimeRef: null | {
    externalSessionRef: string;
    status: 'active' | 'historical' | 'error';
  };
}

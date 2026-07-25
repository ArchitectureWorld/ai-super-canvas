import type { ActorContext } from '@ai-super-canvas/core';
import type { StoredRunStatus } from '@ai-super-canvas/db';

export interface BootstrapLocalAlphaInput {
  commandId: string;
  authSubject: string;
  displayName?: string;
}

export interface LocalAlphaBootstrapDto {
  accountId: string;
  agentId: string;
  agentBindingId: string;
  workspaceId: string;
  workflowId: string;
  trunkRevisionId: string;
}

export interface CreateRootSessionInput {
  actor: ActorContext;
  commandId: string;
  workflowId: string;
  agentBindingId: string;
  title: string;
}

export interface CreatedSessionDto {
  sessionId: string;
  nodeId: string;
  status: 'active';
}

export interface StartSessionRunInput {
  actor: ActorContext;
  commandId: string;
  idempotencyKey: string;
  sessionId: string;
  content: string;
}

export interface StartedRunDto {
  runId: string;
  status: StoredRunStatus;
}

export interface GetRunEventsInput {
  actor: ActorContext;
  runId: string;
  after: number;
  limit?: number;
}

export interface RunEventDto {
  sequence: number;
  eventType: string;
  payload: unknown;
  occurredAt: string;
}

export interface RunEventsPageDto {
  events: RunEventDto[];
  nextAfter: number;
  terminal: null | {
    status: 'succeeded' | 'failed' | 'cancelled';
  };
}

export interface GetSessionTranscriptInput {
  actor: ActorContext;
  sessionId: string;
}

export type RuntimeAvailability = 'available' | 'unavailable';

export type ReconciliationState =
  | {
      kind: 'run-reconciling';
      message: string;
    }
  | {
      kind: 'runtime-unavailable';
      message: string;
    };

export interface SessionMessageDto {
  messageId: string;
  runId: string | null;
  ordinal: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  status: string;
}

export interface SessionTranscriptDto {
  sessionId: string;
  status: string;
  messages: SessionMessageDto[];
  activeRun: null | {
    runId: string;
    status: StoredRunStatus;
  };
  reconciliationState: ReconciliationState | null;
  runtimeAvailability: RuntimeAvailability;
}

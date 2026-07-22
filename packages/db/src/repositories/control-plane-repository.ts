import type {
  ActorContext,
  CreateAnchoredSessionCommand,
  ForkMessageSessionCommand,
} from '@ai-super-canvas/core';

import type {
  PersistableRunEvent,
  PrepareRunInput,
  PreparedRun,
  RunRuntimeContext,
  RuntimeRunAttachment,
  StoredSessionSnapshot,
  StoredRunEvent,
} from './control-plane-run-types';

export interface LocalAlphaModelSeed {
  providerKey: string;
  modelKey: string;
  displayName: string;
  capabilities?: Readonly<Record<string, unknown>>;
}

export interface BootstrapLocalAlphaInput {
  commandId: string;
  authSubject: string;
  displayName: string;
  availableModels?: readonly LocalAlphaModelSeed[];
  defaultModelKey?: string;
  defaultModelProviderKey?: string;
}

export interface BootstrappedControlPlane {
  accountId: string;
  authSubject: string;
  agentId: string;
  agentBindingId: string;
  workspaceId: string;
  workflowId: string;
  trunkRevisionId: string;
  defaultModelEntryId: string;
}

export type OrchestrationPhase =
  | 'canvas_prepared'
  | 'runtime_dispatched'
  | 'runtime_known'
  | 'attached'
  | 'reconciling'
  | 'retryable_failure'
  | 'terminal_failure';

export interface CreateRootSessionInput {
  actor: ActorContext;
  commandId: string;
  workflowId: string;
  agentBindingId: string;
  title: string;
}

export interface StoredModel {
  id: string;
  runtimeKind: string;
  providerKey: string;
  modelKey: string;
  displayName: string;
  capabilities: Record<string, unknown>;
}

export interface StoredSessionConfig {
  id: string;
  sessionId: string;
  version: number;
  modelEntryId: string;
  model: StoredModel;
  instructionsOverlay: string | null;
  toolPolicy: Record<string, unknown>;
  contextPolicy: Record<string, unknown>;
}

export interface CreatedSession {
  commandReceiptId: string;
  phase: OrchestrationPhase;
  sessionId: string;
  nodeId: string;
  status: 'provisioning' | 'active';
  config: StoredSessionConfig;
}

export interface AvailableModel extends StoredModel {
  availability: 'available';
}

export interface UpdateSessionConfigInput {
  actor: ActorContext;
  sessionId: string;
  commandId: string;
  expectedVersion: number;
  modelEntryId: string;
}

export interface HydratedWorkflow {
  workflow: {
    id: string;
    workspaceId: string;
    title: string;
    status: string;
    currentTrunkRevisionId: string | null;
  };
  trunk: null | {
    id: string;
    revisionNumber: number;
    content: unknown;
    contentHash: string;
  };
  anchors: Array<{
    id: string;
    sourceKind: string;
    contextTrunkRevisionId: string;
    sourceTrunkRevisionId: string | null;
    sourceMessageId: string | null;
    selector: unknown;
    quote: string | null;
  }>;
  edges: Array<{
    id: string;
    sourceSessionNodeId: string | null;
    targetSessionNodeId: string;
    kind: string;
    anchorId: string | null;
    metadata: Record<string, unknown>;
  }>;
  blocks: Array<{
    session: {
      id: string;
      workflowId: string;
      agentBindingId: string;
      parentSessionId: string | null;
      forkAnchorId: string | null;
      status: string;
      transcriptVersion: number;
    };
    node: {
      id: string;
      title: string;
      nodeKind: string;
      growthState: string;
    };
    currentConfig: StoredSessionConfig;
    messages: StoredMessage[];
    activeRun: null | {
      id: string;
      status: string;
      lastSequence: number;
    };
  }>;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  runId: string | null;
  ordinal: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  status: string;
  externalMessageRef: string | null;
  sourceRuntimeEventKey: string | null;
}

export interface PrepareAnchoredSessionInput {
  actor: ActorContext;
  command: CreateAnchoredSessionCommand;
}

export interface PreparedAnchoredSession extends CreatedSession {
  anchorId: string;
}

export interface TranscriptMessage {
  canvasMessageId: string;
  role: StoredMessage['role'];
  content: unknown;
}

export interface PrepareForkInput {
  actor: ActorContext;
  command: ForkMessageSessionCommand;
}

export interface PreparedFork extends CreatedSession {
  anchorId: string;
  parentSessionId: string;
  parentExternalSessionRef: string;
  expectedParentHistoryDigest: string;
  transcriptPrefixDigest: string;
  transcriptPrefix: TranscriptMessage[];
}

export interface RuntimeSessionAttachment {
  externalSessionRef: string;
  runtimeVersion: string;
  replayStatus: 'complete' | 'partial' | 'unknown';
  historyDigest?: string;
  metadata: Record<string, unknown>;
}

export interface BeginRuntimeDispatchInput {
  actor: ActorContext;
  commandReceiptId: string;
}

export interface RuntimeDispatchState {
  phase: OrchestrationPhase;
  dispatchAllowed: boolean;
}

export interface RuntimeResourceKnownInput {
  actor: ActorContext;
  commandReceiptId: string;
  externalResourceKind: 'session' | 'run';
  externalResourceRef: string;
  lookupMetadata?: Record<string, unknown>;
}

export interface AttachRuntimeSessionInput {
  actor: ActorContext;
  commandReceiptId: string;
  runtimeSession: RuntimeSessionAttachment;
}

export interface RuntimeCommandFailureInput {
  actor: ActorContext;
  commandReceiptId: string;
  retryable: boolean;
  error: string;
}

export interface RuntimeCommandReconcileInput {
  actor: ActorContext;
  commandReceiptId: string;
  externalResourceKind: 'session' | 'run';
  externalResourceRef?: string;
  lookupMetadata?: Record<string, unknown>;
  error: string;
}

export type RuntimeReconciliationResolution =
  | {
      kind: 'adopt-session';
      runtimeSession: RuntimeSessionAttachment;
      evidence: Record<string, unknown>;
    }
  | {
      kind: 'absent';
      evidence: Record<string, unknown>;
    }
  | {
      kind: 'unresolved';
      evidence: Record<string, unknown>;
      error: string;
    };

export interface ResolveRuntimeReconciliationInput {
  actor: ActorContext;
  commandReceiptId: string;
  resolution: RuntimeReconciliationResolution;
}

export interface RuntimeReconciliationResult {
  phase: OrchestrationPhase;
  outcome: 'adopted' | 'absent' | 'unresolved';
}

export interface SessionRuntimeContext {
  sessionId: string;
  workflowId: string;
  status: string;
  binding: {
    agentBindingId: string;
    agentId: string;
    runtimeKind: string;
    isolationKey: string;
    endpointRef: string | null;
    secretRef: string | null;
  };
  externalSessionRef: string | null;
  expectedHistoryDigest: string | null;
  config: StoredSessionConfig;
  context: Array<Record<string, unknown>>;
}

export interface ControlPlaneRepository {
  bootstrapLocalAlpha(input: BootstrapLocalAlphaInput): Promise<BootstrappedControlPlane>;
  resolveActorContext(input: { authSubject: string }): Promise<ActorContext | null>;
  createRootSession(input: CreateRootSessionInput): Promise<CreatedSession>;
  prepareAnchoredSession(
    input: PrepareAnchoredSessionInput,
  ): Promise<PreparedAnchoredSession>;
  prepareFork(input: PrepareForkInput): Promise<PreparedFork>;
  prepareRun(input: PrepareRunInput): Promise<PreparedRun>;
  hydrateWorkflow(input: {
    actor: ActorContext;
    workflowId: string;
  }): Promise<HydratedWorkflow>;
  listAvailableModels(input: {
    actor: ActorContext;
    sessionId: string;
  }): Promise<AvailableModel[]>;
  updateSessionConfig(input: UpdateSessionConfigInput): Promise<StoredSessionConfig>;
  loadSessionTranscript(input: {
    actor: ActorContext;
    sessionId: string;
  }): Promise<StoredMessage[]>;
  beginRuntimeDispatch(input: BeginRuntimeDispatchInput): Promise<RuntimeDispatchState>;
  recordRuntimeResourceKnown(input: RuntimeResourceKnownInput): Promise<void>;
  attachRuntimeSession(input: AttachRuntimeSessionInput): Promise<void>;
  attachRuntimeRun(input: {
    actor: ActorContext;
    commandReceiptId: string;
    runtimeRun: RuntimeRunAttachment;
  }): Promise<void>;
  ingestRuntimeEvent(input: {
    actor: ActorContext;
    runId: string;
    event: PersistableRunEvent;
  }): Promise<StoredRunEvent>;
  listRunEvents(input: {
    actor: ActorContext;
    runId: string;
    after: number;
    limit?: number;
  }): Promise<StoredRunEvent[]>;
  getRunRuntimeContext(input: {
    actor: ActorContext;
    runId: string;
  }): Promise<RunRuntimeContext>;
  loadSessionSnapshot(input: {
    actor: ActorContext;
    sessionId: string;
  }): Promise<StoredSessionSnapshot>;
  syncRuntimeSessionHistory(input: {
    actor: ActorContext;
    sessionId: string;
    historyDigest: string;
  }): Promise<void>;
  markRuntimeSessionUnavailable(input: {
    actor: ActorContext;
    sessionId: string;
    error: string;
  }): Promise<void>;
  markRunReconciling(input: {
    actor: ActorContext;
    runId: string;
    error: string;
  }): Promise<void>;
  reconcileOrphanedRuns(): Promise<number>;
  markRuntimeCommandFailure(input: RuntimeCommandFailureInput): Promise<void>;
  markRuntimeCommandReconciling(input: RuntimeCommandReconcileInput): Promise<void>;
  resolveRuntimeReconciliation(
    input: ResolveRuntimeReconciliationInput,
  ): Promise<RuntimeReconciliationResult>;
  getSessionRuntimeContext(input: {
    actor: ActorContext;
    sessionId: string;
  }): Promise<SessionRuntimeContext>;
  close(): Promise<void>;
}

export class CommandPayloadConflictError extends Error {
  constructor(commandKey: string) {
    super(`Command payload conflict for ${commandKey}`);
    this.name = 'CommandPayloadConflictError';
  }
}

export class AuthorizationError extends Error {
  constructor() {
    super('Unauthorized control-plane operation');
    this.name = 'AuthorizationError';
  }
}

export class SessionConfigVersionConflictError extends Error {
  constructor(expectedVersion: number, actualVersion: number) {
    super(`Session config version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = 'SessionConfigVersionConflictError';
  }
}

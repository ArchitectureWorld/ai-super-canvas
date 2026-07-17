import { createHash } from 'node:crypto';

export type RuntimeKind =
  | 'fake'
  | 'hermes-acp'
  | 'letta'
  | 'langgraph'
  | 'canvas-native';

export type CapabilitySupport = 'native' | 'adapter' | 'unsupported';

export interface RuntimeCapabilities {
  persistentSessions: CapabilitySupport;
  completedTurnPersistence: CapabilitySupport;
  inFlightResume: CapabilitySupport;
  concurrentSessions: CapabilitySupport;
  forkSession: CapabilitySupport;
  forkAtMessage: CapabilitySupport;
  eventReplay: CapabilitySupport;
  streamingText: CapabilitySupport;
  streamingToolOutput: CapabilitySupport;
  typedFailures: CapabilitySupport;
  cancellation: CapabilitySupport;
  toolApproval: CapabilitySupport;
  sessionModelSwitch: CapabilitySupport;
  sessionToolPolicy: CapabilitySupport;
  perSessionMcpPolicy: CapabilitySupport;
  clientIdempotency: CapabilitySupport;
  exactlyOneTerminalEvent: CapabilitySupport;
  snapshotRestore: CapabilitySupport;
  runtimeModelCatalog: CapabilitySupport;
}

export interface RuntimeDescriptor {
  kind: RuntimeKind;
  runtimeVersion: string;
  adapterVersion: string;
  capabilities: RuntimeCapabilities;
}

export interface RuntimeBindingContext {
  canvasAgentBindingId: string;
  isolationKey: string;
  endpointRef?: string;
  secretRef?: string;
}

export interface RuntimeModelSelection {
  providerKey: string;
  modelKey: string;
}

export interface RuntimeToolPolicy {
  allowedToolKeys: string[];
  deniedToolKeys: string[];
  approvalRequiredToolKeys: string[];
}

export interface RuntimeContextItem {
  canvasContextRefId: string;
  scope: 'account' | 'agent' | 'workflow' | 'session' | 'run';
  visibility: 'private' | 'workspace';
  content: unknown;
  provenance: Record<string, unknown>;
}

export interface RuntimeTranscriptMessage {
  canvasMessageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
}

export interface RuntimeSessionRef {
  externalSessionRef: string;
  runtimeVersion: string;
  replayStatus: 'complete' | 'partial' | 'unknown';
  historyDigest?: string;
  lineage?: {
    parentCanvasSessionId: string;
    atCanvasMessageId: string;
    sourceRevisionId: string;
    transcriptPrefixDigest: string;
  };
  metadata: Record<string, unknown>;
}

export interface CreateRuntimeSessionInput {
  commandId: string;
  binding: RuntimeBindingContext;
  canvasSessionId: string;
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: RuntimeContextItem[];
}

export interface LoadRuntimeSessionInput {
  commandId: string;
  binding: RuntimeBindingContext;
  canvasSessionId: string;
  externalSessionRef: string;
}

export interface ForkRuntimeSessionInput {
  commandId: string;
  binding: RuntimeBindingContext;
  parentCanvasSessionId: string;
  parentExternalSessionRef: string;
  childCanvasSessionId: string;
  atCanvasMessageId: string;
  sourceRevisionId: string;
  expectedParentHistoryDigest: string;
  transcriptPrefixDigest: string;
  transcriptPrefix: RuntimeTranscriptMessage[];
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: RuntimeContextItem[];
}

export interface StartRuntimeRunInput {
  commandId: string;
  idempotencyKey: string;
  binding: RuntimeBindingContext;
  canvasRunId: string;
  canvasSessionId: string;
  externalSessionRef: string;
  expectedHistoryDigest: string;
  prompt: RuntimeTranscriptMessage;
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: RuntimeContextItem[];
}

export interface RuntimeRunRef {
  externalRunRef?: string;
  acceptedAt: string;
}

export type RuntimeEvent =
  | RuntimeRunAccepted
  | RuntimeRunStarted
  | RuntimeModelOutputDelta
  | RuntimeMessageCompleted
  | RuntimeToolRequested
  | RuntimeApprovalRequired
  | RuntimeToolStarted
  | RuntimeToolOutputDelta
  | RuntimeToolCompleted
  | RuntimeArtifactUpdated
  | RuntimeRunCompleted
  | RuntimeRunFailed
  | RuntimeRunCancelled
  | RuntimeWarning;

export interface RuntimeEventBase {
  eventId: string;
  externalSequence?: number;
  canvasSessionId: string;
  canvasRunId: string;
  externalEventRef?: string;
  occurredAt: string;
}

export interface RuntimeRunAccepted extends RuntimeEventBase {
  type: 'run.accepted';
  externalRunRef?: string;
}

export interface RuntimeRunStarted extends RuntimeEventBase {
  type: 'run.started';
}

export interface RuntimeModelOutputDelta extends RuntimeEventBase {
  type: 'model.output.delta';
  text: string;
}

export interface RuntimeMessageCompleted extends RuntimeEventBase {
  type: 'message.completed';
  role: 'assistant' | 'tool';
  content: unknown;
  externalMessageRef?: string;
}

export interface RuntimeToolRequested extends RuntimeEventBase {
  type: 'tool.requested';
  toolCallRef: string;
  toolKey: string;
  input: unknown;
}

export interface RuntimeApprovalRequired extends RuntimeEventBase {
  type: 'approval.required';
  approvalRef: string;
  toolCallRef: string;
  toolKey: string;
  risk: 'low' | 'medium' | 'high';
  choices: Array<'allow-once' | 'allow-session' | 'deny'>;
}

export interface RuntimeToolStarted extends RuntimeEventBase {
  type: 'tool.started';
  toolCallRef: string;
}

export interface RuntimeToolOutputDelta extends RuntimeEventBase {
  type: 'tool.output.delta';
  toolCallRef: string;
  content: unknown;
}

export interface RuntimeToolCompleted extends RuntimeEventBase {
  type: 'tool.completed';
  toolCallRef: string;
  output: unknown;
  isError: boolean;
}

export interface RuntimeArtifactUpdated extends RuntimeEventBase {
  type: 'artifact.updated';
  artifactKind: string;
  title: string;
  content: unknown;
}

export interface RuntimeRunCompleted extends RuntimeEventBase {
  type: 'run.completed';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
  };
}

export interface RuntimeRunFailed extends RuntimeEventBase {
  type: 'run.failed';
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
}

export interface RuntimeRunCancelled extends RuntimeEventBase {
  type: 'run.cancelled';
  reason: 'user' | 'timeout' | 'shutdown' | 'policy';
}

export interface RuntimeWarning extends RuntimeEventBase {
  type: 'runtime.warning';
  code: string;
  message: string;
}

export type RuntimeErrorCode =
  | 'runtime_unavailable'
  | 'binding_not_found'
  | 'session_not_found'
  | 'session_ownership_mismatch'
  | 'session_busy'
  | 'run_not_found'
  | 'model_not_available'
  | 'tool_not_allowed'
  | 'approval_expired'
  | 'context_rejected'
  | 'transcript_conflict'
  | 'history_diverged'
  | 'replay_incomplete'
  | 'rate_limited'
  | 'cancelled'
  | 'protocol_error'
  | 'internal_error';

export type RuntimeOperationEffect = 'not-applied' | 'unknown';

export class RuntimeAdapterError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly retryable = false,
    readonly operationEffect: RuntimeOperationEffect = 'unknown',
  ) {
    super(message);
    this.name = 'RuntimeAdapterError';
  }
}

export class RuntimeCapabilityError extends RuntimeAdapterError {
  constructor(readonly capability: keyof RuntimeCapabilities) {
    super(
      'protocol_error',
      `Runtime capability is not available: ${capability}`,
      false,
      'not-applied',
    );
    this.name = 'RuntimeCapabilityError';
  }
}

export interface RuntimeApprovalDecision {
  commandId: string;
  binding: RuntimeBindingContext;
  canvasRunId: string;
  externalRunRef?: string;
  approvalRef: string;
  decision: 'allow-once' | 'allow-session' | 'deny';
}

export interface RuntimeSnapshot {
  format: string;
  version: string;
  payload: unknown;
}

export interface RuntimeModelEntry {
  providerKey: string;
  modelKey: string;
  displayName: string;
  capabilities: Record<string, unknown>;
}

export interface RuntimeHealth {
  status: 'ready' | 'degraded' | 'unavailable';
  checkedAt: string;
  details: Record<string, unknown>;
}

export interface RuntimeCancelAck {
  outcome: 'accepted' | 'already-terminal' | 'not-active' | 'unknown';
  externalRunRef?: string;
  observedTerminal?: 'succeeded' | 'failed' | 'cancelled';
  acknowledgedAt: string;
}

export interface RuntimeAdapter {
  describe(binding: RuntimeBindingContext): Promise<RuntimeDescriptor>;
  health(binding: RuntimeBindingContext): Promise<RuntimeHealth>;
  listModels(binding: RuntimeBindingContext): Promise<RuntimeModelEntry[]>;
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSessionRef>;
  loadSession(input: LoadRuntimeSessionInput): Promise<RuntimeSessionRef>;
  listSessions(input: {
    binding: RuntimeBindingContext;
    cursor?: string;
  }): Promise<{ sessions: RuntimeSessionRef[]; nextCursor?: string }>;
  forkSession(input: ForkRuntimeSessionInput): Promise<RuntimeSessionRef>;
  startRun(input: StartRuntimeRunInput): Promise<RuntimeRunRef>;
  streamRunEvents(input: {
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
    afterExternalEventRef?: string;
  }): AsyncIterable<RuntimeEvent>;
  cancelRun(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
  }): Promise<RuntimeCancelAck>;
  respondToApproval(input: RuntimeApprovalDecision): Promise<void>;
  setSessionModel(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasSessionId: string;
    externalSessionRef: string;
    model: RuntimeModelSelection;
    expectedIdle: true;
  }): Promise<void>;
  setSessionToolPolicy(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasSessionId: string;
    externalSessionRef: string;
    toolPolicy: RuntimeToolPolicy;
    expectedIdle: true;
  }): Promise<void>;
  exportSnapshot(input: LoadRuntimeSessionInput): Promise<RuntimeSnapshot>;
  restoreSnapshot(input: CreateRuntimeSessionInput & {
    snapshot: RuntimeSnapshot;
  }): Promise<RuntimeSessionRef>;
  shutdown(input: {
    binding: RuntimeBindingContext;
    reason: 'test' | 'deploy' | 'idle' | 'failure';
  }): Promise<void>;
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Runtime transcript must contain finite JSON numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Runtime transcript must be canonical JSON data');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Runtime transcript must not contain circular references');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError('Runtime transcript arrays must not be sparse');
        }
        return canonicalize(value[index], ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Runtime transcript must contain only plain JSON objects');
    }
    const record = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key], ancestors);
    }
    return sorted;
  } finally {
    ancestors.delete(value);
  }
}

export function digestRuntimeTranscript(
  transcript: readonly RuntimeTranscriptMessage[],
): string {
  const canonicalJson = JSON.stringify(canonicalize(transcript, new Set()));
  return `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`;
}

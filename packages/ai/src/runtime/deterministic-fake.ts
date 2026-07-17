import {
  RuntimeAdapterError,
  RuntimeCapabilityError,
  digestRuntimeTranscript,
  type CreateRuntimeSessionInput,
  type ForkRuntimeSessionInput,
  type LoadRuntimeSessionInput,
  type RuntimeAdapter,
  type RuntimeApprovalDecision,
  type RuntimeBindingContext,
  type RuntimeCancelAck,
  type RuntimeCapabilities,
  type RuntimeDescriptor,
  type RuntimeErrorCode,
  type RuntimeEvent,
  type RuntimeHealth,
  type RuntimeModelEntry,
  type RuntimeModelSelection,
  type RuntimeRunRef,
  type RuntimeSessionRef,
  type RuntimeSnapshot,
  type RuntimeToolPolicy,
  type RuntimeTranscriptMessage,
  type StartRuntimeRunInput,
} from './contract';

const fakeModel: RuntimeModelEntry = {
  providerKey: 'fake',
  modelKey: 'deterministic-v1',
  displayName: 'Deterministic Fake v1',
  capabilities: { text: true, tools: false },
};

const fakeCapabilities: RuntimeCapabilities = {
  persistentSessions: 'unsupported',
  completedTurnPersistence: 'unsupported',
  inFlightResume: 'unsupported',
  concurrentSessions: 'native',
  forkSession: 'native',
  forkAtMessage: 'native',
  eventReplay: 'native',
  streamingText: 'native',
  streamingToolOutput: 'unsupported',
  typedFailures: 'native',
  cancellation: 'native',
  toolApproval: 'unsupported',
  sessionModelSwitch: 'unsupported',
  sessionToolPolicy: 'unsupported',
  perSessionMcpPolicy: 'unsupported',
  clientIdempotency: 'unsupported',
  exactlyOneTerminalEvent: 'native',
  snapshotRestore: 'native',
  runtimeModelCatalog: 'native',
};

interface FakeSession {
  bindingKey: string;
  canvasSessionId: string;
  externalSessionRef: string;
  transcript: RuntimeTranscriptMessage[];
  historyDigest: string;
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: CreateRuntimeSessionInput['context'];
  lineage?: NonNullable<RuntimeSessionRef['lineage']>;
  createdOrder: number;
}

interface FakeRun {
  bindingKey: string;
  canvasRunId: string;
  externalRunRef: string;
  canvasSessionId: string;
  externalSessionRef: string;
  sessionKey: string;
  acceptedAt: string;
  ledger: RuntimeEvent[];
  plannedEvents: RuntimeEvent[];
  productionCursor: number;
  closed: boolean;
  terminal?: 'succeeded' | 'failed' | 'cancelled';
  cancelRequested: boolean;
  messageMaterialized: boolean;
  input: StartRuntimeRunInput;
}

interface UsedCommand {
  bindingKey: string;
  operation: 'createSession' | 'forkSession' | 'startRun' | 'restoreSnapshot';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function notApplied(code: RuntimeErrorCode, message: string): RuntimeAdapterError {
  return new RuntimeAdapterError(code, message, false, 'not-applied');
}

function cloneRuntimeInput<T>(value: T): T {
  try {
    return clone(value);
  } catch {
    throw notApplied('context_rejected', 'Runtime input could not be safely cloned');
  }
}

function isRuntimeTranscriptMessage(value: unknown): value is RuntimeTranscriptMessage {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (
      typeof record.canvasMessageId !== 'string'
      || record.canvasMessageId.length === 0
      || typeof record.role !== 'string'
      || !['user', 'assistant', 'system', 'tool'].includes(record.role)
      || !Object.prototype.hasOwnProperty.call(record, 'content')
    ) {
      return false;
    }
    digestRuntimeTranscript([record as unknown as RuntimeTranscriptMessage]);
    return true;
  } catch {
    return false;
  }
}

export class DeterministicFakeRuntime implements RuntimeAdapter {
  private readonly sessions = new Map<string, FakeSession>();
  private readonly runs = new Map<string, FakeRun>();
  private readonly activeRunsBySession = new Map<string, string>();
  private readonly usedCommands = new Map<string, UsedCommand>();
  private nextSessionSequence = 1;
  private nextRunSequence = 1;
  private nextSessionOrder = 1;

  async describe(binding: RuntimeBindingContext): Promise<RuntimeDescriptor> {
    void binding;
    return clone({
      kind: 'fake',
      runtimeVersion: '1',
      adapterVersion: '1',
      capabilities: fakeCapabilities,
    });
  }

  async health(binding: RuntimeBindingContext): Promise<RuntimeHealth> {
    void binding;
    return {
      status: 'ready',
      checkedAt: new Date(0).toISOString(),
      details: { deterministic: true },
    };
  }

  async listModels(binding: RuntimeBindingContext): Promise<RuntimeModelEntry[]> {
    void binding;
    return clone([fakeModel]);
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSessionRef> {
    this.validateModel(input.model);
    this.ensureCommandAvailable(input.binding, input.commandId);
    this.ensureCanvasSessionAvailable(input.binding, input.canvasSessionId);
    return this.createSessionAfterValidation(input, [], undefined, 'createSession');
  }

  async loadSession(input: LoadRuntimeSessionInput): Promise<RuntimeSessionRef> {
    const session = this.requireSession(input.binding, input.externalSessionRef);
    this.assertCanvasSession(session, input.canvasSessionId);
    return this.toSessionRef(session);
  }

  async listSessions(input: {
    binding: RuntimeBindingContext;
    cursor?: string;
  }): Promise<{ sessions: RuntimeSessionRef[]; nextCursor?: string }> {
    const bindingKey = this.bindingKey(input.binding);
    const sessions = [...this.sessions.values()]
      .filter((session) => session.bindingKey === bindingKey)
      .sort((left, right) => left.createdOrder - right.createdOrder);
    let startIndex = 0;
    if (input.cursor !== undefined) {
      const cursorIndex = sessions.findIndex(
        (session) => session.externalSessionRef === input.cursor,
      );
      if (cursorIndex < 0) {
        throw notApplied('protocol_error', 'Unknown session cursor');
      }
      startIndex = cursorIndex + 1;
    }
    return {
      sessions: sessions.slice(startIndex).map((session) => this.toSessionRef(session)),
    };
  }

  async forkSession(input: ForkRuntimeSessionInput): Promise<RuntimeSessionRef> {
    this.validateModel(input.model);
    this.ensureCommandAvailable(input.binding, input.commandId);
    this.ensureCanvasSessionAvailable(input.binding, input.childCanvasSessionId);
    const parent = this.requireSession(input.binding, input.parentExternalSessionRef);
    this.assertCanvasSession(parent, input.parentCanvasSessionId);
    if (parent.historyDigest !== input.expectedParentHistoryDigest) {
      throw notApplied('history_diverged', 'Parent history digest changed');
    }
    if (
      !Array.isArray(input.transcriptPrefix)
      || input.transcriptPrefix.length === 0
      || !input.transcriptPrefix.every(isRuntimeTranscriptMessage)
    ) {
      throw notApplied('transcript_conflict', 'Fork prefix is not a valid transcript');
    }

    let actualPrefixDigest: string;
    try {
      actualPrefixDigest = digestRuntimeTranscript(input.transcriptPrefix);
    } catch {
      throw notApplied('transcript_conflict', 'Fork prefix is not canonical JSON');
    }
    if (actualPrefixDigest !== input.transcriptPrefixDigest) {
      throw notApplied('transcript_conflict', 'Fork prefix digest mismatch');
    }
    if (input.transcriptPrefix.at(-1)?.canvasMessageId !== input.atCanvasMessageId) {
      throw notApplied('transcript_conflict', 'Fork message is not the prefix tail');
    }
    if (input.transcriptPrefix.length > parent.transcript.length) {
      throw notApplied('history_diverged', 'Fork prefix is longer than parent transcript');
    }
    const parentPrefix = parent.transcript.slice(0, input.transcriptPrefix.length);
    if (digestRuntimeTranscript(parentPrefix) !== actualPrefixDigest) {
      throw notApplied('history_diverged', 'Fork prefix does not match parent transcript');
    }

    const lineage: NonNullable<RuntimeSessionRef['lineage']> = {
      parentCanvasSessionId: input.parentCanvasSessionId,
      atCanvasMessageId: input.atCanvasMessageId,
      sourceRevisionId: input.sourceRevisionId,
      transcriptPrefixDigest: actualPrefixDigest,
    };
    return this.createSessionAfterValidation({
      commandId: input.commandId,
      binding: input.binding,
      canvasSessionId: input.childCanvasSessionId,
      model: input.model,
      toolPolicy: input.toolPolicy,
      context: input.context,
    }, input.transcriptPrefix, lineage, 'forkSession');
  }

  async startRun(input: StartRuntimeRunInput): Promise<RuntimeRunRef> {
    this.validateModel(input.model);
    const session = this.requireSession(input.binding, input.externalSessionRef);
    this.assertCanvasSession(session, input.canvasSessionId);

    const runKey = this.runKey(input.binding, input.canvasRunId);
    if (this.runs.has(runKey)) {
      throw notApplied('session_busy', 'Canvas Run already exists for this Binding');
    }
    const sessionKey = this.sessionKey(session);
    if (this.activeRunsBySession.has(sessionKey)) {
      throw notApplied('session_busy', 'Runtime Session already has an active Run');
    }
    this.ensureCommandAvailable(input.binding, input.commandId);
    if (session.historyDigest !== input.expectedHistoryDigest) {
      throw notApplied('history_diverged', 'Runtime Session history digest changed');
    }
    if (!isRuntimeTranscriptMessage(input.prompt)) {
      throw notApplied('transcript_conflict', 'Run prompt is not a valid transcript message');
    }

    const externalRunRef = `fake-run-${this.nextRunSequence}`;
    const acceptedAt = new Date(0).toISOString();
    const storedInput = cloneRuntimeInput(input);
    const prompt = storedInput.prompt;
    const nextTranscript = [...session.transcript, prompt];
    const nextDigest = digestRuntimeTranscript(nextTranscript);
    const events = this.createRunEvents(storedInput, externalRunRef, acceptedAt);

    this.nextRunSequence += 1;
    this.markCommand(input.binding, input.commandId, 'startRun');
    session.transcript = nextTranscript;
    session.historyDigest = nextDigest;
    this.runs.set(runKey, {
      bindingKey: this.bindingKey(input.binding),
      canvasRunId: input.canvasRunId,
      externalRunRef,
      canvasSessionId: input.canvasSessionId,
      externalSessionRef: input.externalSessionRef,
      sessionKey,
      acceptedAt,
      ledger: [],
      plannedEvents: events,
      productionCursor: 0,
      closed: false,
      cancelRequested: false,
      messageMaterialized: false,
      input: storedInput,
    });
    this.activeRunsBySession.set(sessionKey, runKey);
    return { externalRunRef, acceptedAt };
  }

  streamRunEvents(input: {
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
    afterExternalEventRef?: string;
  }): AsyncIterable<RuntimeEvent> {
    const storedInput = cloneRuntimeInput(input);
    return this.iterateRunEvents(storedInput);
  }

  private async *iterateRunEvents(input: {
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
    afterExternalEventRef?: string;
  }): AsyncIterable<RuntimeEvent> {
    const run = this.requireRun(input.binding, input.canvasRunId, input.externalRunRef);
    let nextIndex = 0;
    if (input.afterExternalEventRef !== undefined) {
      const cursorIndex = run.ledger.findIndex(
        (event) => event.externalEventRef === input.afterExternalEventRef,
      );
      if (cursorIndex < 0) {
        throw notApplied('protocol_error', 'Unknown replay cursor');
      }
      nextIndex = cursorIndex + 1;
    }

    while (true) {
      this.assertRunOpen(run);
      if (nextIndex < run.ledger.length) {
        const event = clone(run.ledger[nextIndex]!);
        nextIndex += 1;
        yield event;
        continue;
      }
      if (run.productionCursor >= run.plannedEvents.length) return;

      const event = clone(run.plannedEvents[run.productionCursor]!);
      const ledgerEvent = clone(event);
      this.applyEvent(run, event);
      run.ledger.push(ledgerEvent);
      run.productionCursor += 1;
    }
  }

  async cancelRun(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
  }): Promise<RuntimeCancelAck> {
    const run = this.requireRun(input.binding, input.canvasRunId, input.externalRunRef);
    const acknowledgedAt = new Date(0).toISOString();
    if (run.terminal !== undefined) {
      return {
        outcome: 'already-terminal',
        externalRunRef: run.externalRunRef,
        observedTerminal: run.terminal,
        acknowledgedAt,
      };
    }
    if (run.cancelRequested) {
      return {
        outcome: 'accepted',
        externalRunRef: run.externalRunRef,
        acknowledgedAt,
      };
    }

    run.cancelRequested = true;
    const producedEvents = run.plannedEvents.slice(0, run.productionCursor);
    const retainedEvents = run.plannedEvents
      .slice(run.productionCursor)
      .filter((event) => event.type === 'run.accepted');
    run.plannedEvents = [...producedEvents, ...retainedEvents, {
      eventId: `${run.externalRunRef}:event:7`,
      externalSequence: 7,
      externalEventRef: `${run.externalRunRef}:event:7`,
      canvasSessionId: run.canvasSessionId,
      canvasRunId: run.canvasRunId,
      type: 'run.cancelled',
      reason: 'user',
      occurredAt: new Date(0).toISOString(),
    }];
    return {
      outcome: 'accepted',
      externalRunRef: run.externalRunRef,
      acknowledgedAt,
    };
  }

  async respondToApproval(input: RuntimeApprovalDecision): Promise<void> {
    void input;
    throw new RuntimeCapabilityError('toolApproval');
  }

  async setSessionModel(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasSessionId: string;
    externalSessionRef: string;
    model: RuntimeModelSelection;
    expectedIdle: true;
  }): Promise<void> {
    void input;
    throw new RuntimeCapabilityError('sessionModelSwitch');
  }

  async setSessionToolPolicy(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasSessionId: string;
    externalSessionRef: string;
    toolPolicy: RuntimeToolPolicy;
    expectedIdle: true;
  }): Promise<void> {
    const containsMcpKey = [
      ...input.toolPolicy.allowedToolKeys,
      ...input.toolPolicy.deniedToolKeys,
      ...input.toolPolicy.approvalRequiredToolKeys,
    ].some((toolKey) => toolKey.startsWith('mcp:'));
    if (containsMcpKey) throw new RuntimeCapabilityError('perSessionMcpPolicy');
    throw new RuntimeCapabilityError('sessionToolPolicy');
  }

  async exportSnapshot(input: LoadRuntimeSessionInput): Promise<RuntimeSnapshot> {
    const session = this.requireSession(input.binding, input.externalSessionRef);
    this.assertCanvasSession(session, input.canvasSessionId);
    return {
      format: 'fake-json',
      version: '1',
      payload: clone(session.transcript),
    };
  }

  async restoreSnapshot(
    input: CreateRuntimeSessionInput & { snapshot: RuntimeSnapshot },
  ): Promise<RuntimeSessionRef> {
    this.validateModel(input.model);
    this.ensureCommandAvailable(input.binding, input.commandId);
    this.ensureCanvasSessionAvailable(input.binding, input.canvasSessionId);
    const transcript = this.validateSnapshot(input.snapshot);
    return this.createSessionAfterValidation(
      input,
      transcript,
      undefined,
      'restoreSnapshot',
    );
  }

  async shutdown(input: {
    binding: RuntimeBindingContext;
    reason: 'test' | 'deploy' | 'idle' | 'failure';
  }): Promise<void> {
    const bindingKey = this.bindingKey(input.binding);
    for (const [key, run] of this.runs) {
      if (run.bindingKey === bindingKey) {
        run.closed = true;
        run.plannedEvents = [];
        this.activeRunsBySession.delete(run.sessionKey);
        this.runs.delete(key);
      }
    }
    for (const [key, session] of this.sessions) {
      if (session.bindingKey === bindingKey) this.sessions.delete(key);
    }
    for (const [key, command] of this.usedCommands) {
      if (command.bindingKey === bindingKey) this.usedCommands.delete(key);
    }
  }

  private bindingKey(binding: RuntimeBindingContext): string {
    return JSON.stringify([
      binding.canvasAgentBindingId,
      binding.isolationKey,
    ]);
  }

  private sessionKey(session: FakeSession): string {
    return JSON.stringify([session.bindingKey, session.externalSessionRef]);
  }

  private runKey(binding: RuntimeBindingContext, canvasRunId: string): string {
    return JSON.stringify([this.bindingKey(binding), canvasRunId]);
  }

  private commandKey(binding: RuntimeBindingContext, commandId: string): string {
    return JSON.stringify([this.bindingKey(binding), commandId]);
  }

  private validateModel(model: RuntimeModelSelection): void {
    if (model.providerKey !== fakeModel.providerKey || model.modelKey !== fakeModel.modelKey) {
      throw notApplied(
        'model_not_available',
        `Fake model is not available: ${model.providerKey}/${model.modelKey}`,
      );
    }
  }

  private ensureCommandAvailable(binding: RuntimeBindingContext, commandId: string): void {
    if (this.usedCommands.has(this.commandKey(binding, commandId))) {
      throw notApplied('transcript_conflict', 'commandId was already used');
    }
  }

  private markCommand(
    binding: RuntimeBindingContext,
    commandId: string,
    operation: UsedCommand['operation'],
  ): void {
    const bindingKey = this.bindingKey(binding);
    this.usedCommands.set(this.commandKey(binding, commandId), { bindingKey, operation });
  }

  private ensureCanvasSessionAvailable(
    binding: RuntimeBindingContext,
    canvasSessionId: string,
  ): void {
    const bindingKey = this.bindingKey(binding);
    const exists = [...this.sessions.values()].some(
      (session) => session.bindingKey === bindingKey
        && session.canvasSessionId === canvasSessionId,
    );
    if (exists) {
      throw notApplied('transcript_conflict', 'Canvas Session already exists for this Binding');
    }
  }

  private createSessionAfterValidation(
    input: CreateRuntimeSessionInput,
    transcript: readonly RuntimeTranscriptMessage[],
    lineage: RuntimeSessionRef['lineage'],
    operation: UsedCommand['operation'],
  ): RuntimeSessionRef {
    const externalSessionRef = `fake-session-${this.nextSessionSequence}`;
    const storedTranscript = cloneRuntimeInput([...transcript]);
    const storedModel = cloneRuntimeInput(input.model);
    const storedToolPolicy = cloneRuntimeInput(input.toolPolicy);
    const storedContext = cloneRuntimeInput(input.context);
    const storedLineage = lineage === undefined
      ? undefined
      : cloneRuntimeInput(lineage);
    const session: FakeSession = {
      bindingKey: this.bindingKey(input.binding),
      canvasSessionId: input.canvasSessionId,
      externalSessionRef,
      transcript: storedTranscript,
      historyDigest: digestRuntimeTranscript(storedTranscript),
      model: storedModel,
      toolPolicy: storedToolPolicy,
      context: storedContext,
      lineage: storedLineage,
      createdOrder: this.nextSessionOrder,
    };

    this.nextSessionSequence += 1;
    this.nextSessionOrder += 1;
    this.markCommand(input.binding, input.commandId, operation);
    this.sessions.set(externalSessionRef, session);
    return this.toSessionRef(session);
  }

  private toSessionRef(session: FakeSession): RuntimeSessionRef {
    return clone({
      externalSessionRef: session.externalSessionRef,
      runtimeVersion: '1',
      replayStatus: 'complete' as const,
      historyDigest: session.historyDigest,
      lineage: session.lineage,
      metadata: { canvasSessionId: session.canvasSessionId },
    });
  }

  private requireSession(
    binding: RuntimeBindingContext,
    externalSessionRef: string,
  ): FakeSession {
    const session = this.sessions.get(externalSessionRef);
    if (session === undefined) {
      throw notApplied('session_not_found', 'Runtime Session was not found');
    }
    if (session.bindingKey !== this.bindingKey(binding)) {
      throw notApplied(
        'session_ownership_mismatch',
        'Runtime Session belongs to another Binding',
      );
    }
    return session;
  }

  private assertCanvasSession(session: FakeSession, canvasSessionId: string): void {
    if (session.canvasSessionId !== canvasSessionId) {
      throw notApplied(
        'session_ownership_mismatch',
        'Canvas Session does not match Runtime Session',
      );
    }
  }

  private requireRun(
    binding: RuntimeBindingContext,
    canvasRunId: string,
    externalRunRef?: string,
  ): FakeRun {
    const run = this.runs.get(this.runKey(binding, canvasRunId));
    if (run === undefined) {
      const ownedByAnotherBinding = [...this.runs.values()].some(
        (candidate) => candidate.canvasRunId === canvasRunId,
      );
      if (ownedByAnotherBinding) {
        throw notApplied('session_ownership_mismatch', 'Run belongs to another Binding');
      }
      throw notApplied('run_not_found', 'Run was not found for Binding');
    }
    if (externalRunRef !== undefined && run.externalRunRef !== externalRunRef) {
      throw notApplied('run_not_found', 'External Run reference does not match Canvas Run');
    }
    return run;
  }

  private assertRunOpen(run: FakeRun): void {
    if (run.closed) {
      throw notApplied('runtime_unavailable', 'Runtime binding was shut down');
    }
  }

  private createRunEvents(
    input: StartRuntimeRunInput,
    externalRunRef: string,
    occurredAt: string,
  ): RuntimeEvent[] {
    const base = {
      canvasSessionId: input.canvasSessionId,
      canvasRunId: input.canvasRunId,
      occurredAt,
    };
    const identity = (sequence: number) => ({
      eventId: `${externalRunRef}:event:${sequence}`,
      externalSequence: sequence,
      externalEventRef: `${externalRunRef}:event:${sequence}`,
    });
    return [
      {
        ...base,
        ...identity(1),
        type: 'run.accepted',
        externalRunRef,
      },
      {
        ...base,
        ...identity(2),
        type: 'run.started',
      },
      {
        ...base,
        ...identity(3),
        type: 'model.output.delta',
        text: 'fake ',
      },
      {
        ...base,
        ...identity(4),
        type: 'model.output.delta',
        text: 'fake ',
      },
      {
        ...base,
        ...identity(5),
        type: 'message.completed',
        role: 'assistant',
        content: 'fake fake ',
        externalMessageRef: `${externalRunRef}:message:1`,
      },
      {
        ...base,
        ...identity(6),
        type: 'run.completed',
      },
    ];
  }

  private applyEvent(
    run: FakeRun,
    event: RuntimeEvent,
  ): void {
    if (event.type === 'message.completed' && !run.messageMaterialized) {
      const session = this.sessions.get(run.externalSessionRef);
      if (session === undefined || session.bindingKey !== run.bindingKey) {
        throw notApplied('session_not_found', 'Run Session was not found');
      }
      const assistant: RuntimeTranscriptMessage = {
        canvasMessageId: `${run.canvasRunId}:assistant`,
        role: event.role,
        content: clone(event.content),
      };
      session.transcript = [...session.transcript, assistant];
      session.historyDigest = digestRuntimeTranscript(session.transcript);
      run.messageMaterialized = true;
    }
    if (event.type === 'run.completed') {
      run.terminal = 'succeeded';
      this.activeRunsBySession.delete(run.sessionKey);
    } else if (event.type === 'run.failed') {
      run.terminal = 'failed';
      this.activeRunsBySession.delete(run.sessionKey);
    } else if (event.type === 'run.cancelled') {
      run.terminal = 'cancelled';
      this.activeRunsBySession.delete(run.sessionKey);
    }
  }

  private validateSnapshot(snapshot: RuntimeSnapshot): RuntimeTranscriptMessage[] {
    const payload = snapshot.payload;
    let valid = false;
    try {
      valid = snapshot.format === 'fake-json'
        && snapshot.version === '1'
        && Array.isArray(payload)
        && Array.from({ length: payload.length }, (_, index) => index)
          .every((index) => (
            Object.prototype.hasOwnProperty.call(payload, index)
            && isRuntimeTranscriptMessage(payload[index])
          ));
    } catch {
      valid = false;
    }
    if (!valid || !Array.isArray(payload)) {
      throw notApplied('protocol_error', 'Invalid fake snapshot');
    }
    try {
      return clone(payload);
    } catch {
      throw notApplied('protocol_error', 'Invalid fake snapshot');
    }
  }
}

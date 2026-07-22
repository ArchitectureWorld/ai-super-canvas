import { expect } from 'vitest';

import {
  RuntimeAdapterError,
  RuntimeCapabilityError,
  digestRuntimeTranscript,
  type RuntimeAdapter,
  type RuntimeBindingContext,
  type RuntimeCapabilities,
  type RuntimeContextItem,
  type RuntimeEvent,
  type RuntimeModelSelection,
  type RuntimeSessionRef,
  type RuntimeSnapshot,
  type RuntimeToolPolicy,
  type RuntimeTranscriptMessage,
} from './contract';

export const contractBinding: RuntimeBindingContext = {
  canvasAgentBindingId: '77777777-7777-4777-8777-777777777777',
  isolationKey: 'contract-agent-a',
};

export const contractIsolationBinding: RuntimeBindingContext = {
  canvasAgentBindingId: contractBinding.canvasAgentBindingId,
  isolationKey: 'contract-agent-b',
};
const otherBinding = contractIsolationBinding;

export const contractAgentBinding: RuntimeBindingContext = {
  canvasAgentBindingId: '66666666-6666-4666-8666-666666666666',
  isolationKey: contractBinding.isolationKey,
};
const otherAgentBinding = contractAgentBinding;

const emptyToolPolicy = {
  allowedToolKeys: [] as string[],
  deniedToolKeys: [] as string[],
  approvalRequiredToolKeys: [] as string[],
};

const terminalTypes = new Set<RuntimeEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export const runtimeCapabilityKeys = [
  'persistentSessions',
  'completedTurnPersistence',
  'inFlightResume',
  'concurrentSessions',
  'forkSession',
  'forkAtMessage',
  'eventReplay',
  'streamingText',
  'streamingToolOutput',
  'typedFailures',
  'cancellation',
  'toolApproval',
  'sessionModelSwitch',
  'sessionToolPolicy',
  'perSessionMcpPolicy',
  'clientIdempotency',
  'exactlyOneTerminalEvent',
  'snapshotRestore',
  'runtimeModelCatalog',
] as const satisfies readonly (keyof RuntimeCapabilities)[];

export interface RuntimeSessionObservation {
  transcript: RuntimeTranscriptMessage[];
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: RuntimeContextItem[];
}

export interface RuntimeRunObservation {
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: RuntimeContextItem[];
  toolExecutions: Array<{
    toolCallRef: string;
    toolKey: string;
    status: 'requested' | 'started' | 'completed';
  }>;
}

export interface RuntimeContractFixtures {
  defaultModel: RuntimeModelSelection;
  alternateModel?: RuntimeModelSelection;
  approvalPrompt: unknown;
  deniedToolPrompt: unknown;
  deniedToolKey: string;
  allowedToolPrompt: unknown;
  allowedToolKey: string;
  deniedMcpPrompt: unknown;
  deniedMcpToolKey: string;
  allowedMcpPrompt: unknown;
  allowedMcpToolKey: string;
  observeSession(input: {
    adapter: RuntimeAdapter;
    binding: RuntimeBindingContext;
    canvasSessionId: string;
    externalSessionRef: string;
  }): Promise<RuntimeSessionObservation>;
  observeRun(input: {
    adapter: RuntimeAdapter;
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
  }): Promise<RuntimeRunObservation>;
  mutateSnapshot(snapshot: RuntimeSnapshot): void;
  invalidSnapshots(snapshot: RuntimeSnapshot): RuntimeSnapshot[];
  readLogs(): Promise<unknown[]>;
}

export interface RuntimeContractHarness {
  adapter: RuntimeAdapter;
  fixtures: RuntimeContractFixtures;
  restartRuntime(): Promise<RuntimeAdapter>;
  crashRuntime(): Promise<RuntimeAdapter>;
  dispose(): Promise<void>;
}

export type RuntimeContractHarnessFactory = () => Promise<RuntimeContractHarness>;

const fixturesByAdapter = new WeakMap<RuntimeAdapter, RuntimeContractFixtures>();

function registerHarness(harness: RuntimeContractHarness): void {
  fixturesByAdapter.set(harness.adapter, harness.fixtures);
}

async function disposeHarness(harness: RuntimeContractHarness): Promise<void> {
  await harness.dispose();
  await harness.dispose();
}

function verifyCapabilityShape(capabilities: RuntimeCapabilities): void {
  const actualKeys = Object.keys(capabilities).sort();
  const expectedKeys = [...runtimeCapabilityKeys].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('Runtime capabilities must contain exactly the canonical 19 keys');
  }
  for (const capability of runtimeCapabilityKeys) {
    if (!['native', 'adapter', 'unsupported'].includes(capabilities[capability])) {
      throw new Error(`Runtime capability has invalid support: ${capability}`);
    }
  }
}

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function collectThrough(
  source: AsyncIterable<RuntimeEvent>,
  predicate: (event: RuntimeEvent) => boolean,
): Promise<RuntimeEvent[]> {
  const iterator = source[Symbol.asyncIterator]();
  const events: RuntimeEvent[] = [];
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (predicate(next.value)) break;
    }
  } finally {
    await iterator.return?.();
  }
  return events;
}

async function collectIteratorThrough(
  iterator: AsyncIterator<RuntimeEvent>,
  predicate: (event: RuntimeEvent) => boolean,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
    if (predicate(next.value)) break;
  }
  return events;
}

async function drainIterator(iterator: AsyncIterator<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}

async function expectRuntimeFailure(
  operation: Promise<unknown>,
  expectedCode: RuntimeAdapterError['code'],
  typedFailures: boolean,
): Promise<unknown> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  if (typedFailures) {
    expect(caught).toBeInstanceOf(RuntimeAdapterError);
    expect(caught).toMatchObject({ code: expectedCode });
  }
  return caught;
}

function structuredError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    ...Object.fromEntries(Object.entries(error)),
  };
}

async function expectCapabilityFailure(
  operation: Promise<unknown>,
  capability: keyof RuntimeCapabilities,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeCapabilityError);
  expect(caught).toMatchObject({
    capability,
    code: 'protocol_error',
    retryable: false,
    operationEffect: 'not-applied',
  });
}

async function firstModel(
  adapter: RuntimeAdapter,
  binding: RuntimeBindingContext = contractBinding,
  fallback = fixturesByAdapter.get(adapter)?.defaultModel,
): Promise<RuntimeModelSelection> {
  const descriptor = await adapter.describe(binding);
  if (descriptor.capabilities.runtimeModelCatalog === 'unsupported') {
    if (fallback === undefined) {
      throw new Error('Runtime contract harness requires a default model fixture');
    }
    return structuredClone(fallback);
  }
  const modelEntry = (await adapter.listModels(binding))[0];
  expect(modelEntry).toBeDefined();
  return {
    providerKey: modelEntry!.providerKey,
    modelKey: modelEntry!.modelKey,
  };
}

async function createSession(
  adapter: RuntimeAdapter,
  suffix: string,
  binding: RuntimeBindingContext = contractBinding,
): Promise<RuntimeSessionRef> {
  const selected = await firstModel(adapter, binding);
  return adapter.createSession({
    commandId: `command-create-${suffix}`,
    binding,
    canvasSessionId: `canvas-session-${suffix}`,
    model: selected,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
}

async function startRun(
  adapter: RuntimeAdapter,
  session: RuntimeSessionRef,
  suffix: string,
  content: unknown = `prompt-${suffix}`,
  binding: RuntimeBindingContext = contractBinding,
) {
  const selected = await firstModel(adapter, binding);
  return adapter.startRun({
    commandId: `command-run-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    binding,
    canvasRunId: `canvas-run-${suffix}`,
    canvasSessionId: session.metadata.canvasSessionId as string,
    externalSessionRef: session.externalSessionRef,
    expectedHistoryDigest: session.historyDigest!,
    prompt: {
      canvasMessageId: `canvas-message-${suffix}`,
      role: 'user',
      content,
    },
    model: selected,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
}

function streamInput(
  session: RuntimeSessionRef,
  run: { externalRunRef?: string },
  suffix: string,
  binding: RuntimeBindingContext = contractBinding,
) {
  return {
    binding,
    canvasRunId: `canvas-run-${suffix}`,
    externalRunRef: run.externalRunRef,
    canvasSessionId: session.metadata.canvasSessionId as string,
  };
}

function terminalEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  return events.filter((event) => terminalTypes.has(event.type));
}

export async function verifyRuntimeContract(
  runtime: RuntimeAdapter,
  fixtures?: RuntimeContractFixtures,
): Promise<void> {
  if (fixtures !== undefined) fixturesByAdapter.set(runtime, fixtures);
  const descriptor = await runtime.describe(contractBinding);
  verifyCapabilityShape(descriptor.capabilities);
  const supports = (capability: keyof RuntimeCapabilities): boolean =>
    descriptor.capabilities[capability] !== 'unsupported';
  expect(descriptor.kind).toBeTruthy();
  expect(descriptor.runtimeVersion).toBeTruthy();
  expect(descriptor.adapterVersion).toBeTruthy();

  const health = await runtime.health(contractBinding);
  expect(['ready', 'degraded', 'unavailable']).toContain(health.status);
  expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);

  const model = await firstModel(runtime, contractBinding, fixtures?.defaultModel);
  const parent = await runtime.createSession({
    commandId: 'command-contract-parent',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-contract-parent',
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
  expect(parent.historyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

  const loadedBeforeRun = await runtime.loadSession({
    commandId: 'command-load-contract-parent',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-contract-parent',
    externalSessionRef: parent.externalSessionRef,
  });
  expect(loadedBeforeRun).toEqual(parent);
  const listed = await runtime.listSessions({ binding: contractBinding });
  expect(listed.sessions.map((session) => session.externalSessionRef)).toContain(
    parent.externalSessionRef,
  );
  expect((await runtime.listSessions({ binding: otherBinding })).sessions).toEqual([]);
  expect((await runtime.listSessions({ binding: otherAgentBinding })).sessions).toEqual([]);

  await expectRuntimeFailure(
    runtime.loadSession({
      commandId: 'command-load-contract-wrong-binding',
      binding: otherBinding,
      canvasSessionId: 'canvas-session-contract-parent',
      externalSessionRef: parent.externalSessionRef,
    }),
    'session_ownership_mismatch',
    supports('typedFailures'),
  );
  await expectRuntimeFailure(
    runtime.loadSession({
      commandId: 'command-load-contract-wrong-agent',
      binding: otherAgentBinding,
      canvasSessionId: 'canvas-session-contract-parent',
      externalSessionRef: parent.externalSessionRef,
    }),
    'session_ownership_mismatch',
    supports('typedFailures'),
  );
  await expectRuntimeFailure(
    runtime.loadSession({
      commandId: 'command-load-contract-wrong-canvas',
      binding: contractBinding,
      canvasSessionId: 'canvas-session-contract-other',
      externalSessionRef: parent.externalSessionRef,
    }),
    'session_ownership_mismatch',
    supports('typedFailures'),
  );

  const parentRun = await runtime.startRun({
    commandId: 'command-contract-parent-run',
    idempotencyKey: 'idempotency-contract-parent-run',
    binding: contractBinding,
    canvasRunId: 'canvas-run-contract-parent',
    canvasSessionId: 'canvas-session-contract-parent',
    externalSessionRef: parent.externalSessionRef,
    expectedHistoryDigest: parent.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-contract-fork-point',
      role: 'user',
      content: 'fork here',
    },
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
  await expectRuntimeFailure(collectAsync(runtime.streamRunEvents({
    binding: otherBinding,
    canvasRunId: 'canvas-run-contract-parent',
    externalRunRef: parentRun.externalRunRef,
  })), 'session_ownership_mismatch', supports('typedFailures'));
  const wrongBindingCancel = runtime.cancelRun({
    commandId: 'command-cancel-contract-wrong-binding',
    binding: otherBinding,
    canvasRunId: 'canvas-run-contract-parent',
    externalRunRef: parentRun.externalRunRef,
  });
  if (supports('cancellation')) {
    await expectRuntimeFailure(
      wrongBindingCancel,
      'session_ownership_mismatch',
      supports('typedFailures'),
    );
  } else {
    await expectCapabilityFailure(wrongBindingCancel, 'cancellation');
  }
  const parentEvents = await collectAsync(runtime.streamRunEvents({
    binding: contractBinding,
    canvasRunId: 'canvas-run-contract-parent',
    externalRunRef: parentRun.externalRunRef,
  }));
  expect(parentEvents[0]?.type).toBe('run.accepted');
  if (supports('exactlyOneTerminalEvent')) {
    expect(terminalEvents(parentEvents)).toHaveLength(1);
  }

  const loaded = await runtime.loadSession({
    commandId: 'command-load-contract-parent-after-run',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-contract-parent',
    externalSessionRef: parent.externalSessionRef,
  });
  expect(loaded.historyDigest).not.toBe(parent.historyDigest);

  let target = loaded;
  if (supports('forkSession') && supports('forkAtMessage')) {
    const prefix: RuntimeTranscriptMessage[] = [{
      canvasMessageId: 'canvas-message-contract-fork-point',
      role: 'user',
      content: 'fork here',
    }];
    const prefixDigest = digestRuntimeTranscript(prefix);
    await expectRuntimeFailure(
      runtime.forkSession({
        commandId: 'command-fork-wrong-parent-canvas',
        binding: contractBinding,
        parentCanvasSessionId: 'canvas-session-contract-wrong',
        parentExternalSessionRef: parent.externalSessionRef,
        childCanvasSessionId: 'canvas-session-contract-child',
        atCanvasMessageId: prefix[0]!.canvasMessageId,
        sourceRevisionId: 'revision-contract',
        expectedParentHistoryDigest: loaded.historyDigest!,
        transcriptPrefixDigest: prefixDigest,
        transcriptPrefix: prefix,
        model,
        toolPolicy: emptyToolPolicy,
        context: [],
      }),
      'session_ownership_mismatch',
      supports('typedFailures'),
    );
    await expectRuntimeFailure(
      runtime.forkSession({
        commandId: 'command-fork-wrong-history',
        binding: contractBinding,
        parentCanvasSessionId: 'canvas-session-contract-parent',
        parentExternalSessionRef: parent.externalSessionRef,
        childCanvasSessionId: 'canvas-session-contract-child',
        atCanvasMessageId: prefix[0]!.canvasMessageId,
        sourceRevisionId: 'revision-contract',
        expectedParentHistoryDigest: 'sha256:wrong',
        transcriptPrefixDigest: prefixDigest,
        transcriptPrefix: prefix,
        model,
        toolPolicy: emptyToolPolicy,
        context: [],
      }),
      'history_diverged',
      supports('typedFailures'),
    );
    const child = await runtime.forkSession({
      commandId: 'command-fork-contract-child',
      binding: contractBinding,
      parentCanvasSessionId: 'canvas-session-contract-parent',
      parentExternalSessionRef: parent.externalSessionRef,
      childCanvasSessionId: 'canvas-session-contract-child',
      atCanvasMessageId: prefix[0]!.canvasMessageId,
      sourceRevisionId: 'revision-contract',
      expectedParentHistoryDigest: loaded.historyDigest!,
      transcriptPrefixDigest: prefixDigest,
      transcriptPrefix: prefix,
      model,
      toolPolicy: emptyToolPolicy,
      context: [],
    });
    expect(child.lineage).toEqual({
      parentCanvasSessionId: 'canvas-session-contract-parent',
      atCanvasMessageId: prefix[0]!.canvasMessageId,
      sourceRevisionId: 'revision-contract',
      transcriptPrefixDigest: prefixDigest,
    });
    expect(child.historyDigest).toBe(prefixDigest);
    target = child;
  }

  const run = await runtime.startRun({
    commandId: 'command-contract-target-run',
    idempotencyKey: 'idempotency-contract-target-run',
    binding: contractBinding,
    canvasRunId: 'canvas-run-contract-target',
    canvasSessionId: target.metadata.canvasSessionId as string,
    externalSessionRef: target.externalSessionRef,
    expectedHistoryDigest: target.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-contract-target',
      role: 'user',
      content: 'hello runtime',
    },
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
  const events = await collectAsync(runtime.streamRunEvents({
    binding: contractBinding,
    canvasRunId: 'canvas-run-contract-target',
    externalRunRef: run.externalRunRef,
  }));
  expect(events[0]?.type).toBe('run.accepted');
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  if (supports('exactlyOneTerminalEvent')) {
    expect(terminalEvents(events)).toHaveLength(1);
  }

  if (supports('streamingText')) {
    const deltas = events.filter((event) => event.type === 'model.output.delta');
    const completed = events.find((event) => event.type === 'message.completed');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((event) => event.text).join('')).toEqual(completed?.content);
  }
  if (supports('eventReplay')) {
    const cursor = events[1]?.externalEventRef;
    expect(cursor).toBeDefined();
    const replay = await collectAsync(runtime.streamRunEvents({
      binding: contractBinding,
      canvasRunId: 'canvas-run-contract-target',
      externalRunRef: run.externalRunRef,
      afterExternalEventRef: cursor,
    }));
    expect(replay.map((event) => event.eventId)).toEqual(
      events.slice(2).map((event) => event.eventId),
    );
    await expectRuntimeFailure(
      collectAsync(runtime.streamRunEvents({
        binding: contractBinding,
        canvasRunId: 'canvas-run-contract-target',
        externalRunRef: run.externalRunRef,
        afterExternalEventRef: 'unknown-contract-cursor',
      })),
      'protocol_error',
      supports('typedFailures'),
    );
  }

  const shutdownSession = await runtime.createSession({
    commandId: 'command-create-active-shutdown',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-active-shutdown',
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
  const shutdownRun = await runtime.startRun({
    commandId: 'command-run-active-shutdown',
    idempotencyKey: 'idempotency-active-shutdown',
    binding: contractBinding,
    canvasRunId: 'canvas-run-active-shutdown',
    canvasSessionId: 'canvas-session-active-shutdown',
    externalSessionRef: shutdownSession.externalSessionRef,
    expectedHistoryDigest: shutdownSession.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-active-shutdown',
      role: 'user',
      content: 'interrupt this active run during shutdown',
    },
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
  const beforeShutdown = await collectThrough(runtime.streamRunEvents({
    binding: contractBinding,
    canvasRunId: 'canvas-run-active-shutdown',
    externalRunRef: shutdownRun.externalRunRef,
  }), (event) => event.type === 'run.started');
  const shutdownCursor = beforeShutdown.at(-1)?.externalEventRef;
  expect(shutdownCursor).toBeDefined();
  await runtime.shutdown({ binding: contractBinding, reason: 'test' });
  let shutdownEvents: RuntimeEvent[] | undefined;
  let shutdownFailure: unknown;
  try {
    shutdownEvents = await collectAsync(runtime.streamRunEvents({
      binding: contractBinding,
      canvasRunId: 'canvas-run-active-shutdown',
      externalRunRef: shutdownRun.externalRunRef,
      ...(supports('eventReplay') ? { afterExternalEventRef: shutdownCursor } : {}),
    }));
  } catch (error) {
    shutdownFailure = error;
  }
  if (shutdownFailure !== undefined) {
    if (supports('typedFailures')) {
      expect(shutdownFailure).toBeInstanceOf(RuntimeAdapterError);
      expect([
        'runtime_unavailable',
        'run_not_found',
        'session_not_found',
        'cancelled',
        'replay_incomplete',
      ]).toContain((shutdownFailure as RuntimeAdapterError).code);
    }
  } else {
    expect(shutdownEvents).toBeDefined();
    expect(shutdownEvents!.some((event) => (
      event.type === 'run.cancelled' || event.type === 'run.failed'
    ))).toBe(true);
    expect(shutdownEvents!.some((event) => event.type === 'run.completed')).toBe(false);
  }
  await expectRuntimeFailure(
    runtime.loadSession({
      commandId: 'command-load-after-shutdown',
      binding: contractBinding,
      canvasSessionId: 'canvas-session-contract-parent',
      externalSessionRef: parent.externalSessionRef,
    }),
    'session_not_found',
    supports('typedFailures'),
  );
  await runtime.shutdown({ binding: contractBinding, reason: 'test' });
}

type CapabilityTest = (harness: RuntimeContractHarness) => Promise<void>;

async function expectAdapterStopped(adapter: RuntimeAdapter): Promise<void> {
  let stopped = false;
  try {
    stopped = (await adapter.health(contractBinding)).status === 'unavailable';
  } catch (error) {
    stopped = error instanceof RuntimeAdapterError
      ? error.code === 'runtime_unavailable'
      : true;
  }
  expect(stopped, 'the pre-restart Adapter instance must be stopped').toBe(true);
}

async function verifyPersistentSessions(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'persistent');
  const restarted = await harness.restartRuntime();
  expect(restarted, 'restartRuntime must return a fresh Adapter instance').not.toBe(
    harness.adapter,
  );
  await expectAdapterStopped(harness.adapter);
  fixturesByAdapter.set(restarted, harness.fixtures);
  const loaded = await restarted.loadSession({
    commandId: 'command-load-persistent',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-persistent',
    externalSessionRef: session.externalSessionRef,
  });
  expect(loaded.externalSessionRef).toBe(session.externalSessionRef);
}

async function verifyCompletedTurnPersistence(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'completed-persistence');
  const run = await startRun(harness.adapter, session, 'completed-persistence');
  await collectAsync(harness.adapter.streamRunEvents(streamInput(session, run, 'completed-persistence')));
  const completed = await harness.adapter.loadSession({
    commandId: 'command-load-completed-before-restart',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-completed-persistence',
    externalSessionRef: session.externalSessionRef,
  });
  const restarted = await harness.restartRuntime();
  expect(restarted, 'restartRuntime must return a fresh Adapter instance').not.toBe(
    harness.adapter,
  );
  await expectAdapterStopped(harness.adapter);
  fixturesByAdapter.set(restarted, harness.fixtures);
  const loaded = await restarted.loadSession({
    commandId: 'command-load-completed-after-restart',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-completed-persistence',
    externalSessionRef: session.externalSessionRef,
  });
  expect(loaded.historyDigest).toBe(completed.historyDigest);
  expect(loaded.historyDigest).not.toBe(session.historyDigest);
}

async function verifyInFlightResume(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'inflight');
  const run = await startRun(harness.adapter, session, 'inflight');
  const emitted = await collectThrough(
    harness.adapter.streamRunEvents(streamInput(session, run, 'inflight')),
    (event) => event.type === 'model.output.delta',
  );
  const cursor = emitted.at(-1)?.externalEventRef;
  expect(cursor).toBeDefined();
  const restarted = await harness.crashRuntime();
  expect(restarted, 'crashRuntime must return a fresh Adapter instance').not.toBe(
    harness.adapter,
  );
  await expectAdapterStopped(harness.adapter);
  fixturesByAdapter.set(restarted, harness.fixtures);
  const resumed = await collectAsync(restarted.streamRunEvents({
    ...streamInput(session, run, 'inflight'),
    afterExternalEventRef: cursor,
  }));
  const combined = [...emitted, ...resumed];
  expect(combined[0]?.type).toBe('run.accepted');
  expect(new Set(combined.map((event) => event.eventId)).size).toBe(combined.length);
  expect(new Set(combined.map((event) => event.externalEventRef)).size).toBe(combined.length);
  const externalSequences = combined.map((event) => event.externalSequence);
  expect(externalSequences.every((sequence) => typeof sequence === 'number')).toBe(true);
  for (let index = 1; index < externalSequences.length; index += 1) {
    expect(externalSequences[index]).toBe(externalSequences[index - 1]! + 1);
  }
  const capabilities = (await restarted.describe(contractBinding)).capabilities;
  if (capabilities.exactlyOneTerminalEvent !== 'unsupported') {
    expect(terminalEvents(combined)).toHaveLength(1);
  } else {
    expect(terminalEvents(combined).length).toBeGreaterThan(0);
  }
  if (capabilities.eventReplay !== 'unsupported') {
    const fullReplay = await collectAsync(restarted.streamRunEvents(
      streamInput(session, run, 'inflight'),
    ));
    expect(fullReplay.map((event) => event.eventId)).toEqual(
      combined.map((event) => event.eventId),
    );
    expect(fullReplay.map((event) => event.externalSequence)).toEqual(externalSequences);
  }
}

async function verifyConcurrentSessions(harness: RuntimeContractHarness): Promise<void> {
  const sameBindingModel = await firstModel(harness.adapter, contractBinding);
  const sameBindingAlphaContext: RuntimeContextItem[] = [{
    canvasContextRefId: 'context-concurrent-same-binding-alpha',
    scope: 'session',
    visibility: 'private',
    content: { secret: 'CONTRACT_SAME_BINDING_SECRET_ALPHA' },
    provenance: { owner: 'same-binding-alpha' },
  }];
  const sameBindingBetaContext: RuntimeContextItem[] = [{
    canvasContextRefId: 'context-concurrent-same-binding-beta',
    scope: 'session',
    visibility: 'private',
    content: { secret: 'CONTRACT_SAME_BINDING_SECRET_BETA' },
    provenance: { owner: 'same-binding-beta' },
  }];
  const sameBindingAlphaPolicy: RuntimeToolPolicy = {
    allowedToolKeys: ['contract.same-binding.alpha'],
    deniedToolKeys: ['contract.same-binding.beta'],
    approvalRequiredToolKeys: [],
  };
  const sameBindingBetaPolicy: RuntimeToolPolicy = {
    allowedToolKeys: ['contract.same-binding.beta'],
    deniedToolKeys: ['contract.same-binding.alpha'],
    approvalRequiredToolKeys: [],
  };
  const sameBindingAlpha = await harness.adapter.createSession({
    commandId: 'command-create-concurrent-same-binding-alpha',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-concurrent-same-binding-alpha',
    model: sameBindingModel,
    toolPolicy: sameBindingAlphaPolicy,
    context: sameBindingAlphaContext,
  });
  const sameBindingBeta = await harness.adapter.createSession({
    commandId: 'command-create-concurrent-same-binding-beta',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-concurrent-same-binding-beta',
    model: sameBindingModel,
    toolPolicy: sameBindingBetaPolicy,
    context: sameBindingBetaContext,
  });
  const sameBindingAlphaRun = await harness.adapter.startRun({
    commandId: 'command-run-concurrent-same-binding-alpha',
    idempotencyKey: 'idempotency-concurrent-same-binding-alpha',
    binding: contractBinding,
    canvasRunId: 'canvas-run-concurrent-same-binding-alpha',
    canvasSessionId: 'canvas-session-concurrent-same-binding-alpha',
    externalSessionRef: sameBindingAlpha.externalSessionRef,
    expectedHistoryDigest: sameBindingAlpha.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-concurrent-same-binding-alpha',
      role: 'user',
      content: 'prompt-owned-by-same-binding-alpha',
    },
    model: sameBindingModel,
    toolPolicy: sameBindingAlphaPolicy,
    context: sameBindingAlphaContext,
  });
  const sameBindingBetaRun = await harness.adapter.startRun({
    commandId: 'command-run-concurrent-same-binding-beta',
    idempotencyKey: 'idempotency-concurrent-same-binding-beta',
    binding: contractBinding,
    canvasRunId: 'canvas-run-concurrent-same-binding-beta',
    canvasSessionId: 'canvas-session-concurrent-same-binding-beta',
    externalSessionRef: sameBindingBeta.externalSessionRef,
    expectedHistoryDigest: sameBindingBeta.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-concurrent-same-binding-beta',
      role: 'user',
      content: 'prompt-owned-by-same-binding-beta',
    },
    model: sameBindingModel,
    toolPolicy: sameBindingBetaPolicy,
    context: sameBindingBetaContext,
  });
  const sameBindingAlphaEvents = await collectAsync(harness.adapter.streamRunEvents({
    binding: contractBinding,
    canvasRunId: 'canvas-run-concurrent-same-binding-alpha',
    externalRunRef: sameBindingAlphaRun.externalRunRef,
  }));
  const sameBindingBetaEvents = await collectAsync(harness.adapter.streamRunEvents({
    binding: contractBinding,
    canvasRunId: 'canvas-run-concurrent-same-binding-beta',
    externalRunRef: sameBindingBetaRun.externalRunRef,
  }));
  const sameBindingAlphaObservation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-concurrent-same-binding-alpha',
    externalSessionRef: sameBindingAlpha.externalSessionRef,
  });
  const sameBindingBetaObservation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-concurrent-same-binding-beta',
    externalSessionRef: sameBindingBeta.externalSessionRef,
  });
  expect(sameBindingAlphaObservation.context).toEqual(sameBindingAlphaContext);
  expect(sameBindingBetaObservation.context).toEqual(sameBindingBetaContext);
  expect(sameBindingAlphaObservation.toolPolicy).toEqual(sameBindingAlphaPolicy);
  expect(sameBindingBetaObservation.toolPolicy).toEqual(sameBindingBetaPolicy);
  expect(JSON.stringify(sameBindingAlphaObservation.transcript)).toContain(
    'prompt-owned-by-same-binding-alpha',
  );
  expect(JSON.stringify(sameBindingAlphaObservation.transcript)).not.toContain(
    'prompt-owned-by-same-binding-beta',
  );
  expect(JSON.stringify(sameBindingBetaObservation.transcript)).toContain(
    'prompt-owned-by-same-binding-beta',
  );
  expect(JSON.stringify(sameBindingBetaObservation.transcript)).not.toContain(
    'prompt-owned-by-same-binding-alpha',
  );
  const sameBindingAlphaRunObservation = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-concurrent-same-binding-alpha',
    externalRunRef: sameBindingAlphaRun.externalRunRef,
  });
  const sameBindingBetaRunObservation = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-concurrent-same-binding-beta',
    externalRunRef: sameBindingBetaRun.externalRunRef,
  });
  expect(sameBindingAlphaRunObservation.context).toEqual(sameBindingAlphaContext);
  expect(sameBindingBetaRunObservation.context).toEqual(sameBindingBetaContext);
  expect(sameBindingAlphaRunObservation.toolPolicy).toEqual(sameBindingAlphaPolicy);
  expect(sameBindingBetaRunObservation.toolPolicy).toEqual(sameBindingBetaPolicy);
  const sameBindingSurface = JSON.stringify([
    ...sameBindingAlphaEvents,
    ...sameBindingBetaEvents,
  ]);
  expect(sameBindingSurface).not.toContain('CONTRACT_SAME_BINDING_SECRET_ALPHA');
  expect(sameBindingSurface).not.toContain('CONTRACT_SAME_BINDING_SECRET_BETA');

  const firstModelSelection = await firstModel(harness.adapter, contractBinding);
  const otherModelSelection = await firstModel(harness.adapter, otherBinding);
  const firstContext: RuntimeContextItem[] = [{
    canvasContextRefId: 'context-concurrent-a',
    scope: 'session',
    visibility: 'private',
    content: { secret: 'CONTRACT_SECRET_ALPHA' },
    provenance: { owner: 'alpha' },
  }];
  const secondContext: RuntimeContextItem[] = [{
    canvasContextRefId: 'context-concurrent-b',
    scope: 'session',
    visibility: 'private',
    content: { secret: 'CONTRACT_SECRET_BETA' },
    provenance: { owner: 'beta' },
  }];
  const firstPolicy: RuntimeToolPolicy = {
    allowedToolKeys: ['contract.alpha.read'],
    deniedToolKeys: ['contract.beta.read'],
    approvalRequiredToolKeys: [],
  };
  const secondPolicy: RuntimeToolPolicy = {
    allowedToolKeys: ['contract.beta.read'],
    deniedToolKeys: ['contract.alpha.read'],
    approvalRequiredToolKeys: [],
  };
  const first = await harness.adapter.createSession({
    commandId: 'command-create-concurrent-a',
    binding: { ...contractBinding, secretRef: 'secret-ref-alpha' },
    canvasSessionId: 'canvas-session-concurrent-shared',
    model: firstModelSelection,
    toolPolicy: firstPolicy,
    context: firstContext,
  });
  const second = await harness.adapter.createSession({
    commandId: 'command-create-concurrent-b',
    binding: { ...otherBinding, secretRef: 'secret-ref-beta' },
    canvasSessionId: 'canvas-session-concurrent-shared',
    model: otherModelSelection,
    toolPolicy: secondPolicy,
    context: secondContext,
  });
  const firstRun = await harness.adapter.startRun({
    commandId: 'command-run-concurrent-a',
    idempotencyKey: 'idempotency-concurrent-a',
    binding: contractBinding,
    canvasRunId: 'canvas-run-concurrent-shared',
    canvasSessionId: 'canvas-session-concurrent-shared',
    externalSessionRef: first.externalSessionRef,
    expectedHistoryDigest: first.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-concurrent-a',
      role: 'user',
      content: 'prompt-owned-by-alpha',
    },
    model: firstModelSelection,
    toolPolicy: firstPolicy,
    context: firstContext,
  });
  const secondRun = await harness.adapter.startRun({
    commandId: 'command-run-concurrent-b',
    idempotencyKey: 'idempotency-concurrent-b',
    binding: otherBinding,
    canvasRunId: 'canvas-run-concurrent-shared',
    canvasSessionId: 'canvas-session-concurrent-shared',
    externalSessionRef: second.externalSessionRef,
    expectedHistoryDigest: second.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-concurrent-b',
      role: 'user',
      content: 'prompt-owned-by-beta',
    },
    model: otherModelSelection,
    toolPolicy: secondPolicy,
    context: secondContext,
  });
  const firstEvents = await collectAsync(
    harness.adapter.streamRunEvents({
      binding: contractBinding,
      canvasRunId: 'canvas-run-concurrent-shared',
      externalRunRef: firstRun.externalRunRef,
    }),
  );
  const secondEvents = await collectAsync(
    harness.adapter.streamRunEvents({
      binding: otherBinding,
      canvasRunId: 'canvas-run-concurrent-shared',
      externalRunRef: secondRun.externalRunRef,
    }),
  );
  expect(firstEvents.every((event) => event.canvasSessionId === 'canvas-session-concurrent-shared')).toBe(true);
  expect(secondEvents.every((event) => event.canvasSessionId === 'canvas-session-concurrent-shared')).toBe(true);
  const capabilities = (await harness.adapter.describe(contractBinding)).capabilities;
  if (capabilities.exactlyOneTerminalEvent !== 'unsupported') {
    expect(terminalEvents(firstEvents)).toHaveLength(1);
    expect(terminalEvents(secondEvents)).toHaveLength(1);
  }

  const firstObservation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-concurrent-shared',
    externalSessionRef: first.externalSessionRef,
  });
  const secondObservation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: otherBinding,
    canvasSessionId: 'canvas-session-concurrent-shared',
    externalSessionRef: second.externalSessionRef,
  });
  expect(firstObservation.context).toEqual(firstContext);
  expect(secondObservation.context).toEqual(secondContext);
  expect(firstObservation.toolPolicy).toEqual(firstPolicy);
  expect(secondObservation.toolPolicy).toEqual(secondPolicy);
  expect(JSON.stringify(firstObservation.transcript)).toContain('prompt-owned-by-alpha');
  expect(JSON.stringify(firstObservation.transcript)).not.toContain('prompt-owned-by-beta');
  expect(JSON.stringify(secondObservation.transcript)).toContain('prompt-owned-by-beta');
  expect(JSON.stringify(secondObservation.transcript)).not.toContain('prompt-owned-by-alpha');
  const normalizedEvents = JSON.stringify([...firstEvents, ...secondEvents]);
  expect(normalizedEvents).not.toContain('CONTRACT_SECRET_ALPHA');
  expect(normalizedEvents).not.toContain('CONTRACT_SECRET_BETA');
  expect(normalizedEvents).not.toContain('secret-ref-alpha');
  expect(normalizedEvents).not.toContain('secret-ref-beta');
  const securityError = await expectRuntimeFailure(harness.adapter.loadSession({
    commandId: 'command-concurrent-secret-error',
    binding: { ...otherBinding, secretRef: 'CONTRACT_SECRET_ERROR_REF' },
    canvasSessionId: 'canvas-session-concurrent-shared',
    externalSessionRef: first.externalSessionRef,
  }), 'session_ownership_mismatch', capabilities.typedFailures !== 'unsupported');
  const securitySurface = JSON.stringify({
    error: structuredError(securityError),
    logs: await harness.fixtures.readLogs(),
  });
  for (const secret of [
    'CONTRACT_SECRET_ALPHA',
    'CONTRACT_SECRET_BETA',
    'CONTRACT_SECRET_ERROR_REF',
    'secret-ref-alpha',
    'secret-ref-beta',
  ]) {
    expect(securitySurface).not.toContain(secret);
  }
}

async function createForkFixture(adapter: RuntimeAdapter, suffix: string) {
  const parent = await createSession(adapter, `${suffix}-parent`);
  const firstRun = await startRun(adapter, parent, `${suffix}-first`, 'first fork prompt');
  await collectAsync(adapter.streamRunEvents(streamInput(parent, firstRun, `${suffix}-first`)));
  const afterFirst = await adapter.loadSession({
    commandId: `command-load-${suffix}-after-first`,
    binding: contractBinding,
    canvasSessionId: `canvas-session-${suffix}-parent`,
    externalSessionRef: parent.externalSessionRef,
  });
  const prefix: RuntimeTranscriptMessage[] = [{
    canvasMessageId: `canvas-message-${suffix}-first`,
    role: 'user',
    content: 'first fork prompt',
  }];
  return { parent, afterFirst, prefix };
}

async function verifyHeadFork(harness: RuntimeContractHarness): Promise<void> {
  const { parent, afterFirst } = await createForkFixture(harness.adapter, 'head-fork');
  const parentObservation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-head-fork-parent',
    externalSessionRef: parent.externalSessionRef,
  });
  const prefix = parentObservation.transcript;
  expect(prefix.length).toBeGreaterThanOrEqual(2);
  expect(digestRuntimeTranscript(prefix)).toBe(afterFirst.historyDigest);
  const model = await firstModel(harness.adapter);
  const sessionsBeforeInvalidFork = await harness.adapter.listSessions({ binding: contractBinding });
  await expectRuntimeFailure(harness.adapter.forkSession({
    commandId: 'command-head-fork-wrong-history',
    binding: contractBinding,
    parentCanvasSessionId: 'canvas-session-head-fork-parent',
    parentExternalSessionRef: parent.externalSessionRef,
    childCanvasSessionId: 'canvas-session-head-fork-wrong-history',
    atCanvasMessageId: prefix.at(-1)!.canvasMessageId,
    sourceRevisionId: 'revision-head-fork-wrong-history',
    expectedParentHistoryDigest: 'sha256:wrong-head-history',
    transcriptPrefixDigest: digestRuntimeTranscript(prefix),
    transcriptPrefix: prefix,
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  }), 'history_diverged', (await harness.adapter.describe(contractBinding)).capabilities.typedFailures !== 'unsupported');
  expect(await harness.adapter.listSessions({ binding: contractBinding })).toEqual(
    sessionsBeforeInvalidFork,
  );
  expect(await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-head-fork-parent',
    externalSessionRef: parent.externalSessionRef,
  })).toEqual(parentObservation);

  const forkInput = {
    commandId: 'command-head-fork-child',
    binding: contractBinding,
    parentCanvasSessionId: 'canvas-session-head-fork-parent',
    parentExternalSessionRef: parent.externalSessionRef,
    childCanvasSessionId: 'canvas-session-head-fork-child',
    atCanvasMessageId: prefix.at(-1)!.canvasMessageId,
    sourceRevisionId: 'revision-head-fork',
    expectedParentHistoryDigest: afterFirst.historyDigest!,
    transcriptPrefixDigest: digestRuntimeTranscript(prefix),
    transcriptPrefix: prefix,
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  };
  const child = await harness.adapter.forkSession(forkInput);
  expect(child.externalSessionRef).not.toBe(parent.externalSessionRef);
  expect(child.historyDigest).toBe(digestRuntimeTranscript(prefix));
  expect(child.lineage?.parentCanvasSessionId).toBe('canvas-session-head-fork-parent');
  const childObservation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-head-fork-child',
    externalSessionRef: child.externalSessionRef,
  });
  expect(childObservation.transcript).toEqual(prefix);
  const capabilities = (await harness.adapter.describe(contractBinding)).capabilities;
  const sessionsBeforeReplay = await harness.adapter.listSessions({ binding: contractBinding });
  if (capabilities.clientIdempotency !== 'unsupported') {
    expect(await harness.adapter.forkSession(forkInput)).toEqual(child);
    await expectRuntimeFailure(harness.adapter.forkSession({
      ...forkInput,
      sourceRevisionId: 'revision-head-fork-drift',
    }), 'transcript_conflict', capabilities.typedFailures !== 'unsupported');
  } else {
    await expectUnsupportedIdempotencyConflict(
      harness.adapter.forkSession(forkInput),
      capabilities.typedFailures !== 'unsupported',
    );
    await expectUnsupportedIdempotencyConflict(harness.adapter.forkSession({
      ...forkInput,
      sourceRevisionId: 'revision-head-fork-drift',
    }), capabilities.typedFailures !== 'unsupported');
  }
  expect(await harness.adapter.listSessions({ binding: contractBinding })).toEqual(
    sessionsBeforeReplay,
  );
  expect(await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-head-fork-parent',
    externalSessionRef: parent.externalSessionRef,
  })).toEqual(parentObservation);
  expect(await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-head-fork-child',
    externalSessionRef: child.externalSessionRef,
  })).toEqual(childObservation);
  const parentAfterFork = await harness.adapter.loadSession({
    commandId: 'command-load-head-fork-parent-after-child',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-head-fork-parent',
    externalSessionRef: parent.externalSessionRef,
  });
  expect(parentAfterFork.historyDigest).toBe(afterFirst.historyDigest);
  const parentRun = await startRun(
    harness.adapter,
    parentAfterFork,
    'head-fork-parent-after-child',
    'HEAD fork parent remains usable',
  );
  const parentEvents = await collectAsync(harness.adapter.streamRunEvents(
    streamInput(parentAfterFork, parentRun, 'head-fork-parent-after-child'),
  ));
  expect(parentEvents[0]?.type).toBe('run.accepted');
}

async function verifyExactMessageFork(harness: RuntimeContractHarness): Promise<void> {
  const { parent, afterFirst, prefix } = await createForkFixture(harness.adapter, 'exact-fork');
  const secondRun = await startRun(harness.adapter, afterFirst, 'exact-fork-second', 'later prompt');
  await collectAsync(harness.adapter.streamRunEvents(streamInput(parent, secondRun, 'exact-fork-second')));
  const currentParent = await harness.adapter.loadSession({
    commandId: 'command-load-exact-fork-current',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-exact-fork-parent',
    externalSessionRef: parent.externalSessionRef,
  });
  const model = await firstModel(harness.adapter);
  const child = await harness.adapter.forkSession({
    commandId: 'command-exact-fork-child',
    binding: contractBinding,
    parentCanvasSessionId: 'canvas-session-exact-fork-parent',
    parentExternalSessionRef: parent.externalSessionRef,
    childCanvasSessionId: 'canvas-session-exact-fork-child',
    atCanvasMessageId: prefix[0]!.canvasMessageId,
    sourceRevisionId: 'revision-exact-fork',
    expectedParentHistoryDigest: currentParent.historyDigest!,
    transcriptPrefixDigest: digestRuntimeTranscript(prefix),
    transcriptPrefix: prefix,
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
  expect(child.historyDigest).toBe(digestRuntimeTranscript(prefix));
  expect(child.lineage?.atCanvasMessageId).toBe(prefix[0]!.canvasMessageId);
  const childObservation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-exact-fork-child',
    externalSessionRef: child.externalSessionRef,
  });
  expect(childObservation.transcript).toEqual(prefix);
  const parentAfterFork = await harness.adapter.loadSession({
    commandId: 'command-load-exact-fork-parent-after-child',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-exact-fork-parent',
    externalSessionRef: parent.externalSessionRef,
  });
  expect(parentAfterFork.historyDigest).toBe(currentParent.historyDigest);
  const parentRun = await startRun(
    harness.adapter,
    parentAfterFork,
    'exact-fork-parent-after-child',
    'parent remains usable after fork',
  );
  const parentEvents = await collectAsync(harness.adapter.streamRunEvents(
    streamInput(parentAfterFork, parentRun, 'exact-fork-parent-after-child'),
  ));
  expect(parentEvents[0]?.type).toBe('run.accepted');
}

async function verifyEventReplay(harness: RuntimeContractHarness): Promise<void> {
  const capabilities = (await harness.adapter.describe(contractBinding)).capabilities;
  const session = await createSession(harness.adapter, 'replay');
  const run = await startRun(harness.adapter, session, 'replay');
  const events = await collectAsync(harness.adapter.streamRunEvents(streamInput(session, run, 'replay')));
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  const cursorIndex = 0;
  const cursor = events[cursorIndex]?.externalEventRef;
  expect(cursor).toBeDefined();
  const replay = await collectAsync(harness.adapter.streamRunEvents({
    ...streamInput(session, run, 'replay'),
    afterExternalEventRef: cursor!,
  }));
  expect(replay.map((event) => event.eventId)).toEqual(
    events.slice(cursorIndex + 1).map((event) => event.eventId),
  );
  await expectRuntimeFailure(
    collectAsync(harness.adapter.streamRunEvents({
      ...streamInput(session, run, 'replay'),
      afterExternalEventRef: 'cursor-that-does-not-exist',
    })),
    'protocol_error',
    capabilities.typedFailures !== 'unsupported',
  );
}

async function verifyStreamingText(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'streaming-text');
  const run = await startRun(harness.adapter, session, 'streaming-text');
  const events = await collectAsync(
    harness.adapter.streamRunEvents(streamInput(session, run, 'streaming-text')),
  );
  const deltas = events.filter((event) => event.type === 'model.output.delta');
  const message = events.find((event) => event.type === 'message.completed');
  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.map((event) => event.text).join('')).toEqual(message?.content);
}

async function verifyStreamingToolOutput(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'streaming-tool');
  const run = await startRun(harness.adapter, session, 'streaming-tool', 'use the contract test tool');
  const events = await collectAsync(
    harness.adapter.streamRunEvents(streamInput(session, run, 'streaming-tool')),
  );
  const toolDeltas = events.filter((event) => event.type === 'tool.output.delta');
  expect(toolDeltas.length).toBeGreaterThan(0);
  expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
}

async function verifyTypedFailures(harness: RuntimeContractHarness): Promise<void> {
  await expectRuntimeFailure(
    harness.adapter.loadSession({
      commandId: 'command-typed-failure',
      binding: contractBinding,
      canvasSessionId: 'missing-canvas-session',
      externalSessionRef: 'missing-runtime-session',
    }),
    'session_not_found',
    true,
  );
}

async function verifyCancellation(harness: RuntimeContractHarness): Promise<void> {
  const capabilities = (await harness.adapter.describe(contractBinding)).capabilities;
  const before = await createSession(harness.adapter, 'cancel-before');
  const beforeRun = await startRun(harness.adapter, before, 'cancel-before');
  const firstAck = await harness.adapter.cancelRun({
    commandId: 'command-cancel-before-first',
    binding: contractBinding,
    canvasRunId: 'canvas-run-cancel-before',
    externalRunRef: beforeRun.externalRunRef,
  });
  const repeatAck = await harness.adapter.cancelRun({
    commandId: 'command-cancel-before-repeat',
    binding: contractBinding,
    canvasRunId: 'canvas-run-cancel-before',
    externalRunRef: beforeRun.externalRunRef,
  });
  expect(firstAck.outcome).toBe('accepted');
  expect(repeatAck.outcome).toBe('accepted');
  const beforeEvents = await collectAsync(
    harness.adapter.streamRunEvents(streamInput(before, beforeRun, 'cancel-before')),
  );
  expect(terminalEvents(beforeEvents).map((event) => event.type)).toEqual(['run.cancelled']);

  const afterDelta = await createSession(harness.adapter, 'cancel-delta');
  const deltaRun = await startRun(harness.adapter, afterDelta, 'cancel-delta');
  const deltaIterator = harness.adapter
    .streamRunEvents(streamInput(afterDelta, deltaRun, 'cancel-delta'))[Symbol.asyncIterator]();
  let allDeltaEvents: RuntimeEvent[];
  try {
    const deltaEvents = await collectIteratorThrough(
      deltaIterator,
      (event) => capabilities.streamingText === 'unsupported'
        ? event.type === 'run.started'
        : event.type === 'model.output.delta',
    );
    await harness.adapter.cancelRun({
      commandId: 'command-cancel-after-delta',
      binding: contractBinding,
      canvasRunId: 'canvas-run-cancel-delta',
      externalRunRef: deltaRun.externalRunRef,
    });
    allDeltaEvents = [...deltaEvents, ...await drainIterator(deltaIterator)];
  } finally {
    await deltaIterator.return?.();
  }
  expect(allDeltaEvents.some((event) => event.type === 'message.completed')).toBe(false);
  expect(allDeltaEvents.some((event) => event.type === 'run.completed')).toBe(false);
  expect(terminalEvents(allDeltaEvents).map((event) => event.type)).toEqual(['run.cancelled']);

  const afterMessage = await createSession(harness.adapter, 'cancel-message');
  const messageRun = await startRun(harness.adapter, afterMessage, 'cancel-message');
  const messageIterator = harness.adapter
    .streamRunEvents(streamInput(afterMessage, messageRun, 'cancel-message'))[Symbol.asyncIterator]();
  let allMessageEvents: RuntimeEvent[];
  try {
    const messageEvents = await collectIteratorThrough(
      messageIterator,
      (event) => event.type === 'message.completed',
    );
    await harness.adapter.cancelRun({
      commandId: 'command-cancel-after-message',
      binding: contractBinding,
      canvasRunId: 'canvas-run-cancel-message',
      externalRunRef: messageRun.externalRunRef,
    });
    allMessageEvents = [...messageEvents, ...await drainIterator(messageIterator)];
  } finally {
    await messageIterator.return?.();
  }
  expect(allMessageEvents.some((event) => event.type === 'message.completed')).toBe(true);
  expect(allMessageEvents.some((event) => event.type === 'run.completed')).toBe(false);
  expect(terminalEvents(allMessageEvents).map((event) => event.type)).toEqual(['run.cancelled']);

  const afterTerminal = await createSession(harness.adapter, 'cancel-terminal');
  const terminalRun = await startRun(harness.adapter, afterTerminal, 'cancel-terminal');
  const successful = await collectAsync(
    harness.adapter.streamRunEvents(streamInput(afterTerminal, terminalRun, 'cancel-terminal')),
  );
  expect(terminalEvents(successful).map((event) => event.type)).toEqual(['run.completed']);
  const terminalAck = await harness.adapter.cancelRun({
    commandId: 'command-cancel-after-terminal',
    binding: contractBinding,
    canvasRunId: 'canvas-run-cancel-terminal',
    externalRunRef: terminalRun.externalRunRef,
  });
  expect(terminalAck).toMatchObject({ outcome: 'already-terminal', observedTerminal: 'succeeded' });
}

async function verifyApprovalDecision(
  harness: RuntimeContractHarness,
  decision: 'allow-once' | 'deny',
): Promise<void> {
  const suffix = `approval-${decision}`;
  const session = await createSession(harness.adapter, suffix);
  const run = await startRun(
    harness.adapter,
    session,
    suffix,
    harness.fixtures.approvalPrompt,
  );
  const iterator = harness.adapter
    .streamRunEvents(streamInput(session, run, suffix))[Symbol.asyncIterator]();
  const events: RuntimeEvent[] = [];
  let approval: Extract<RuntimeEvent, { type: 'approval.required' }> | undefined;
  const remaining: RuntimeEvent[] = [];
  try {
    while (approval === undefined) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'approval.required') approval = next.value;
    }
    expect(approval).toBeDefined();
    expect(approval!.choices).toContain(decision);
    expect(terminalEvents(events)).toEqual([]);
    const acceptedIndex = events.findIndex((event) => event.type === 'run.accepted');
    const runStartedIndex = events.findIndex((event) => event.type === 'run.started');
    const requestedIndex = events.findIndex((event) => (
      event.type === 'tool.requested'
      && event.toolCallRef === approval!.toolCallRef
      && event.toolKey === approval!.toolKey
    ));
    const approvalIndex = events.findIndex((event) => event === approval);
    expect(acceptedIndex).toBeGreaterThanOrEqual(0);
    expect(runStartedIndex).toBeGreaterThan(acceptedIndex);
    expect(requestedIndex).toBeGreaterThan(runStartedIndex);
    expect(approvalIndex).toBeGreaterThan(requestedIndex);
    expect(events.some((event) => (
      (event.type === 'tool.started' || event.type === 'tool.completed')
      && event.toolCallRef === approval!.toolCallRef
    ))).toBe(false);
    await harness.adapter.respondToApproval({
      commandId: `command-${suffix}-decision`,
      binding: contractBinding,
      canvasRunId: `canvas-run-${suffix}`,
      externalRunRef: run.externalRunRef,
      approvalRef: approval!.approvalRef,
      decision,
    });
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  const capabilities = (await harness.adapter.describe(contractBinding)).capabilities;
  if (capabilities.exactlyOneTerminalEvent !== 'unsupported') {
    expect(terminalEvents(remaining)).toHaveLength(1);
  } else {
    expect(terminalEvents(remaining).length).toBeGreaterThan(0);
  }
  const terminalIndex = remaining.findIndex((event) => terminalTypes.has(event.type));
  if (decision === 'deny') {
    expect(remaining.some((event) => (
      (event.type === 'tool.started' || event.type === 'tool.completed')
      && event.toolCallRef === approval!.toolCallRef
    ))).toBe(false);
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
  } else {
    const toolStartedIndex = remaining.findIndex((event) => (
      event.type === 'tool.started' && event.toolCallRef === approval!.toolCallRef
    ));
    const toolCompletedIndex = remaining.findIndex((event) => (
      event.type === 'tool.completed' && event.toolCallRef === approval!.toolCallRef
    ));
    expect(toolStartedIndex).toBeGreaterThanOrEqual(0);
    expect(toolCompletedIndex).toBeGreaterThan(toolStartedIndex);
    expect(terminalIndex).toBeGreaterThan(toolCompletedIndex);
  }
  const observation = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: `canvas-run-${suffix}`,
    externalRunRef: run.externalRunRef,
  });
  const observedStatuses = observation.toolExecutions
    .filter((execution) => execution.toolCallRef === approval!.toolCallRef)
    .map((execution) => execution.status);
  if (decision === 'deny') {
    expect(observedStatuses.some((status) => ['started', 'completed'].includes(status))).toBe(false);
  } else {
    expect(observedStatuses).toContain('started');
    expect(observedStatuses).toContain('completed');
  }
}

async function verifyToolApproval(harness: RuntimeContractHarness): Promise<void> {
  await verifyApprovalDecision(harness, 'deny');
  await verifyApprovalDecision(harness, 'allow-once');
}

async function verifySessionModelSwitch(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'model-switch');
  const originalRun = await startRun(harness.adapter, session, 'model-switch-original');
  await collectAsync(
    harness.adapter.streamRunEvents(streamInput(session, originalRun, 'model-switch-original')),
  );
  const originalObservation = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-model-switch-original',
    externalRunRef: originalRun.externalRunRef,
  });
  const alternateModel = harness.fixtures.alternateModel;
  if (alternateModel === undefined) {
    throw new Error('sessionModelSwitch requires an alternate model fixture');
  }
  expect(alternateModel).not.toEqual(harness.fixtures.defaultModel);
  const loaded = await harness.adapter.loadSession({
    commandId: 'command-load-model-switch-before-update',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-model-switch',
    externalSessionRef: session.externalSessionRef,
  });
  await expect(harness.adapter.setSessionModel({
    commandId: 'command-model-switch',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-model-switch',
    externalSessionRef: session.externalSessionRef,
    model: alternateModel,
    expectedIdle: true,
  })).resolves.toBeUndefined();
  const descriptor = await harness.adapter.describe(contractBinding);
  await expectRuntimeFailure(harness.adapter.setSessionModel({
    commandId: 'command-model-switch-wrong-binding',
    binding: otherBinding,
    canvasSessionId: 'canvas-session-model-switch',
    externalSessionRef: session.externalSessionRef,
    model: alternateModel,
    expectedIdle: true,
  }), 'session_ownership_mismatch', descriptor.capabilities.typedFailures !== 'unsupported');
  const switchedSession = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-model-switch',
    externalSessionRef: session.externalSessionRef,
  });
  expect(switchedSession.model).toEqual(alternateModel);
  const switchedRun = await harness.adapter.startRun({
    commandId: 'command-run-model-switch-new',
    idempotencyKey: 'idempotency-model-switch-new',
    binding: contractBinding,
    canvasRunId: 'canvas-run-model-switch-new',
    canvasSessionId: 'canvas-session-model-switch',
    externalSessionRef: session.externalSessionRef,
    expectedHistoryDigest: loaded.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-model-switch-new',
      role: 'user',
      content: 'run with switched model',
    },
    model: alternateModel,
    toolPolicy: emptyToolPolicy,
    context: [],
  });
  await collectAsync(harness.adapter.streamRunEvents({
    binding: contractBinding,
    canvasRunId: 'canvas-run-model-switch-new',
    externalRunRef: switchedRun.externalRunRef,
  }));
  const switchedObservation = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-model-switch-new',
    externalRunRef: switchedRun.externalRunRef,
  });
  const originalAfterSwitch = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-model-switch-original',
    externalRunRef: originalRun.externalRunRef,
  });
  expect(switchedObservation.model).toEqual(alternateModel);
  expect(originalAfterSwitch.model).toEqual(originalObservation.model);
  expect(originalAfterSwitch.model).toEqual(harness.fixtures.defaultModel);
}

async function verifyAllowedToolControl(
  harness: RuntimeContractHarness,
  suffix: string,
  toolKey: string,
  promptContent: unknown,
): Promise<void> {
  const session = await createSession(harness.adapter, `${suffix}-allowed`);
  const allowedPolicy: RuntimeToolPolicy = {
    allowedToolKeys: [toolKey],
    deniedToolKeys: [],
    approvalRequiredToolKeys: [],
  };
  await harness.adapter.setSessionToolPolicy({
    commandId: `command-${suffix}-allowed-policy`,
    binding: contractBinding,
    canvasSessionId: `canvas-session-${suffix}-allowed`,
    externalSessionRef: session.externalSessionRef,
    toolPolicy: allowedPolicy,
    expectedIdle: true,
  });
  const loaded = await harness.adapter.loadSession({
    commandId: `command-load-${suffix}-allowed`,
    binding: contractBinding,
    canvasSessionId: `canvas-session-${suffix}-allowed`,
    externalSessionRef: session.externalSessionRef,
  });
  const model = await firstModel(harness.adapter);
  const run = await harness.adapter.startRun({
    commandId: `command-run-${suffix}-allowed`,
    idempotencyKey: `idempotency-${suffix}-allowed`,
    binding: contractBinding,
    canvasRunId: `canvas-run-${suffix}-allowed`,
    canvasSessionId: `canvas-session-${suffix}-allowed`,
    externalSessionRef: session.externalSessionRef,
    expectedHistoryDigest: loaded.historyDigest!,
    prompt: {
      canvasMessageId: `canvas-message-${suffix}-allowed`,
      role: 'user',
      content: promptContent,
    },
    model,
    toolPolicy: allowedPolicy,
    context: [],
  });
  await collectAsync(harness.adapter.streamRunEvents({
    binding: contractBinding,
    canvasRunId: `canvas-run-${suffix}-allowed`,
    externalRunRef: run.externalRunRef,
  }));
  const observation = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: `canvas-run-${suffix}-allowed`,
    externalRunRef: run.externalRunRef,
  });
  expect(observation.toolPolicy).toEqual(allowedPolicy);
  expect(observation.toolExecutions.some((execution) => (
    execution.toolKey === toolKey && execution.status === 'completed'
  ))).toBe(true);
}

async function verifySessionToolPolicy(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'tool-policy');
  const deniedPolicy: RuntimeToolPolicy = {
    allowedToolKeys: [],
    deniedToolKeys: [harness.fixtures.deniedToolKey],
    approvalRequiredToolKeys: [],
  };
  await expect(harness.adapter.setSessionToolPolicy({
    commandId: 'command-tool-policy',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-tool-policy',
    externalSessionRef: session.externalSessionRef,
    toolPolicy: deniedPolicy,
    expectedIdle: true,
  })).resolves.toBeUndefined();
  const descriptor = await harness.adapter.describe(contractBinding);
  await expectRuntimeFailure(harness.adapter.setSessionToolPolicy({
    commandId: 'command-tool-policy-wrong-binding',
    binding: otherBinding,
    canvasSessionId: 'canvas-session-tool-policy',
    externalSessionRef: session.externalSessionRef,
    toolPolicy: deniedPolicy,
    expectedIdle: true,
  }), 'session_ownership_mismatch', descriptor.capabilities.typedFailures !== 'unsupported');
  const observedSession = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-tool-policy',
    externalSessionRef: session.externalSessionRef,
  });
  expect(observedSession.toolPolicy).toEqual(deniedPolicy);
  const loaded = await harness.adapter.loadSession({
    commandId: 'command-load-tool-policy',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-tool-policy',
    externalSessionRef: session.externalSessionRef,
  });
  const model = await firstModel(harness.adapter);
  const run = await harness.adapter.startRun({
    commandId: 'command-run-tool-policy-denied',
    idempotencyKey: 'idempotency-tool-policy-denied',
    binding: contractBinding,
    canvasRunId: 'canvas-run-tool-policy-denied',
    canvasSessionId: 'canvas-session-tool-policy',
    externalSessionRef: loaded.externalSessionRef,
    expectedHistoryDigest: loaded.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-tool-policy-denied',
      role: 'user',
      content: harness.fixtures.deniedToolPrompt,
    },
    model,
    toolPolicy: deniedPolicy,
    context: [],
  });
  const events = await collectAsync(
    harness.adapter.streamRunEvents(streamInput(loaded, run, 'tool-policy-denied')),
  );
  const deniedCallRefs = new Set(events.flatMap((event) => (
    event.type === 'tool.requested' && event.toolKey === harness.fixtures.deniedToolKey
      ? [event.toolCallRef]
      : []
  )));
  expect(events.some((event) => (
    event.type === 'tool.started' && deniedCallRefs.has(event.toolCallRef)
  ))).toBe(false);
  const observedRun = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-tool-policy-denied',
    externalRunRef: run.externalRunRef,
  });
  expect(observedRun.toolPolicy).toEqual(deniedPolicy);
  expect(observedRun.toolExecutions.some((execution) => (
    execution.toolKey === harness.fixtures.deniedToolKey
    && ['started', 'completed'].includes(execution.status)
  ))).toBe(false);
  await verifyAllowedToolControl(
    harness,
    'tool-policy',
    harness.fixtures.allowedToolKey,
    harness.fixtures.allowedToolPrompt,
  );
}

async function verifyPerSessionMcpPolicy(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'mcp-policy');
  const deniedPolicy: RuntimeToolPolicy = {
    allowedToolKeys: [],
    deniedToolKeys: [harness.fixtures.deniedMcpToolKey],
    approvalRequiredToolKeys: [],
  };
  await expect(harness.adapter.setSessionToolPolicy({
    commandId: 'command-mcp-policy',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-mcp-policy',
    externalSessionRef: session.externalSessionRef,
    toolPolicy: deniedPolicy,
    expectedIdle: true,
  })).resolves.toBeUndefined();
  const loaded = await harness.adapter.loadSession({
    commandId: 'command-load-mcp-policy',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-mcp-policy',
    externalSessionRef: session.externalSessionRef,
  });
  const model = await firstModel(harness.adapter);
  const run = await harness.adapter.startRun({
    commandId: 'command-run-mcp-policy-denied',
    idempotencyKey: 'idempotency-mcp-policy-denied',
    binding: contractBinding,
    canvasRunId: 'canvas-run-mcp-policy-denied',
    canvasSessionId: 'canvas-session-mcp-policy',
    externalSessionRef: loaded.externalSessionRef,
    expectedHistoryDigest: loaded.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-mcp-policy-denied',
      role: 'user',
      content: harness.fixtures.deniedMcpPrompt,
    },
    model,
    toolPolicy: deniedPolicy,
    context: [],
  });
  const events = await collectAsync(
    harness.adapter.streamRunEvents(streamInput(loaded, run, 'mcp-policy-denied')),
  );
  const deniedCallRefs = new Set(events.flatMap((event) => (
    event.type === 'tool.requested' && event.toolKey === harness.fixtures.deniedMcpToolKey
      ? [event.toolCallRef]
      : []
  )));
  expect(events.some((event) => (
    event.type === 'tool.started' && deniedCallRefs.has(event.toolCallRef)
  ))).toBe(false);
  const observedRun = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-mcp-policy-denied',
    externalRunRef: run.externalRunRef,
  });
  expect(observedRun.toolPolicy).toEqual(deniedPolicy);
  expect(observedRun.toolExecutions.some((execution) => (
    execution.toolKey === harness.fixtures.deniedMcpToolKey
    && ['started', 'completed'].includes(execution.status)
  ))).toBe(false);
  await verifyAllowedToolControl(
    harness,
    'mcp-policy',
    harness.fixtures.allowedMcpToolKey,
    harness.fixtures.allowedMcpPrompt,
  );
}

async function verifyClientIdempotency(harness: RuntimeContractHarness): Promise<void> {
  const model = await firstModel(harness.adapter);
  const capabilities = (await harness.adapter.describe(contractBinding)).capabilities;
  const typedFailures = capabilities.typedFailures !== 'unsupported';
  type CreateInput = Parameters<RuntimeAdapter['createSession']>[0];
  type RunInput = Parameters<RuntimeAdapter['startRun']>[0];
  const input: CreateInput = {
    commandId: 'command-idempotent-create',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-idempotent',
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  };
  const first = await harness.adapter.createSession(input);
  const afterFirstCreate = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-idempotent',
    externalSessionRef: first.externalSessionRef,
  });
  const duplicate = await harness.adapter.createSession(input);
  expect(duplicate).toEqual(first);
  expect(await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-idempotent',
    externalSessionRef: first.externalSessionRef,
  })).toEqual(afterFirstCreate);
  const createPayloadDrifts: CreateInput[] = [
    { ...input, canvasSessionId: 'canvas-session-idempotent-command-drift' },
    { ...input, model: { ...model, modelKey: `${model.modelKey}-drift` } },
    {
      ...input,
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: ['contract.create-payload-drift'],
        approvalRequiredToolKeys: [],
      },
    },
    {
      ...input,
      context: [{
        canvasContextRefId: 'context-create-payload-drift',
        scope: 'session',
        visibility: 'private',
        content: { drift: true },
        provenance: { source: 'contract-suite' },
      }],
    },
  ];
  for (const drift of createPayloadDrifts) {
    await expectRuntimeFailure(
      harness.adapter.createSession(drift),
      'transcript_conflict',
      typedFailures,
    );
    expect(await harness.fixtures.observeSession({
      adapter: harness.adapter,
      binding: contractBinding,
      canvasSessionId: 'canvas-session-idempotent',
      externalSessionRef: first.externalSessionRef,
    })).toEqual(afterFirstCreate);
  }
  const sessionsAfterCommandRetry = await harness.adapter.listSessions({ binding: contractBinding });
  expect(sessionsAfterCommandRetry.sessions.map((session) => session.externalSessionRef)).toEqual([
    first.externalSessionRef,
  ]);
  const beforeRun = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-idempotent',
    externalSessionRef: first.externalSessionRef,
  });
  expect(beforeRun.transcript).toEqual([]);
  const runInput: RunInput = {
    commandId: 'command-idempotent-run-first',
    idempotencyKey: 'idempotency-contract-run',
    binding: contractBinding,
    canvasRunId: 'canvas-run-idempotent',
    canvasSessionId: 'canvas-session-idempotent',
    externalSessionRef: first.externalSessionRef,
    expectedHistoryDigest: first.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-idempotent',
      role: 'user' as const,
      content: 'execute exactly once',
    },
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  };
  const firstRun = await harness.adapter.startRun(runInput);
  const events = await collectAsync(harness.adapter.streamRunEvents({
    binding: contractBinding,
    canvasRunId: 'canvas-run-idempotent',
    externalRunRef: firstRun.externalRunRef,
  }));
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  if (capabilities.exactlyOneTerminalEvent !== 'unsupported') {
    expect(terminalEvents(events)).toHaveLength(1);
  }
  const afterFirstRunSession = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-idempotent',
    externalSessionRef: first.externalSessionRef,
  });
  const afterFirstRun = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-idempotent',
    externalRunRef: firstRun.externalRunRef,
  });
  expect(afterFirstRunSession.transcript.filter((message) => (
    message.canvasMessageId === 'canvas-message-idempotent'
  ))).toHaveLength(1);
  expect(afterFirstRunSession.transcript.filter((message) => message.role === 'assistant')).toHaveLength(1);

  const duplicateByBusinessKey = await harness.adapter.startRun({
    ...runInput,
    commandId: 'command-idempotent-run-business-key-retry',
  });
  expect(duplicateByBusinessKey).toEqual(firstRun);
  const duplicateByCommand = await harness.adapter.startRun({
    ...runInput,
    idempotencyKey: 'idempotency-contract-run-command-retry',
  });
  expect(duplicateByCommand).toEqual(firstRun);
  expect(await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-idempotent',
    externalSessionRef: first.externalSessionRef,
  })).toEqual(afterFirstRunSession);
  expect(await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-idempotent',
    externalRunRef: firstRun.externalRunRef,
  })).toEqual(afterFirstRun);

  const runPayloadDrifts: RunInput[] = [
    { ...runInput, canvasRunId: 'canvas-run-idempotent-drift' },
    { ...runInput, canvasSessionId: 'canvas-session-idempotent-drift' },
    { ...runInput, externalSessionRef: 'external-session-ref-idempotent-drift' },
    { ...runInput, expectedHistoryDigest: 'sha256:idempotent-drift' },
    {
      ...runInput,
      prompt: { ...runInput.prompt, canvasMessageId: 'canvas-message-idempotent-drift' },
    },
    { ...runInput, prompt: { ...runInput.prompt, role: 'system' } },
    {
      ...runInput,
      prompt: { ...runInput.prompt, content: 'changed idempotent Run payload' },
    },
    { ...runInput, model: { ...model, modelKey: `${model.modelKey}-drift` } },
    {
      ...runInput,
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: ['contract.run-payload-drift'],
        approvalRequiredToolKeys: [],
      },
    },
    {
      ...runInput,
      context: [{
        canvasContextRefId: 'context-run-payload-drift',
        scope: 'run',
        visibility: 'private',
        content: { drift: true },
        provenance: { source: 'contract-suite' },
      }],
    },
  ];
  for (const drift of runPayloadDrifts) {
    await expectRuntimeFailure(
      harness.adapter.startRun(drift),
      'transcript_conflict',
      typedFailures,
    );
    expect(await harness.fixtures.observeSession({
      adapter: harness.adapter,
      binding: contractBinding,
      canvasSessionId: 'canvas-session-idempotent',
      externalSessionRef: first.externalSessionRef,
    })).toEqual(afterFirstRunSession);
    expect(await harness.fixtures.observeRun({
      adapter: harness.adapter,
      binding: contractBinding,
      canvasRunId: 'canvas-run-idempotent',
      externalRunRef: firstRun.externalRunRef,
    })).toEqual(afterFirstRun);
  }
  if (capabilities.eventReplay !== 'unsupported') {
    const replay = await collectAsync(harness.adapter.streamRunEvents({
      binding: contractBinding,
      canvasRunId: 'canvas-run-idempotent',
      externalRunRef: duplicateByCommand.externalRunRef,
    }));
    expect(replay.map((event) => event.eventId)).toEqual(events.map((event) => event.eventId));
  }
}

async function expectUnsupportedIdempotencyConflict(
  operation: Promise<unknown>,
  typedFailures: boolean,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  if (typedFailures) {
    expect(caught).toBeInstanceOf(RuntimeAdapterError);
    expect(caught).toMatchObject({ operationEffect: 'not-applied' });
    expect(['transcript_conflict', 'session_busy', 'protocol_error']).toContain(
      (caught as RuntimeAdapterError).code,
    );
  }
}

async function verifyUnsupportedClientIdempotency(
  harness: RuntimeContractHarness,
): Promise<void> {
  const descriptor = await harness.adapter.describe(contractBinding);
  expect(descriptor.capabilities.clientIdempotency).toBe('unsupported');
  const model = await firstModel(harness.adapter);
  const createInput = {
    commandId: 'command-unsupported-idempotent-create',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-unsupported-idempotent',
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  };
  const session = await harness.adapter.createSession(createInput);
  const sessionBeforeDuplicate = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-unsupported-idempotent',
    externalSessionRef: session.externalSessionRef,
  });
  await expectUnsupportedIdempotencyConflict(
    harness.adapter.createSession(createInput),
    descriptor.capabilities.typedFailures !== 'unsupported',
  );
  expect((await harness.adapter.listSessions({ binding: contractBinding })).sessions.map(
    (candidate) => candidate.externalSessionRef,
  )).toEqual([session.externalSessionRef]);
  expect(await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-unsupported-idempotent',
    externalSessionRef: session.externalSessionRef,
  })).toEqual(sessionBeforeDuplicate);

  const runInput = {
    commandId: 'command-unsupported-idempotent-run',
    idempotencyKey: 'idempotency-unsupported-idempotent-run',
    binding: contractBinding,
    canvasRunId: 'canvas-run-unsupported-idempotent',
    canvasSessionId: 'canvas-session-unsupported-idempotent',
    externalSessionRef: session.externalSessionRef,
    expectedHistoryDigest: session.historyDigest!,
    prompt: {
      canvasMessageId: 'canvas-message-unsupported-idempotent',
      role: 'user' as const,
      content: 'dispatch only once without Runtime idempotency support',
    },
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  };
  const run = await harness.adapter.startRun(runInput);
  await collectAsync(harness.adapter.streamRunEvents({
    binding: contractBinding,
    canvasRunId: 'canvas-run-unsupported-idempotent',
    externalRunRef: run.externalRunRef,
  }));
  const sessionBeforeRunDuplicate = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-unsupported-idempotent',
    externalSessionRef: session.externalSessionRef,
  });
  const runBeforeDuplicate = await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-unsupported-idempotent',
    externalRunRef: run.externalRunRef,
  });
  await expectUnsupportedIdempotencyConflict(
    harness.adapter.startRun(runInput),
    descriptor.capabilities.typedFailures !== 'unsupported',
  );
  const observation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-unsupported-idempotent',
    externalSessionRef: session.externalSessionRef,
  });
  expect(observation).toEqual(sessionBeforeRunDuplicate);
  expect(await harness.fixtures.observeRun({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasRunId: 'canvas-run-unsupported-idempotent',
    externalRunRef: run.externalRunRef,
  })).toEqual(runBeforeDuplicate);
  expect(observation.transcript.filter((message) => (
    message.canvasMessageId === 'canvas-message-unsupported-idempotent'
  ))).toHaveLength(1);
  expect(observation.transcript.filter((message) => message.role === 'assistant')).toHaveLength(1);
}

async function verifyExactlyOneTerminal(harness: RuntimeContractHarness): Promise<void> {
  const session = await createSession(harness.adapter, 'one-terminal');
  const run = await startRun(harness.adapter, session, 'one-terminal');
  const events = await collectAsync(
    harness.adapter.streamRunEvents(streamInput(session, run, 'one-terminal')),
  );
  expect(terminalEvents(events)).toHaveLength(1);
}

async function verifySnapshotRestore(harness: RuntimeContractHarness): Promise<void> {
  const source = await createSession(harness.adapter, 'snapshot-source');
  const run = await startRun(harness.adapter, source, 'snapshot-source');
  await collectAsync(harness.adapter.streamRunEvents(streamInput(source, run, 'snapshot-source')));
  const snapshot = await harness.adapter.exportSnapshot({
    commandId: 'command-export-snapshot-source',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-snapshot-source',
    externalSessionRef: source.externalSessionRef,
  });
  const pristineSnapshot = structuredClone(snapshot);
  harness.fixtures.mutateSnapshot(snapshot);
  const freshExport = await harness.adapter.exportSnapshot({
    commandId: 'command-export-snapshot-source-fresh',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-snapshot-source',
    externalSessionRef: source.externalSessionRef,
  });
  expect(freshExport).toEqual(pristineSnapshot);
  const descriptor = await harness.adapter.describe(contractBinding);
  await expectRuntimeFailure(harness.adapter.exportSnapshot({
    commandId: 'command-export-snapshot-wrong-binding',
    binding: otherBinding,
    canvasSessionId: 'canvas-session-snapshot-source',
    externalSessionRef: source.externalSessionRef,
  }), 'session_ownership_mismatch', descriptor.capabilities.typedFailures !== 'unsupported');
  const model = await firstModel(harness.adapter);
  const restoreInput = {
    commandId: 'command-restore-snapshot',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-snapshot-restored',
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
    snapshot: freshExport,
  };
  const restored = await harness.adapter.restoreSnapshot(restoreInput);
  expect(restored.historyDigest).not.toBe(digestRuntimeTranscript([]));
  const restoredObservation = await harness.fixtures.observeSession({
    adapter: harness.adapter,
    binding: contractBinding,
    canvasSessionId: 'canvas-session-snapshot-restored',
    externalSessionRef: restored.externalSessionRef,
  });
  if (descriptor.capabilities.clientIdempotency !== 'unsupported') {
    const sessionsBeforeReplay = await harness.adapter.listSessions({ binding: contractBinding });
    expect(await harness.adapter.restoreSnapshot(restoreInput)).toEqual(restored);
    await expectRuntimeFailure(harness.adapter.restoreSnapshot({
      ...restoreInput,
      context: [{
        canvasContextRefId: 'context-restore-snapshot-drift',
        scope: 'session',
        visibility: 'private',
        content: { drift: true },
        provenance: { source: 'contract-suite' },
      }],
    }), 'transcript_conflict', descriptor.capabilities.typedFailures !== 'unsupported');
    expect(await harness.adapter.listSessions({ binding: contractBinding })).toEqual(
      sessionsBeforeReplay,
    );
    expect(await harness.fixtures.observeSession({
      adapter: harness.adapter,
      binding: contractBinding,
      canvasSessionId: 'canvas-session-snapshot-restored',
      externalSessionRef: restored.externalSessionRef,
    })).toEqual(restoredObservation);
  }
  harness.fixtures.mutateSnapshot(freshExport);
  const roundTrip = await harness.adapter.exportSnapshot({
    commandId: 'command-export-snapshot-restored',
    binding: contractBinding,
    canvasSessionId: 'canvas-session-snapshot-restored',
    externalSessionRef: restored.externalSessionRef,
  });
  expect(roundTrip).toEqual(pristineSnapshot);

  const beforeInvalid = (await harness.adapter.listSessions({
    binding: contractBinding,
  })).sessions.length;
  const invalidSnapshots = harness.fixtures.invalidSnapshots(pristineSnapshot);
  expect(invalidSnapshots.length).toBeGreaterThan(0);
  for (const [index, invalidSnapshot] of invalidSnapshots.entries()) {
    await expectRuntimeFailure(harness.adapter.restoreSnapshot({
      commandId: `command-restore-invalid-snapshot-${index}`,
      binding: contractBinding,
      canvasSessionId: `canvas-session-invalid-snapshot-${index}`,
      model,
      toolPolicy: emptyToolPolicy,
      context: [],
      snapshot: invalidSnapshot,
    }), 'protocol_error', descriptor.capabilities.typedFailures !== 'unsupported');
  }
  expect((await harness.adapter.listSessions({
    binding: contractBinding,
  })).sessions).toHaveLength(beforeInvalid);
}

async function verifyRuntimeModelCatalog(harness: RuntimeContractHarness): Promise<void> {
  const first = await harness.adapter.listModels(contractBinding);
  const second = await harness.adapter.listModels(contractBinding);
  expect(first.length).toBeGreaterThan(0);
  expect(first).toEqual(second);
  for (const model of first) {
    expect(model.providerKey).toBeTruthy();
    expect(model.modelKey).toBeTruthy();
    expect(model.displayName).toBeTruthy();
    expect(model.capabilities).toBeTypeOf('object');
  }
}

const capabilityTests: Record<keyof RuntimeCapabilities, CapabilityTest> = {
  persistentSessions: verifyPersistentSessions,
  completedTurnPersistence: verifyCompletedTurnPersistence,
  inFlightResume: verifyInFlightResume,
  concurrentSessions: verifyConcurrentSessions,
  forkSession: verifyHeadFork,
  forkAtMessage: verifyExactMessageFork,
  eventReplay: verifyEventReplay,
  streamingText: verifyStreamingText,
  streamingToolOutput: verifyStreamingToolOutput,
  typedFailures: verifyTypedFailures,
  cancellation: verifyCancellation,
  toolApproval: verifyToolApproval,
  sessionModelSwitch: verifySessionModelSwitch,
  sessionToolPolicy: verifySessionToolPolicy,
  perSessionMcpPolicy: verifyPerSessionMcpPolicy,
  clientIdempotency: verifyClientIdempotency,
  exactlyOneTerminalEvent: verifyExactlyOneTerminal,
  snapshotRestore: verifySnapshotRestore,
  runtimeModelCatalog: verifyRuntimeModelCatalog,
};

async function verifyUnsupportedDeclaration(
  harness: RuntimeContractHarness,
  capability: keyof RuntimeCapabilities,
): Promise<void> {
  const descriptor = await harness.adapter.describe(contractBinding);
  expect(descriptor.capabilities[capability]).toBe('unsupported');
}

async function verifyUnsupportedFork(
  harness: RuntimeContractHarness,
  capability: 'forkSession' | 'forkAtMessage',
): Promise<void> {
  const suffix = `unsupported-${capability}`;
  const { parent, afterFirst, prefix } = await createForkFixture(harness.adapter, suffix);
  const model = await firstModel(harness.adapter);
  await expectCapabilityFailure(harness.adapter.forkSession({
    commandId: `command-unsupported-${capability}`,
    binding: contractBinding,
    parentCanvasSessionId: `canvas-session-${suffix}-parent`,
    parentExternalSessionRef: parent.externalSessionRef,
    childCanvasSessionId: `canvas-session-${suffix}-child`,
    atCanvasMessageId: prefix[0]!.canvasMessageId,
    sourceRevisionId: 'revision-unsupported-fork',
    expectedParentHistoryDigest: afterFirst.historyDigest!,
    transcriptPrefixDigest: digestRuntimeTranscript(prefix),
    transcriptPrefix: prefix,
    model,
    toolPolicy: emptyToolPolicy,
    context: [],
  }), capability);
}

const unsupportedCapabilityTests: Record<keyof RuntimeCapabilities, CapabilityTest> = {
  persistentSessions: (harness) => verifyUnsupportedDeclaration(harness, 'persistentSessions'),
  completedTurnPersistence: (harness) => verifyUnsupportedDeclaration(harness, 'completedTurnPersistence'),
  inFlightResume: (harness) => verifyUnsupportedDeclaration(harness, 'inFlightResume'),
  concurrentSessions: (harness) => verifyUnsupportedDeclaration(harness, 'concurrentSessions'),
  forkSession: (harness) => verifyUnsupportedFork(harness, 'forkSession'),
  forkAtMessage: async (harness) => {
    const descriptor = await harness.adapter.describe(contractBinding);
    if (descriptor.capabilities.forkSession === 'unsupported') {
      await verifyUnsupportedDeclaration(harness, 'forkAtMessage');
      return;
    }
    await verifyUnsupportedFork(harness, 'forkAtMessage');
  },
  eventReplay: async (harness) => {
    const session = await createSession(harness.adapter, 'unsupported-replay');
    const run = await startRun(harness.adapter, session, 'unsupported-replay');
    await expectCapabilityFailure(collectAsync(harness.adapter.streamRunEvents({
      ...streamInput(session, run, 'unsupported-replay'),
      afterExternalEventRef: 'unsupported-replay-cursor',
    })), 'eventReplay');
  },
  streamingText: (harness) => verifyUnsupportedDeclaration(harness, 'streamingText'),
  streamingToolOutput: (harness) => verifyUnsupportedDeclaration(harness, 'streamingToolOutput'),
  typedFailures: (harness) => verifyUnsupportedDeclaration(harness, 'typedFailures'),
  cancellation: async (harness) => {
    const session = await createSession(harness.adapter, 'unsupported-cancel');
    const run = await startRun(harness.adapter, session, 'unsupported-cancel');
    await expectCapabilityFailure(harness.adapter.cancelRun({
      commandId: 'command-unsupported-cancel',
      binding: contractBinding,
      canvasRunId: 'canvas-run-unsupported-cancel',
      externalRunRef: run.externalRunRef,
    }), 'cancellation');
  },
  toolApproval: async (harness) => {
    await expectCapabilityFailure(harness.adapter.respondToApproval({
      commandId: 'command-unsupported-approval',
      binding: contractBinding,
      canvasRunId: 'canvas-run-unsupported-approval',
      approvalRef: 'approval-unsupported',
      decision: 'deny',
    }), 'toolApproval');
  },
  sessionModelSwitch: async (harness) => {
    const session = await createSession(harness.adapter, 'unsupported-model-switch');
    const model = await firstModel(harness.adapter);
    await expectCapabilityFailure(harness.adapter.setSessionModel({
      commandId: 'command-unsupported-model-switch',
      binding: contractBinding,
      canvasSessionId: 'canvas-session-unsupported-model-switch',
      externalSessionRef: session.externalSessionRef,
      model,
      expectedIdle: true,
    }), 'sessionModelSwitch');
  },
  sessionToolPolicy: async (harness) => {
    const session = await createSession(harness.adapter, 'unsupported-tool-policy');
    await expectCapabilityFailure(harness.adapter.setSessionToolPolicy({
      commandId: 'command-unsupported-tool-policy',
      binding: contractBinding,
      canvasSessionId: 'canvas-session-unsupported-tool-policy',
      externalSessionRef: session.externalSessionRef,
      toolPolicy: emptyToolPolicy,
      expectedIdle: true,
    }), 'sessionToolPolicy');
  },
  perSessionMcpPolicy: async (harness) => {
    const descriptor = await harness.adapter.describe(contractBinding);
    expect(descriptor.capabilities.perSessionMcpPolicy).toBe('unsupported');
    const session = await createSession(harness.adapter, 'unsupported-mcp-policy');
    const before = await harness.fixtures.observeSession({
      adapter: harness.adapter,
      binding: contractBinding,
      canvasSessionId: 'canvas-session-unsupported-mcp-policy',
      externalSessionRef: session.externalSessionRef,
    });
    expect(harness.fixtures.deniedMcpToolKey).toMatch(/^mcp:/);
    await expectCapabilityFailure(harness.adapter.setSessionToolPolicy({
      commandId: 'command-unsupported-mcp-policy',
      binding: contractBinding,
      canvasSessionId: 'canvas-session-unsupported-mcp-policy',
      externalSessionRef: session.externalSessionRef,
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: [harness.fixtures.deniedMcpToolKey],
        approvalRequiredToolKeys: [],
      },
      expectedIdle: true,
    }), 'perSessionMcpPolicy');
    const after = await harness.fixtures.observeSession({
      adapter: harness.adapter,
      binding: contractBinding,
      canvasSessionId: 'canvas-session-unsupported-mcp-policy',
      externalSessionRef: session.externalSessionRef,
    });
    expect(after.toolPolicy).toEqual(before.toolPolicy);
  },
  clientIdempotency: verifyUnsupportedClientIdempotency,
  exactlyOneTerminalEvent: (harness) => verifyUnsupportedDeclaration(harness, 'exactlyOneTerminalEvent'),
  snapshotRestore: async (harness) => {
    const model = await firstModel(harness.adapter);
    const before = (await harness.adapter.listSessions({ binding: contractBinding })).sessions;
    // The exact 19-key contract has no snapshotExport capability. snapshotRestore gates
    // restoreSnapshot only; exportSnapshot may remain available for reconciliation.
    await expectCapabilityFailure(harness.adapter.restoreSnapshot({
      commandId: 'command-unsupported-snapshot',
      binding: contractBinding,
      canvasSessionId: 'canvas-session-unsupported-snapshot',
      model,
      toolPolicy: emptyToolPolicy,
      context: [],
      snapshot: { format: 'malformed', version: '0', payload: new Array(1) },
    }), 'snapshotRestore');
    expect((await harness.adapter.listSessions({ binding: contractBinding })).sessions).toEqual(before);
  },
  runtimeModelCatalog: async (harness) => {
    await expectCapabilityFailure(
      harness.adapter.listModels(contractBinding),
      'runtimeModelCatalog',
    );
  },
};

export async function verifyClaimedCapabilities(
  createHarness: RuntimeContractHarnessFactory,
): Promise<void> {
  const baseline = await createHarness();
  registerHarness(baseline);
  let capabilities: RuntimeCapabilities;
  try {
    capabilities = (await baseline.adapter.describe(contractBinding)).capabilities;
    verifyCapabilityShape(capabilities);
    await verifyRuntimeContract(baseline.adapter, baseline.fixtures);
  } finally {
    await disposeHarness(baseline);
  }

  for (const capability of runtimeCapabilityKeys) {
    const harness = await createHarness();
    registerHarness(harness);
    try {
      const test = capabilities[capability] === 'unsupported'
        ? unsupportedCapabilityTests[capability]
        : capabilityTests[capability];
      await test(harness);
    } finally {
      await disposeHarness(harness);
    }
  }
}

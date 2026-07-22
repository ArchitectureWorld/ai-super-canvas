import { describe, expect, it } from 'vitest';

import {
  RuntimeAdapterError,
  RuntimeCapabilityError,
  digestRuntimeTranscript,
  type RuntimeAdapter,
  type RuntimeBindingContext,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeModelSelection,
  type RuntimeSessionRef,
  type RuntimeSnapshot,
  type RuntimeTranscriptMessage,
} from './contract';
import {
  contractBinding,
  contractAgentBinding,
  contractIsolationBinding,
  type RuntimeContractFixtures,
  type RuntimeContractHarness,
  type RuntimeRunObservation,
  verifyClaimedCapabilities,
} from './contract-suite';
import { DeterministicFakeRuntime } from './deterministic-fake';

const model: RuntimeModelSelection = {
  providerKey: 'fake',
  modelKey: 'deterministic-v1',
};

const toolPolicy = {
  allowedToolKeys: [] as string[],
  deniedToolKeys: [] as string[],
  approvalRequiredToolKeys: [] as string[],
};

const bindingWithSameAgent: RuntimeBindingContext = {
  canvasAgentBindingId: contractBinding.canvasAgentBindingId,
  isolationKey: 'different-isolation',
};

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}

async function collectThrough(
  source: AsyncIterable<RuntimeEvent>,
  type: RuntimeEvent['type'],
): Promise<RuntimeEvent[]> {
  const iterator = source[Symbol.asyncIterator]();
  const events: RuntimeEvent[] = [];
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === type) break;
    }
  } finally {
    await iterator.return?.();
  }
  return events;
}

interface ObservableFakeSession {
  canvasSessionId: string;
  externalSessionRef: string;
  historyDigest: string;
  transcript: RuntimeTranscriptMessage[];
  model: RuntimeModelSelection;
  toolPolicy: typeof toolPolicy;
  context: Array<{
    canvasContextRefId: string;
    scope: 'account' | 'agent' | 'workflow' | 'session' | 'run';
    visibility: 'private' | 'workspace';
    content: unknown;
    provenance: Record<string, unknown>;
  }>;
}

interface ObservableFakeRun {
  canvasRunId: string;
  externalRunRef: string;
  input: {
    model: RuntimeModelSelection;
    toolPolicy: typeof toolPolicy;
    context: ObservableFakeSession['context'];
  };
  ledger: RuntimeEvent[];
  plannedEvents: RuntimeEvent[];
  productionCursor: number;
}

function fakeFixtures(runtime: DeterministicFakeRuntime): RuntimeContractFixtures {
  const state = runtime as unknown as {
    sessions: Map<string, ObservableFakeSession>;
    runs: Map<string, ObservableFakeRun>;
  };
  return {
    defaultModel: model,
    approvalPrompt: 'request approval for contract tool',
    deniedToolPrompt: 'attempt denied contract tool',
    deniedToolKey: 'contract.denied',
    allowedToolPrompt: 'execute allowed contract tool',
    allowedToolKey: 'contract.allowed',
    deniedMcpPrompt: 'attempt denied contract MCP tool',
    deniedMcpToolKey: 'mcp:contract-server:denied',
    allowedMcpPrompt: 'execute allowed contract MCP tool',
    allowedMcpToolKey: 'mcp:contract-server:allowed',
    observeSession: async (input) => {
      const session = state.sessions.get(input.externalSessionRef);
      if (session === undefined || session.canvasSessionId !== input.canvasSessionId) {
        throw new Error('Fake Session observation target was not found');
      }
      return structuredClone({
        transcript: session.transcript,
        model: session.model,
        toolPolicy: session.toolPolicy,
        context: session.context,
      });
    },
    observeRun: async (input) => {
      const run = [...state.runs.values()].find((candidate) => (
        candidate.canvasRunId === input.canvasRunId
        && (input.externalRunRef === undefined
          || candidate.externalRunRef === input.externalRunRef)
      ));
      if (run === undefined) throw new Error('Fake Run observation target was not found');
      const events = [
        ...run.ledger,
        ...run.plannedEvents.slice(run.productionCursor),
      ];
      const toolExecutions = events.reduce<RuntimeRunObservation['toolExecutions']>(
        (executions, event) => {
          if (event.type === 'tool.requested') {
            executions.push({
              toolCallRef: event.toolCallRef,
              toolKey: event.toolKey,
              status: 'requested',
            });
          } else if (event.type === 'tool.started' || event.type === 'tool.completed') {
            executions.push({
              toolCallRef: event.toolCallRef,
              toolKey: 'unknown',
              status: event.type === 'tool.started' ? 'started' : 'completed',
            });
          }
          return executions;
        },
        [],
      );
      return structuredClone({
        model: run.input.model,
        toolPolicy: run.input.toolPolicy,
        context: run.input.context,
        toolExecutions,
      });
    },
    mutateSnapshot: (snapshot) => {
      const payload = snapshot.payload as RuntimeTranscriptMessage[];
      if (payload[0] !== undefined) payload[0].content = 'mutated by contract suite';
    },
    invalidSnapshots: (snapshot) => [
      { ...structuredClone(snapshot), format: `${snapshot.format}-invalid` },
      { ...structuredClone(snapshot), version: `${snapshot.version}-invalid` },
      { ...structuredClone(snapshot), payload: [{ role: 'user', content: 'missing id' }] },
      { ...structuredClone(snapshot), payload: new Array(1) },
    ],
    readLogs: async () => [],
  };
}

function terminal(events: RuntimeEvent[]): RuntimeEvent[] {
  return events.filter((event) => [
    'run.completed',
    'run.failed',
    'run.cancelled',
  ].includes(event.type));
}

async function createFakeHarness(): Promise<RuntimeContractHarness> {
  const adapter = new DeterministicFakeRuntime();
  const unsupportedLifecycle = async (): Promise<never> => {
    throw new Error('DeterministicFakeRuntime has no process lifecycle');
  };
  let disposed = false;
  return {
    adapter,
    fixtures: fakeFixtures(adapter),
    restartRuntime: unsupportedLifecycle,
    crashRuntime: unsupportedLifecycle,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const binding of [
        contractBinding,
        contractIsolationBinding,
        contractAgentBinding,
        bindingWithSameAgent,
      ]) {
        await adapter.shutdown({ binding, reason: 'test' });
        expect((await adapter.listSessions({ binding })).sessions).toEqual([]);
      }
    },
  };
}

function overrideCapabilities(
  runtime: DeterministicFakeRuntime,
  transform: (capabilities: RuntimeCapabilities) => RuntimeCapabilities,
): RuntimeAdapter {
  const proxy = new Proxy(runtime, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return { ...descriptor, capabilities: transform(descriptor.capabilities) };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? value.bind(target) as unknown
        : value;
    },
  }) as RuntimeAdapter;
  return proxy;
}

async function createLyingHarness(
  transform: (capabilities: RuntimeCapabilities) => RuntimeCapabilities,
): Promise<RuntimeContractHarness> {
  const runtime = new DeterministicFakeRuntime();
  const adapter = overrideCapabilities(runtime, transform);
  return {
    adapter,
    fixtures: fakeFixtures(runtime),
    restartRuntime: async () => adapter,
    crashRuntime: async () => adapter,
    dispose: async () => {
      for (const binding of [contractBinding, contractIsolationBinding, contractAgentBinding]) {
        await runtime.shutdown({ binding, reason: 'test' });
      }
    },
  };
}

type IdempotencyReplayMode = 'full' | 'idempotency-key-only' | 'partial-payload';

function bindingScopedKey(binding: RuntimeBindingContext, value: string): string {
  return JSON.stringify([binding.canvasAgentBindingId, binding.isolationKey, value]);
}

function comparablePayload(
  input: object,
  ignoredKeys: string[] = [],
): string {
  const payload = structuredClone(input) as Record<string, unknown>;
  for (const key of ignoredKeys) delete payload[key];
  return JSON.stringify(payload);
}

function idempotencyConflict(message: string): RuntimeAdapterError {
  return new RuntimeAdapterError('transcript_conflict', message, false, 'not-applied');
}

async function createIdempotencyLyingHarness(options: {
  runReplay: IdempotencyReplayMode;
  forkReplay?: boolean;
  restoreReplay?: boolean;
}): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  type CreateInput = Parameters<RuntimeAdapter['createSession']>[0];
  type ForkInput = Parameters<RuntimeAdapter['forkSession']>[0];
  type RunInput = Parameters<RuntimeAdapter['startRun']>[0];
  type RestoreInput = Parameters<RuntimeAdapter['restoreSnapshot']>[0];
  type RunResult = Awaited<ReturnType<RuntimeAdapter['startRun']>>;
  const creates = new Map<string, { input: CreateInput; result: RuntimeSessionRef }>();
  const forks = new Map<string, { input: ForkInput; result: RuntimeSessionRef }>();
  const restores = new Map<string, { input: RestoreInput; result: RuntimeSessionRef }>();
  const runsByCommand = new Map<string, { input: RunInput; result: RunResult }>();
  const runsByIdempotencyKey = new Map<string, { input: RunInput; result: RunResult }>();

  const replaySessionCommand = async <Input extends { commandId: string; binding: RuntimeBindingContext }>(
    input: Input,
    records: Map<string, { input: Input; result: RuntimeSessionRef }>,
    operation: (value: Input) => Promise<RuntimeSessionRef>,
  ): Promise<RuntimeSessionRef> => {
    const key = bindingScopedKey(input.binding, input.commandId);
    const existing = records.get(key);
    if (existing !== undefined) {
      if (comparablePayload(existing.input) !== comparablePayload(input)) {
        throw idempotencyConflict('commandId payload changed');
      }
      return structuredClone(existing.result);
    }
    const result = await operation(input);
    records.set(key, { input: structuredClone(input), result: structuredClone(result) });
    return result;
  };

  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return {
            ...descriptor,
            capabilities: { ...descriptor.capabilities, clientIdempotency: 'native' as const },
          };
        };
      }
      if (property === 'createSession') {
        return (input: CreateInput) => replaySessionCommand(
          input,
          creates,
          (value) => target.createSession(value),
        );
      }
      if (property === 'forkSession' && options.forkReplay !== false) {
        return (input: ForkInput) => replaySessionCommand(
          input,
          forks,
          (value) => target.forkSession(value),
        );
      }
      if (property === 'restoreSnapshot' && options.restoreReplay !== false) {
        return (input: RestoreInput) => replaySessionCommand(
          input,
          restores,
          (value) => target.restoreSnapshot(value),
        );
      }
      if (property === 'startRun') {
        return async (input: RunInput): Promise<RunResult> => {
          const commandKey = bindingScopedKey(input.binding, input.commandId);
          const idempotencyKey = bindingScopedKey(input.binding, input.idempotencyKey);
          const commandRecord = options.runReplay === 'idempotency-key-only'
            ? undefined
            : runsByCommand.get(commandKey);
          const idempotencyRecord = runsByIdempotencyKey.get(idempotencyKey);
          const existing = commandRecord ?? idempotencyRecord;
          if (existing !== undefined) {
            const ignoredKeys = commandRecord === undefined
              ? ['commandId']
              : idempotencyRecord === undefined
                ? ['idempotencyKey']
                : [];
            const matches = options.runReplay === 'partial-payload'
              ? existing.input.canvasRunId === input.canvasRunId
              : comparablePayload(existing.input, ignoredKeys) === comparablePayload(input, ignoredKeys);
            if (!matches) throw idempotencyConflict('Run idempotency payload changed');
            if (options.runReplay !== 'idempotency-key-only') {
              runsByCommand.set(commandKey, existing);
            }
            runsByIdempotencyKey.set(idempotencyKey, existing);
            return structuredClone(existing.result);
          }
          const result = await target.startRun(input);
          const record = { input: structuredClone(input), result: structuredClone(result) };
          if (options.runReplay !== 'idempotency-key-only') runsByCommand.set(commandKey, record);
          runsByIdempotencyKey.set(idempotencyKey, record);
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createUnsupportedIdempotencySideEffectHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const state = harness.adapter as unknown as {
    runs: Map<string, ObservableFakeRun>;
  };
  const seenCommands = new Set<string>();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'startRun') {
        return async (input: Parameters<RuntimeAdapter['startRun']>[0]) => {
          const commandKey = bindingScopedKey(input.binding, input.commandId);
          if (seenCommands.has(commandKey)) {
            const run = [...state.runs.values()].find((candidate) => (
              candidate.canvasRunId === input.canvasRunId
            ));
            if (run !== undefined) {
              run.ledger.push({
                eventId: 'lying-duplicate-side-effect',
                externalSequence: 999,
                externalEventRef: 'lying-duplicate-side-effect',
                canvasSessionId: input.canvasSessionId,
                canvasRunId: input.canvasRunId,
                occurredAt: new Date(0).toISOString(),
                type: 'tool.started',
                toolCallRef: 'lying-duplicate-tool-call',
              });
            }
            throw idempotencyConflict('duplicate was rejected after applying a side effect');
          }
          const result = await target.startRun(input);
          seenCommands.add(commandKey);
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createHeadTranscriptLyingHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const observeSession = harness.fixtures.observeSession;
  return {
    ...harness,
    fixtures: {
      ...harness.fixtures,
      observeSession: async (input) => {
        const observation = await observeSession(input);
        if (input.canvasSessionId === 'canvas-session-head-fork-child') {
          return { ...observation, transcript: [] };
        }
        return observation;
      },
    },
  };
}

async function createDeadHeadParentHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'startRun') {
        return async (input: Parameters<RuntimeAdapter['startRun']>[0]) => {
          if (input.canvasRunId === 'canvas-run-head-fork-parent-after-child') {
            throw new Error('HEAD fork incorrectly invalidated its parent');
          }
          return target.startRun(input);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createApprovalOrderingLyingHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return {
            ...descriptor,
            capabilities: { ...descriptor.capabilities, toolApproval: 'native' as const },
          };
        };
      }
      if (property === 'respondToApproval') {
        return async (): Promise<void> => undefined;
      }
      if (property === 'streamRunEvents') {
        return (input: Parameters<RuntimeAdapter['streamRunEvents']>[0]) => {
          if (!input.canvasRunId.startsWith('canvas-run-approval')) {
            return target.streamRunEvents(input);
          }
          const externalRunRef = input.externalRunRef ?? 'lying-approval-run';
          const base = {
            canvasSessionId: 'canvas-session-approval',
            canvasRunId: input.canvasRunId,
            occurredAt: new Date(0).toISOString(),
          };
          const events: RuntimeEvent[] = [
            {
              ...base,
              eventId: 'lying-approval:1',
              externalSequence: 1,
              externalEventRef: 'lying-approval:1',
              type: 'run.accepted',
              externalRunRef,
            },
            {
              ...base,
              eventId: 'lying-approval:2',
              externalSequence: 2,
              externalEventRef: 'lying-approval:2',
              type: 'run.completed',
            },
            {
              ...base,
              eventId: 'lying-approval:3',
              externalSequence: 3,
              externalEventRef: 'lying-approval:3',
              type: 'tool.requested',
              toolCallRef: 'lying-tool-call',
              toolKey: 'contract.approval',
              input: {},
            },
            {
              ...base,
              eventId: 'lying-approval:4',
              externalSequence: 4,
              externalEventRef: 'lying-approval:4',
              type: 'approval.required',
              approvalRef: 'lying-approval-ref',
              toolCallRef: 'lying-tool-call',
              toolKey: 'contract.approval',
              risk: 'high',
              choices: ['deny'],
            },
          ];
          return (async function* streamIllegalApprovalOrder() {
            for (const event of events) yield event;
          })();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createCombinedKeyIdempotencyHarness(
  support: 'native' | 'unsupported',
): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const createdByCommand = new Map<string, {
    canvasSessionId: string;
    result: RuntimeSessionRef;
  }>();
  const runsByCombinedKey = new Map<string, Awaited<ReturnType<RuntimeAdapter['startRun']>>>();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return {
            ...descriptor,
            capabilities: { ...descriptor.capabilities, clientIdempotency: support },
          };
        };
      }
      if (property === 'createSession') {
        return async (input: Parameters<RuntimeAdapter['createSession']>[0]) => {
          const key = JSON.stringify([
            input.binding.canvasAgentBindingId,
            input.binding.isolationKey,
            input.commandId,
          ]);
          const existing = createdByCommand.get(key);
          if (existing !== undefined) {
            if (existing.canvasSessionId !== input.canvasSessionId) {
              throw new RuntimeAdapterError(
                'transcript_conflict',
                'commandId payload changed',
                false,
                'not-applied',
              );
            }
            return structuredClone(existing.result);
          }
          const created = await target.createSession(input);
          createdByCommand.set(key, {
            canvasSessionId: input.canvasSessionId,
            result: structuredClone(created),
          });
          return created;
        };
      }
      if (property === 'startRun') {
        return async (input: Parameters<RuntimeAdapter['startRun']>[0]) => {
          const key = JSON.stringify([
            input.binding.canvasAgentBindingId,
            input.binding.isolationKey,
            input.commandId,
            input.idempotencyKey,
          ]);
          const existing = runsByCombinedKey.get(key);
          if (existing !== undefined) return structuredClone(existing);
          const run = await target.startRun(input);
          runsByCombinedKey.set(key, structuredClone(run));
          return run;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createMcpPolicyLyingHarness(
  sessionToolPolicy: 'adapter' | 'unsupported' = 'adapter',
): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const observeRun = harness.fixtures.observeRun;
  const state = harness.adapter as unknown as {
    sessions: Map<string, ObservableFakeSession>;
  };
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return {
            ...descriptor,
            capabilities: {
              ...descriptor.capabilities,
              sessionToolPolicy,
              perSessionMcpPolicy: 'unsupported' as const,
            },
          };
        };
      }
      if (property === 'setSessionToolPolicy') {
        return async (input: Parameters<RuntimeAdapter['setSessionToolPolicy']>[0]) => {
          const containsMcpKey = [
            ...input.toolPolicy.allowedToolKeys,
            ...input.toolPolicy.deniedToolKeys,
            ...input.toolPolicy.approvalRequiredToolKeys,
          ].some((toolKey) => toolKey.startsWith('mcp:'));
          if (sessionToolPolicy === 'unsupported' && !containsMcpKey) {
            return target.setSessionToolPolicy(input);
          }
          await target.loadSession({
            commandId: `${input.commandId}:validate`,
            binding: input.binding,
            canvasSessionId: input.canvasSessionId,
            externalSessionRef: input.externalSessionRef,
          });
          const session = state.sessions.get(input.externalSessionRef);
          if (session === undefined) throw new Error('lying policy Session missing');
          session.toolPolicy = structuredClone(input.toolPolicy);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return {
    ...harness,
    adapter,
    fixtures: {
      ...harness.fixtures,
      observeRun: async (input) => {
        const observation = await observeRun(input);
        if (input.canvasRunId === 'canvas-run-tool-policy-allowed') {
          return {
            ...observation,
            toolExecutions: [{
              toolCallRef: 'lying-allowed-tool-call',
              toolKey: harness.fixtures.allowedToolKey,
              status: 'completed' as const,
            }],
          };
        }
        return observation;
      },
    },
  };
}

async function createWrongMcpCapabilityErrorHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'setSessionToolPolicy') {
        return async (): Promise<never> => {
          throw new RuntimeCapabilityError('sessionToolPolicy');
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createAllowOnceLyingHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return {
            ...descriptor,
            capabilities: { ...descriptor.capabilities, toolApproval: 'native' as const },
          };
        };
      }
      if (property === 'respondToApproval') {
        return async (): Promise<void> => undefined;
      }
      if (property === 'streamRunEvents') {
        return (input: Parameters<RuntimeAdapter['streamRunEvents']>[0]) => {
          if (!input.canvasRunId.includes('approval')) return target.streamRunEvents(input);
          const externalRunRef = input.externalRunRef ?? 'lying-approval-run';
          const base = {
            canvasSessionId: input.canvasRunId.replace('canvas-run', 'canvas-session'),
            canvasRunId: input.canvasRunId,
            occurredAt: new Date(0).toISOString(),
          };
          const toolCallRef = `${input.canvasRunId}:tool-call`;
          const events: RuntimeEvent[] = [
            {
              ...base,
              eventId: `${input.canvasRunId}:1`,
              externalSequence: 1,
              externalEventRef: `${input.canvasRunId}:1`,
              type: 'run.accepted',
              externalRunRef,
            },
            {
              ...base,
              eventId: `${input.canvasRunId}:2`,
              externalSequence: 2,
              externalEventRef: `${input.canvasRunId}:2`,
              type: 'run.started',
            },
            {
              ...base,
              eventId: `${input.canvasRunId}:3`,
              externalSequence: 3,
              externalEventRef: `${input.canvasRunId}:3`,
              type: 'tool.requested',
              toolCallRef,
              toolKey: 'contract.approval',
              input: {},
            },
            {
              ...base,
              eventId: `${input.canvasRunId}:4`,
              externalSequence: 4,
              externalEventRef: `${input.canvasRunId}:4`,
              type: 'approval.required',
              approvalRef: `${input.canvasRunId}:approval`,
              toolCallRef,
              toolKey: 'contract.approval',
              risk: 'high',
              choices: ['allow-once', 'deny'],
            },
            {
              ...base,
              eventId: `${input.canvasRunId}:5`,
              externalSequence: 5,
              externalEventRef: `${input.canvasRunId}:5`,
              type: 'run.completed',
            },
          ];
          return (async function* streamDenyOnlyApproval() {
            for (const event of events) yield event;
          })();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createHeadDigestIgnoringHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const state = harness.adapter as unknown as {
    sessions: Map<string, ObservableFakeSession>;
  };
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'forkSession') {
        return async (input: Parameters<RuntimeAdapter['forkSession']>[0]) => {
          if (input.commandId === 'command-head-fork-wrong-history') {
            const parent = state.sessions.get(input.parentExternalSessionRef);
            if (parent === undefined) throw new Error('lying HEAD parent missing');
            return target.forkSession({
              ...input,
              expectedParentHistoryDigest: parent.historyDigest,
            });
          }
          return target.forkSession(input);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createUnsupportedHeadReplayHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  type ForkInput = Parameters<RuntimeAdapter['forkSession']>[0];
  const forks = new Map<string, { input: ForkInput; result: RuntimeSessionRef }>();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'forkSession') {
        return async (input: ForkInput) => {
          const key = bindingScopedKey(input.binding, input.commandId);
          const existing = forks.get(key);
          if (existing !== undefined) {
            if (comparablePayload(existing.input) !== comparablePayload(input)) {
              throw idempotencyConflict('unsupported HEAD replay payload changed');
            }
            return structuredClone(existing.result);
          }
          const result = await target.forkSession(input);
          forks.set(key, { input: structuredClone(input), result: structuredClone(result) });
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createBindingScopedConcurrentLyingHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const observeSession = harness.fixtures.observeSession;
  const sessionsByBinding = new Map<string, Array<{
    canvasSessionId: string;
    externalSessionRef: string;
  }>>();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'createSession') {
        return async (input: Parameters<RuntimeAdapter['createSession']>[0]) => {
          const result = await target.createSession(input);
          if (!input.canvasSessionId.includes('concurrent-same-binding')) return result;
          const key = bindingScopedKey(input.binding, 'sessions');
          const sessions = sessionsByBinding.get(key) ?? [];
          sessions.push({
            canvasSessionId: input.canvasSessionId,
            externalSessionRef: result.externalSessionRef,
          });
          sessionsByBinding.set(key, sessions);
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return {
    ...harness,
    adapter,
    fixtures: {
      ...harness.fixtures,
      observeSession: async (input) => {
        const sessions = sessionsByBinding.get(bindingScopedKey(input.binding, 'sessions')) ?? [];
        const currentIndex = sessions.findIndex((session) => (
          session.externalSessionRef === input.externalSessionRef
        ));
        if (currentIndex <= 0) return observeSession(input);
        const leaked = sessions[0]!;
        return observeSession({
          ...input,
          canvasSessionId: leaked.canvasSessionId,
          externalSessionRef: leaked.externalSessionRef,
        });
      },
    },
  };
}

async function createSnapshotValidationFirstLyingHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return {
            ...descriptor,
            capabilities: { ...descriptor.capabilities, snapshotRestore: 'unsupported' as const },
          };
        };
      }
      if (property === 'restoreSnapshot') {
        return async (input: Parameters<RuntimeAdapter['restoreSnapshot']>[0]) => {
          if (input.snapshot.format === 'malformed') {
            return target.restoreSnapshot(input);
          }
          throw new RuntimeCapabilityError('snapshotRestore');
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createReplayOnlyCapabilityHarness(): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return {
            ...descriptor,
            capabilities: {
              ...descriptor.capabilities,
              eventReplay: 'native' as const,
              streamingText: 'unsupported' as const,
              typedFailures: 'unsupported' as const,
            },
          };
        };
      }
      if (property === 'streamRunEvents') {
        return (input: Parameters<RuntimeAdapter['streamRunEvents']>[0]) => {
          const source = target.streamRunEvents(input);
          return (async function* streamWithoutTextOrTypedFailures() {
            try {
              for await (const event of source) {
                if (event.type !== 'model.output.delta') yield event;
              }
            } catch (error) {
              if (error instanceof RuntimeAdapterError) throw new Error(error.message);
              throw error;
            }
          })();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function createNoReplayCapabilityHarness(options: {
  cancellation: 'native' | 'unsupported';
  exactlyOneTerminalEvent: 'native' | 'unsupported';
  rejectSecondSubscription: boolean;
}): Promise<RuntimeContractHarness> {
  const harness = await createFakeHarness();
  const subscribedRuns = new Set<string>();
  const adapter = new Proxy(harness.adapter, {
    get(target, property) {
      if (property === 'describe') {
        return async (binding: RuntimeBindingContext) => {
          const descriptor = await target.describe(binding);
          return {
            ...descriptor,
            capabilities: {
              ...descriptor.capabilities,
              eventReplay: 'unsupported' as const,
              cancellation: options.cancellation,
              exactlyOneTerminalEvent: options.exactlyOneTerminalEvent,
            },
          };
        };
      }
      if (property === 'cancelRun' && options.cancellation === 'unsupported') {
        return async (): Promise<never> => {
          throw new RuntimeCapabilityError('cancellation');
        };
      }
      if (property === 'streamRunEvents') {
        return (input: Parameters<RuntimeAdapter['streamRunEvents']>[0]) => {
          const runKey = JSON.stringify([
            input.binding.canvasAgentBindingId,
            input.binding.isolationKey,
            input.canvasRunId,
          ]);
          const unavailable = input.afterExternalEventRef !== undefined
            || (
              options.rejectSecondSubscription
              && input.canvasRunId === 'canvas-run-one-terminal'
              && subscribedRuns.has(runKey)
            );
          if (unavailable) {
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next(): Promise<IteratorResult<RuntimeEvent>> {
                    throw new RuntimeCapabilityError('eventReplay');
                  },
                };
              },
            };
          }
          subscribedRuns.add(runKey);
          return target.streamRunEvents(input);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as RuntimeAdapter;
  return { ...harness, adapter };
}

async function create(
  runtime: DeterministicFakeRuntime,
  suffix: string,
  binding = contractBinding,
  selectedModel = model,
): Promise<RuntimeSessionRef> {
  return runtime.createSession({
    commandId: `create-${suffix}`,
    binding,
    canvasSessionId: `session-${suffix}`,
    model: selectedModel,
    toolPolicy,
    context: [],
  });
}

async function start(
  runtime: DeterministicFakeRuntime,
  session: RuntimeSessionRef,
  suffix: string,
  content: unknown = `prompt-${suffix}`,
  binding = contractBinding,
) {
  return runtime.startRun({
    commandId: `start-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    binding,
    canvasRunId: `run-${suffix}`,
    canvasSessionId: session.metadata.canvasSessionId as string,
    externalSessionRef: session.externalSessionRef,
    expectedHistoryDigest: session.historyDigest!,
    prompt: { canvasMessageId: `message-${suffix}`, role: 'user', content },
    model,
    toolPolicy,
    context: [],
  });
}

function eventsFor(
  runtime: DeterministicFakeRuntime,
  session: RuntimeSessionRef,
  run: { externalRunRef?: string },
  suffix: string,
  binding = contractBinding,
) {
  return runtime.streamRunEvents({
    binding,
    canvasRunId: `run-${suffix}`,
    externalRunRef: run.externalRunRef,
  });
}

async function expectError(
  operation: Promise<unknown>,
  code: RuntimeAdapterError['code'],
) {
  await expect(operation).rejects.toMatchObject({
    code,
    operationEffect: 'not-applied',
  });
}

describe('runtime transcript digest', () => {
  it('canonicalizes object keys recursively', () => {
    const first: RuntimeTranscriptMessage[] = [{
      canvasMessageId: 'message-canonical',
      role: 'user',
      content: { zebra: 1, nested: { beta: 2, alpha: 1 } },
    }];
    const reordered: RuntimeTranscriptMessage[] = [{
      role: 'user',
      content: { nested: { alpha: 1, beta: 2 }, zebra: 1 },
      canvasMessageId: 'message-canonical',
    }];
    expect(digestRuntimeTranscript(first)).toBe(digestRuntimeTranscript(reordered));
    expect(digestRuntimeTranscript(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('preserves array order', () => {
    const first = [{ canvasMessageId: 'array', role: 'user' as const, content: [1, 2, 3] }];
    const reordered = [{ canvasMessageId: 'array', role: 'user' as const, content: [3, 2, 1] }];
    expect(digestRuntimeTranscript(first)).not.toBe(digestRuntimeTranscript(reordered));
  });

  it('includes an own __proto__ key in canonical JSON', () => {
    const first = [{
      canvasMessageId: 'prototype-key',
      role: 'user' as const,
      content: JSON.parse('{"__proto__":{"value":"first"}}') as unknown,
    }];
    const second = [{
      canvasMessageId: 'prototype-key',
      role: 'user' as const,
      content: JSON.parse('{"__proto__":{"value":"second"}}') as unknown,
    }];
    expect(digestRuntimeTranscript(first)).not.toBe(digestRuntimeTranscript(second));
  });
});

describe('DeterministicFakeRuntime contract', () => {
  it('rejects a descriptor with a missing capability key', async () => {
    await expect(verifyClaimedCapabilities(() => createLyingHarness((capabilities) => {
      const incomplete = { ...capabilities } as Partial<RuntimeCapabilities>;
      delete incomplete.runtimeModelCatalog;
      return incomplete as RuntimeCapabilities;
    }))).rejects.toThrow(/capabilit/i);
  });

  it('rejects a lifecycle stub that returns the same adapter instance', async () => {
    await expect(verifyClaimedCapabilities(() => createLyingHarness((capabilities) => ({
      ...capabilities,
      persistentSessions: 'native',
    })))).rejects.toThrow(/fresh|instance|restart/i);
  });

  it('rejects a HEAD fork whose observed child transcript is not the exact parent HEAD', async () => {
    await expect(verifyClaimedCapabilities(createHeadTranscriptLyingHarness)).rejects.toThrow();
  });

  it('rejects a HEAD fork that makes its parent unusable', async () => {
    await expect(verifyClaimedCapabilities(createDeadHeadParentHarness)).rejects.toThrow(
      /invalidated its parent/,
    );
  });

  it('rejects an approval stream that reaches terminal before the decision', async () => {
    await expect(verifyClaimedCapabilities(createApprovalOrderingLyingHarness)).rejects.toThrow();
  });

  it('rejects an approval implementation that cannot resume allow-once through tool completion', async () => {
    await expect(verifyClaimedCapabilities(createAllowOnceLyingHarness)).rejects.toThrow();
  });

  it('rejects a HEAD fork that ignores an incorrect parent history digest', async () => {
    await expect(verifyClaimedCapabilities(createHeadDigestIgnoringHarness)).rejects.toThrow();
  });

  it('rejects unsupported client idempotency that silently replays a HEAD fork command', async () => {
    await expect(verifyClaimedCapabilities(createUnsupportedHeadReplayHarness)).rejects.toThrow();
  });

  it('rejects concurrent Session support that isolates only at Binding granularity', async () => {
    await expect(verifyClaimedCapabilities(
      createBindingScopedConcurrentLyingHarness,
    )).rejects.toThrow();
  });

  it('rejects client idempotency that only keys the combined command and business key', async () => {
    await expect(verifyClaimedCapabilities(
      () => createCombinedKeyIdempotencyHarness('native'),
    )).rejects.toThrow();
  });

  it('rejects client idempotency that only keys startRun by idempotencyKey', async () => {
    await expect(verifyClaimedCapabilities(
      () => createIdempotencyLyingHarness({ runReplay: 'idempotency-key-only' }),
    )).rejects.toThrow();
  });

  it('rejects client idempotency that compares only part of the startRun payload', async () => {
    await expect(verifyClaimedCapabilities(
      () => createIdempotencyLyingHarness({ runReplay: 'partial-payload' }),
    )).rejects.toThrow();
  });

  it('rejects client idempotency that omits forkSession command replay', async () => {
    await expect(verifyClaimedCapabilities(
      () => createIdempotencyLyingHarness({ runReplay: 'full', forkReplay: false }),
    )).rejects.toThrow();
  });

  it('rejects client idempotency that omits restoreSnapshot command replay', async () => {
    await expect(verifyClaimedCapabilities(
      () => createIdempotencyLyingHarness({ runReplay: 'full', restoreReplay: false }),
    )).rejects.toThrow();
  });

  it('rejects an unsupported client-idempotency declaration that silently deduplicates', async () => {
    await expect(verifyClaimedCapabilities(
      () => createCombinedKeyIdempotencyHarness('unsupported'),
    )).rejects.toThrow();
  });

  it('rejects unsupported client idempotency that mutates Run state before conflict', async () => {
    await expect(verifyClaimedCapabilities(
      createUnsupportedIdempotencySideEffectHarness,
    )).rejects.toThrow();
  });

  it('rejects an unsupported per-Session MCP policy that is silently applied', async () => {
    await expect(verifyClaimedCapabilities(createMcpPolicyLyingHarness)).rejects.toThrow();
  });

  it('rejects silently applied MCP policy when generic Session policy is also unsupported', async () => {
    await expect(verifyClaimedCapabilities(
      () => createMcpPolicyLyingHarness('unsupported'),
    )).rejects.toThrow();
  });

  it('rejects MCP policy unsupported errors mislabeled as generic Session policy', async () => {
    await expect(verifyClaimedCapabilities(createWrongMcpCapabilityErrorHarness)).rejects.toThrow();
  });

  it('requires snapshotRestore capability failure before malformed snapshot validation', async () => {
    await expect(verifyClaimedCapabilities(
      createSnapshotValidationFirstLyingHarness,
    )).rejects.toThrow();
  });

  it('accepts event replay without streaming text or typed failures', async () => {
    await expect(verifyClaimedCapabilities(
      createReplayOnlyCapabilityHarness,
    )).resolves.toBeUndefined();
  });

  it('accepts cancellation without event replay', async () => {
    await expect(verifyClaimedCapabilities(
      () => createNoReplayCapabilityHarness({
        cancellation: 'native',
        exactlyOneTerminalEvent: 'unsupported',
        rejectSecondSubscription: false,
      }),
    )).resolves.toBeUndefined();
  });

  it('accepts exactly-one-terminal enforcement without event replay', async () => {
    await expect(verifyClaimedCapabilities(
      () => createNoReplayCapabilityHarness({
        cancellation: 'unsupported',
        exactlyOneTerminalEvent: 'native',
        rejectSecondSubscription: true,
      }),
    )).resolves.toBeUndefined();
  });

  it('declares the exact truthful capability matrix and satisfies the shared suite', async () => {
    const probe = await createFakeHarness();
    try {
      expect((await probe.adapter.describe(contractBinding)).capabilities).toEqual({
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
      });
    } finally {
      await probe.dispose();
    }
    await verifyClaimedCapabilities(createFakeHarness);
  });

  it('isolates both binding dimensions and returns deep-cloned session data', async () => {
    const runtime = new DeterministicFakeRuntime();
    const context = [{
      canvasContextRefId: 'context-a',
      scope: 'session' as const,
      visibility: 'private' as const,
      content: { nested: { value: 'original' } },
      provenance: { source: 'test' },
    }];
    const source = await runtime.createSession({
      commandId: 'create-isolated-source',
      binding: contractBinding,
      canvasSessionId: 'session-isolated-source',
      model,
      toolPolicy,
      context,
    });
    context[0]!.content.nested.value = 'mutated-after-create';
    source.metadata.canvasSessionId = 'mutated-result';

    await expectError(runtime.loadSession({
      commandId: 'load-wrong-isolation',
      binding: bindingWithSameAgent,
      canvasSessionId: 'session-isolated-source',
      externalSessionRef: source.externalSessionRef,
    }), 'session_ownership_mismatch');
    expect((await runtime.listSessions({ binding: bindingWithSameAgent })).sessions).toEqual([]);

    const loaded = await runtime.loadSession({
      commandId: 'load-correct-isolation',
      binding: contractBinding,
      canvasSessionId: 'session-isolated-source',
      externalSessionRef: source.externalSessionRef,
    });
    expect(loaded.metadata.canvasSessionId).toBe('session-isolated-source');
    loaded.metadata.canvasSessionId = 'mutated-load';
    expect((await runtime.loadSession({
      commandId: 'load-correct-isolation-again',
      binding: contractBinding,
      canvasSessionId: 'session-isolated-source',
      externalSessionRef: source.externalSessionRef,
    })).metadata.canvasSessionId).toBe('session-isolated-source');
  });

  it('validates all model-bearing operations before mutation and rejects ID conflicts', async () => {
    const runtime = new DeterministicFakeRuntime();
    const unavailable = { providerKey: 'fake', modelKey: 'missing' };
    await expectError(create(runtime, 'invalid-model', contractBinding, unavailable), 'model_not_available');
    expect((await runtime.listSessions({ binding: contractBinding })).sessions).toHaveLength(0);

    const parent = await create(runtime, 'conflict');
    await expectError(runtime.createSession({
      commandId: 'create-conflict-duplicate',
      binding: contractBinding,
      canvasSessionId: 'session-conflict',
      model,
      toolPolicy,
      context: [],
    }), 'transcript_conflict');

    await expectError(runtime.startRun({
      commandId: 'start-invalid-model',
      idempotencyKey: 'invalid-model',
      binding: contractBinding,
      canvasRunId: 'run-invalid-model',
      canvasSessionId: 'session-conflict',
      externalSessionRef: parent.externalSessionRef,
      expectedHistoryDigest: parent.historyDigest!,
      prompt: { canvasMessageId: 'message-invalid-model', role: 'user', content: 'unchanged' },
      model: unavailable,
      toolPolicy,
      context: [],
    }), 'model_not_available');
    expect((await runtime.loadSession({
      commandId: 'load-after-invalid-model',
      binding: contractBinding,
      canvasSessionId: 'session-conflict',
      externalSessionRef: parent.externalSessionRef,
    })).historyDigest).toBe(parent.historyDigest);

    await expectError(runtime.startRun({
      commandId: 'start-uncloneable-context',
      idempotencyKey: 'uncloneable-context',
      binding: contractBinding,
      canvasRunId: 'run-uncloneable-context',
      canvasSessionId: 'session-conflict',
      externalSessionRef: parent.externalSessionRef,
      expectedHistoryDigest: parent.historyDigest!,
      prompt: { canvasMessageId: 'message-uncloneable-context', role: 'user', content: 'unchanged' },
      model,
      toolPolicy,
      context: [{
        canvasContextRefId: 'context-uncloneable',
        scope: 'run',
        visibility: 'private',
        content: { uncloneable: () => 'function' },
        provenance: {},
      }],
    }), 'context_rejected');
    expect((await runtime.loadSession({
      commandId: 'load-after-uncloneable-context',
      binding: contractBinding,
      canvasSessionId: 'session-conflict',
      externalSessionRef: parent.externalSessionRef,
    })).historyDigest).toBe(parent.historyDigest);

    await expectError(runtime.startRun({
      commandId: 'start-malformed-prompt',
      idempotencyKey: 'malformed-prompt',
      binding: contractBinding,
      canvasRunId: 'run-malformed-prompt',
      canvasSessionId: 'session-conflict',
      externalSessionRef: parent.externalSessionRef,
      expectedHistoryDigest: parent.historyDigest!,
      prompt: {
        canvasMessageId: 'message-malformed-prompt',
        role: {
          toString: () => {
            throw new Error('must not escape validation');
          },
        } as never,
        content: 'unchanged',
      },
      model,
      toolPolicy,
      context: [],
    }), 'transcript_conflict');
    expect((await runtime.loadSession({
      commandId: 'load-after-malformed-prompt',
      binding: contractBinding,
      canvasSessionId: 'session-conflict',
      externalSessionRef: parent.externalSessionRef,
    })).historyDigest).toBe(parent.historyDigest);

    const run = await start(runtime, parent, 'conflict');
    await expectError(runtime.startRun({
      commandId: 'start-conflict-different-run',
      idempotencyKey: 'idempotency-conflict-different-run',
      binding: contractBinding,
      canvasRunId: 'run-conflict-different-run',
      canvasSessionId: 'session-conflict',
      externalSessionRef: parent.externalSessionRef,
      expectedHistoryDigest: parent.historyDigest!,
      prompt: {
        canvasMessageId: 'message-conflict-different-run',
        role: 'user',
        content: 'must be blocked by the active-run guard',
      },
      model,
      toolPolicy,
      context: [],
    }), 'session_busy');
    await collect(eventsFor(runtime, parent, run, 'conflict'));
  });

  it('keeps concurrent transcripts separate and releases the active-run guard at terminal', async () => {
    const runtime = new DeterministicFakeRuntime();
    const first = await create(runtime, 'concurrent-first');
    const second = await create(runtime, 'concurrent-second');
    const firstRun = await start(runtime, first, 'concurrent-first', { owner: 'first' });
    const secondRun = await start(runtime, second, 'concurrent-second', { owner: 'second' });
    const firstEvents = await collect(eventsFor(runtime, first, firstRun, 'concurrent-first'));
    const secondEvents = await collect(eventsFor(runtime, second, secondRun, 'concurrent-second'));
    expect(firstEvents.every((event) => event.canvasSessionId === 'session-concurrent-first')).toBe(true);
    expect(secondEvents.every((event) => event.canvasSessionId === 'session-concurrent-second')).toBe(true);

    const firstLoaded = await runtime.loadSession({
      commandId: 'load-concurrent-first',
      binding: contractBinding,
      canvasSessionId: 'session-concurrent-first',
      externalSessionRef: first.externalSessionRef,
    });
    const nextRun = await start(runtime, firstLoaded, 'concurrent-first-next');
    expect(terminal(await collect(eventsFor(runtime, firstLoaded, nextRun, 'concurrent-first-next')))).toHaveLength(1);
  });

  it('gives interleaved stream subscribers independent complete cursors with stable event IDs', async () => {
    const runtime = new DeterministicFakeRuntime();
    const session = await create(runtime, 'interleaved-streams');
    const run = await start(runtime, session, 'interleaved-streams');
    const first = eventsFor(runtime, session, run, 'interleaved-streams')[Symbol.asyncIterator]();
    const second = eventsFor(runtime, session, run, 'interleaved-streams')[Symbol.asyncIterator]();
    const firstEvents: RuntimeEvent[] = [];
    const secondEvents: RuntimeEvent[] = [];

    for (let index = 0; index < 10; index += 1) {
      const firstNext = await first.next();
      const secondNext = await second.next();
      if (!firstNext.done) firstEvents.push(firstNext.value);
      if (!secondNext.done) secondEvents.push(secondNext.value);
      if (firstNext.done && secondNext.done) break;
    }

    expect(firstEvents).toHaveLength(6);
    expect(secondEvents).toHaveLength(6);
    expect(secondEvents.map((event) => event.eventId)).toEqual(
      firstEvents.map((event) => event.eventId),
    );
    expect(new Set(firstEvents.map((event) => event.eventId)).size).toBe(6);
  });

  it('snapshots stream input at call time before a paused iterator can observe caller mutation', async () => {
    const runtime = new DeterministicFakeRuntime();
    const session = await create(runtime, 'stream-input-snapshot');
    const run = await start(runtime, session, 'stream-input-snapshot');
    const mutableBinding = { ...contractBinding };
    const stream = runtime.streamRunEvents({
      binding: mutableBinding,
      canvasRunId: 'run-stream-input-snapshot',
      externalRunRef: run.externalRunRef,
    });
    const iterator = stream[Symbol.asyncIterator]();
    mutableBinding.isolationKey = 'mutated-after-stream-call';

    const events = await collect({
      [Symbol.asyncIterator]: () => iterator,
    });
    expect(events).toHaveLength(6);
    expect(terminal(events).map((event) => event.type)).toEqual(['run.completed']);
    const loaded = await runtime.loadSession({
      commandId: 'load-stream-input-snapshot',
      binding: contractBinding,
      canvasSessionId: 'session-stream-input-snapshot',
      externalSessionRef: session.externalSessionRef,
    });
    const snapshot = await runtime.exportSnapshot({
      commandId: 'export-stream-input-snapshot',
      binding: contractBinding,
      canvasSessionId: 'session-stream-input-snapshot',
      externalSessionRef: loaded.externalSessionRef,
    });
    expect((snapshot.payload as RuntimeTranscriptMessage[]).at(-1)).toMatchObject({
      role: 'assistant',
      content: 'fake fake ',
    });
  });

  it('invalidates a paused iterator when shutdown returns without emitting a late terminal', async () => {
    const runtime = new DeterministicFakeRuntime();
    const session = await create(runtime, 'shutdown-stream');
    const run = await start(runtime, session, 'shutdown-stream');
    const iterator = eventsFor(
      runtime,
      session,
      run,
      'shutdown-stream',
    )[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toMatchObject({ done: false, value: { type: 'run.accepted' } });

    await runtime.shutdown({ binding: contractBinding, reason: 'test' });
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'runtime_unavailable',
      operationEffect: 'not-applied',
    });
    expect(first.done ? [] : terminal([first.value])).toEqual([]);
    await runtime.shutdown({ binding: contractBinding, reason: 'test' });
  });

  it('replays an immutable stable ledger and rejects wrong run references without effects', async () => {
    const runtime = new DeterministicFakeRuntime();
    const session = await create(runtime, 'ledger');
    const run = await start(runtime, session, 'ledger');
    const firstPass = await collect(eventsFor(runtime, session, run, 'ledger'));
    expect(firstPass.filter((event) => event.type === 'model.output.delta').map((event) => event.text)).toEqual([
      'fake ',
      'fake ',
    ]);
    const originalFirstId = firstPass[0]!.eventId;
    firstPass[0]!.eventId = 'consumer-mutated-id';
    if (firstPass[2]?.type === 'model.output.delta') firstPass[2].text = 'consumer mutation';

    const replay = await collect(eventsFor(runtime, session, run, 'ledger'));
    expect(replay[0]!.eventId).toBe(originalFirstId);
    expect(replay.filter((event) => event.type === 'model.output.delta').map((event) => event.text)).toEqual([
      'fake ',
      'fake ',
    ]);
    expect(replay.map((event) => event.eventId)).toEqual((await collect(eventsFor(runtime, session, run, 'ledger'))).map((event) => event.eventId));

    await expectError(collect(runtime.streamRunEvents({
      binding: contractBinding,
      canvasRunId: 'run-ledger',
      externalRunRef: 'wrong-external-run',
    })), 'run_not_found');
    await expectError(collect(runtime.streamRunEvents({
      binding: bindingWithSameAgent,
      canvasRunId: 'run-ledger',
      externalRunRef: run.externalRunRef,
    })), 'session_ownership_mismatch');
    await expectError(runtime.cancelRun({
      commandId: 'cancel-wrong-binding',
      binding: bindingWithSameAgent,
      canvasRunId: 'run-ledger',
      externalRunRef: run.externalRunRef,
    }), 'session_ownership_mismatch');
    await expectError(runtime.cancelRun({
      commandId: 'cancel-wrong-run-ref',
      binding: contractBinding,
      canvasRunId: 'run-ledger',
      externalRunRef: 'wrong-external-run',
    }), 'run_not_found');
    await expectError(runtime.exportSnapshot({
      commandId: 'export-wrong-binding',
      binding: bindingWithSameAgent,
      canvasSessionId: 'session-ledger',
      externalSessionRef: session.externalSessionRef,
    }), 'session_ownership_mismatch');
    await expectError(collect(runtime.streamRunEvents({
      binding: contractBinding,
      canvasRunId: 'run-ledger',
      externalRunRef: run.externalRunRef,
      afterExternalEventRef: 'unknown-ledger-cursor',
    })), 'protocol_error');
  });

  it('cancels before streaming, after a delta, and after message completion without resurrection', async () => {
    const runtime = new DeterministicFakeRuntime();

    const before = await create(runtime, 'cancel-before');
    const beforeRun = await start(runtime, before, 'cancel-before');
    expect((await runtime.cancelRun({
      commandId: 'cancel-before',
      binding: contractBinding,
      canvasRunId: 'run-cancel-before',
      externalRunRef: beforeRun.externalRunRef,
    })).outcome).toBe('accepted');
    expect((await runtime.cancelRun({
      commandId: 'cancel-before-repeat',
      binding: contractBinding,
      canvasRunId: 'run-cancel-before',
      externalRunRef: beforeRun.externalRunRef,
    })).outcome).toBe('accepted');
    const beforeEvents = await collect(eventsFor(runtime, before, beforeRun, 'cancel-before'));
    expect(terminal(beforeEvents).map((event) => event.type)).toEqual(['run.cancelled']);

    const deltaSession = await create(runtime, 'cancel-delta');
    const deltaRun = await start(runtime, deltaSession, 'cancel-delta');
    const emittedDelta = await collectThrough(
      eventsFor(runtime, deltaSession, deltaRun, 'cancel-delta'),
      'model.output.delta',
    );
    const deltaSnapshot = structuredClone(emittedDelta);
    const deltaCursor = emittedDelta.at(-1)!.externalEventRef!;
    await runtime.cancelRun({
      commandId: 'cancel-delta',
      binding: contractBinding,
      canvasRunId: 'run-cancel-delta',
      externalRunRef: deltaRun.externalRunRef,
    });
    const afterDelta = await collect(runtime.streamRunEvents({
      binding: contractBinding,
      canvasRunId: 'run-cancel-delta',
      externalRunRef: deltaRun.externalRunRef,
      afterExternalEventRef: deltaCursor,
    }));
    expect(emittedDelta).toEqual(deltaSnapshot);
    expect(afterDelta.some((event) => event.type === 'message.completed')).toBe(false);
    expect(terminal(afterDelta).map((event) => event.type)).toEqual(['run.cancelled']);

    const messageSession = await create(runtime, 'cancel-message');
    const messageRun = await start(runtime, messageSession, 'cancel-message');
    const throughMessage = await collectThrough(
      eventsFor(runtime, messageSession, messageRun, 'cancel-message'),
      'message.completed',
    );
    const messageCursor = throughMessage.at(-1)!.externalEventRef!;
    await runtime.cancelRun({
      commandId: 'cancel-message',
      binding: contractBinding,
      canvasRunId: 'run-cancel-message',
      externalRunRef: messageRun.externalRunRef,
    });
    const afterMessage = await collect(runtime.streamRunEvents({
      binding: contractBinding,
      canvasRunId: 'run-cancel-message',
      externalRunRef: messageRun.externalRunRef,
      afterExternalEventRef: messageCursor,
    }));
    expect(terminal(afterMessage).map((event) => event.type)).toEqual(['run.cancelled']);
    expect((await runtime.cancelRun({
      commandId: 'cancel-message-terminal',
      binding: contractBinding,
      canvasRunId: 'run-cancel-message',
      externalRunRef: messageRun.externalRunRef,
    }))).toMatchObject({ outcome: 'already-terminal', observedTerminal: 'cancelled' });
  });

  it('forks exact prefixes with lineage only after every validation succeeds', async () => {
    const runtime = new DeterministicFakeRuntime();
    const parent = await create(runtime, 'fork-parent');
    const firstRun = await start(runtime, parent, 'fork-first', 'first');
    await collect(eventsFor(runtime, parent, firstRun, 'fork-first'));
    const afterFirst = await runtime.loadSession({
      commandId: 'load-fork-after-first',
      binding: contractBinding,
      canvasSessionId: 'session-fork-parent',
      externalSessionRef: parent.externalSessionRef,
    });
    const secondRun = await start(runtime, afterFirst, 'fork-second', 'second');
    await collect(eventsFor(runtime, parent, secondRun, 'fork-second'));
    const current = await runtime.loadSession({
      commandId: 'load-fork-current',
      binding: contractBinding,
      canvasSessionId: 'session-fork-parent',
      externalSessionRef: parent.externalSessionRef,
    });
    const prefix: RuntimeTranscriptMessage[] = [{
      canvasMessageId: 'message-fork-first',
      role: 'user',
      content: 'first',
    }];
    const baseInput = {
      commandId: 'fork-child',
      binding: contractBinding,
      parentCanvasSessionId: 'session-fork-parent',
      parentExternalSessionRef: parent.externalSessionRef,
      childCanvasSessionId: 'session-fork-child',
      atCanvasMessageId: 'message-fork-first',
      sourceRevisionId: 'revision-fork',
      expectedParentHistoryDigest: current.historyDigest!,
      transcriptPrefixDigest: digestRuntimeTranscript(prefix),
      transcriptPrefix: prefix,
      model,
      toolPolicy,
      context: [],
    };
    await expectError(runtime.forkSession({
      ...baseInput,
      commandId: 'fork-child-wrong-binding',
      binding: bindingWithSameAgent,
    }), 'session_ownership_mismatch');
    await expectError(runtime.forkSession({
      ...baseInput,
      commandId: 'fork-child-invalid-prefix',
      transcriptPrefix: [{ ...prefix[0]!, content: 'tampered' }],
    }), 'transcript_conflict');
    expect((await runtime.listSessions({ binding: contractBinding })).sessions).toHaveLength(1);

    const child = await runtime.forkSession(baseInput);
    expect(child.lineage).toEqual({
      parentCanvasSessionId: 'session-fork-parent',
      atCanvasMessageId: 'message-fork-first',
      sourceRevisionId: 'revision-fork',
      transcriptPrefixDigest: digestRuntimeTranscript(prefix),
    });
    expect(child.historyDigest).toBe(digestRuntimeTranscript(prefix));

    const parentSnapshot = await runtime.exportSnapshot({
      commandId: 'export-fork-parent-head',
      binding: contractBinding,
      canvasSessionId: 'session-fork-parent',
      externalSessionRef: parent.externalSessionRef,
    });
    const headPrefix = parentSnapshot.payload as RuntimeTranscriptMessage[];
    const headChild = await runtime.forkSession({
      ...baseInput,
      commandId: 'fork-head-child',
      childCanvasSessionId: 'session-fork-head-child',
      atCanvasMessageId: headPrefix.at(-1)!.canvasMessageId,
      transcriptPrefix: headPrefix,
      transcriptPrefixDigest: digestRuntimeTranscript(headPrefix),
    });
    expect(headChild.historyDigest).toBe(current.historyDigest);
    expect(headChild.lineage?.atCanvasMessageId).toBe(headPrefix.at(-1)!.canvasMessageId);

    prefix[0]!.content = 'mutated outside';
    const childSnapshot = await runtime.exportSnapshot({
      commandId: 'export-fork-child',
      binding: contractBinding,
      canvasSessionId: 'session-fork-child',
      externalSessionRef: child.externalSessionRef,
    });
    expect(childSnapshot.payload).toEqual([{
      canvasMessageId: 'message-fork-first',
      role: 'user',
      content: 'first',
    }]);

    const childRun = await start(runtime, child, 'fork-child-run');
    await collect(eventsFor(runtime, child, childRun, 'fork-child-run'));
    expect((await runtime.loadSession({
      commandId: 'load-parent-after-child-run',
      binding: contractBinding,
      canvasSessionId: 'session-fork-parent',
      externalSessionRef: parent.externalSessionRef,
    })).historyDigest).toBe(current.historyDigest);
  });

  it('validates and deep-clones snapshots without leaving partial sessions', async () => {
    const runtime = new DeterministicFakeRuntime();
    const source = await create(runtime, 'snapshot-source');
    const run = await start(runtime, source, 'snapshot-source', { nested: ['original'] });
    await collect(eventsFor(runtime, source, run, 'snapshot-source'));
    const snapshot = await runtime.exportSnapshot({
      commandId: 'export-snapshot-source',
      binding: contractBinding,
      canvasSessionId: 'session-snapshot-source',
      externalSessionRef: source.externalSessionRef,
    });
    const exportedPayload = snapshot.payload as RuntimeTranscriptMessage[];
    (exportedPayload[0]!.content as { nested: string[] }).nested[0] = 'mutated-export';
    const freshSnapshot = await runtime.exportSnapshot({
      commandId: 'export-snapshot-source-fresh',
      binding: contractBinding,
      canvasSessionId: 'session-snapshot-source',
      externalSessionRef: source.externalSessionRef,
    });
    expect(((freshSnapshot.payload as RuntimeTranscriptMessage[])[0]!.content as { nested: string[] }).nested[0]).toBe('original');

    const restored = await runtime.restoreSnapshot({
      commandId: 'restore-snapshot',
      binding: contractBinding,
      canvasSessionId: 'session-snapshot-restored',
      model,
      toolPolicy,
      context: [],
      snapshot: freshSnapshot,
    });
    (freshSnapshot.payload as RuntimeTranscriptMessage[])[0]!.content = 'mutated-after-restore';
    expect((await runtime.exportSnapshot({
      commandId: 'export-snapshot-restored',
      binding: contractBinding,
      canvasSessionId: 'session-snapshot-restored',
      externalSessionRef: restored.externalSessionRef,
    })).payload).not.toEqual(freshSnapshot.payload);

    await expectError(runtime.exportSnapshot({
      commandId: 'export-wrong-canvas',
      binding: contractBinding,
      canvasSessionId: 'wrong-canvas-session',
      externalSessionRef: source.externalSessionRef,
    }), 'session_ownership_mismatch');

    const invalidSnapshots: RuntimeSnapshot[] = [
      { format: 'wrong', version: '1', payload: [] },
      { format: 'fake-json', version: '2', payload: [] },
      { format: 'fake-json', version: '1', payload: [{ canvasMessageId: 'bad', role: 'invalid', content: 'x' }] },
      { format: 'fake-json', version: '1', payload: [{ canvasMessageId: 'bad', role: 'user' }] },
      { format: 'fake-json', version: '1', payload: [{ canvasMessageId: 'bad', role: 'user', content: undefined }] },
      { format: 'fake-json', version: '1', payload: new Array(1) },
    ];
    const countBeforeInvalid = (await runtime.listSessions({ binding: contractBinding })).sessions.length;
    for (const [index, invalid] of invalidSnapshots.entries()) {
      await expectError(runtime.restoreSnapshot({
        commandId: `restore-invalid-${index}`,
        binding: contractBinding,
        canvasSessionId: `session-invalid-${index}`,
        model,
        toolPolicy,
        context: [],
        snapshot: invalid,
      }), 'protocol_error');
    }
    expect((await runtime.listSessions({ binding: contractBinding })).sessions).toHaveLength(countBeforeInvalid);
  });

  it('throws exact capability errors and clears only the complete binding on shutdown', async () => {
    const runtime = new DeterministicFakeRuntime();
    const first = await create(runtime, 'shutdown-first');
    const second = await create(runtime, 'shutdown-second', bindingWithSameAgent);
    await expect(runtime.respondToApproval({
      commandId: 'unsupported-approval',
      binding: contractBinding,
      canvasRunId: 'run-missing',
      approvalRef: 'approval-missing',
      decision: 'deny',
    })).rejects.toEqual(new RuntimeCapabilityError('toolApproval'));
    await expect(runtime.setSessionModel({
      commandId: 'unsupported-model',
      binding: contractBinding,
      canvasSessionId: 'session-shutdown-first',
      externalSessionRef: first.externalSessionRef,
      model,
      expectedIdle: true,
    })).rejects.toMatchObject({ capability: 'sessionModelSwitch', operationEffect: 'not-applied' });
    await expect(runtime.setSessionModel({
      commandId: 'unsupported-invalid-model',
      binding: contractBinding,
      canvasSessionId: 'session-shutdown-first',
      externalSessionRef: first.externalSessionRef,
      model: { providerKey: 'fake', modelKey: 'missing' },
      expectedIdle: true,
    })).rejects.toMatchObject({
      capability: 'sessionModelSwitch',
      code: 'protocol_error',
      operationEffect: 'not-applied',
    });
    await expect(runtime.setSessionToolPolicy({
      commandId: 'unsupported-policy',
      binding: contractBinding,
      canvasSessionId: 'session-shutdown-first',
      externalSessionRef: first.externalSessionRef,
      toolPolicy,
      expectedIdle: true,
    })).rejects.toMatchObject({ capability: 'sessionToolPolicy', operationEffect: 'not-applied' });

    await runtime.shutdown({ binding: contractBinding, reason: 'test' });
    await runtime.shutdown({ binding: contractBinding, reason: 'test' });
    await expectError(runtime.loadSession({
      commandId: 'load-cleared-binding',
      binding: contractBinding,
      canvasSessionId: 'session-shutdown-first',
      externalSessionRef: first.externalSessionRef,
    }), 'session_not_found');
    expect((await runtime.loadSession({
      commandId: 'load-preserved-binding',
      binding: bindingWithSameAgent,
      canvasSessionId: 'session-shutdown-second',
      externalSessionRef: second.externalSessionRef,
    })).externalSessionRef).toBe(second.externalSessionRef);
  });
});

# Agent Session Control Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first server-owned Agent/Session/Run foundation with a deterministic FakeRuntime, PostgreSQL persistence, anchor-based session forking, ordered run events, and API contract tests, without coupling the UI to Hermes.

**Architecture:** `packages/core` owns pure domain schemas and state transitions; `packages/ai` owns the runtime-neutral contract and deterministic fake implementation; `packages/db` owns Drizzle tables and repositories; a new `packages/control-plane` coordinates authorization, persistence, and RuntimeAdapter calls. Next.js routes expose the application service, while the existing localStorage canvas remains unchanged until this foundation passes its Golden Path.

**Tech Stack:** Node.js 24, pnpm 11, TypeScript 6, Zod 4, PostgreSQL 18, Drizzle ORM, Next.js 16 App Router, Vitest 4, Docker Compose.

---

## Scope and file map

This plan implements roadmap stage S1 only. It does not implement Hermes, Letta, authentication UI, or the final Chat block.

S1 accepts `anchor-trunk` and `fork-message` only. `fork-artifact` stays disabled until S4 creates Artifact/ArtifactRevision tables and their lineage foreign keys; S1 must reject it at Zod and database CHECK boundaries.

```text
packages/core/src/agent-session/
├── schemas.ts                 # IDs, states, commands, snapshots
├── transitions.ts             # Run and growth state invariants
├── transitions.test.ts
└── index.ts
packages/ai/src/runtime/
├── contract.ts                # RuntimeAdapter and normalized events
├── deterministic-fake.ts      # Contract reference implementation
├── contract-suite.ts          # Reusable adapter tests
├── deterministic-fake.test.ts
└── index.ts
packages/db/src/schema/
├── enums.ts
├── identity.ts
├── workflows.ts
├── execution.ts
├── authorization.ts
├── audit.ts
├── relations.ts
└── index.ts
packages/db/src/repositories/
├── control-plane-repository.ts
├── postgres-control-plane-repository.ts
└── postgres-control-plane-repository.integration.test.ts
packages/control-plane/
├── package.json
├── tsconfig.json
└── src/
    ├── session-service.ts
    ├── session-service.test.ts
    ├── run-event-pump.ts
    ├── run-event-pump.test.ts
    └── index.ts
apps/web/src/app/api/control-plane/
├── bootstrap/route.ts
├── workflows/[workflowId]/sessions/anchor/route.ts
├── sessions/route.ts
├── sessions/[sessionId]/fork/route.ts
├── sessions/[sessionId]/runs/route.ts
├── runs/[runId]/events/route.ts
├── runs/[runId]/cancel/route.ts
└── route-contract.test.ts
compose.control-plane-test.yaml # Standalone, no-port, disposable S1 test project
```

Safety rule: every destructive database command in this plan targets Compose project `ai-super-canvas-s1-test`, service `postgres-test`, database `canvas_s1_test`, and a project-scoped unnamed volume. It must never merge with `compose.yaml` or reference `ai-super-canvas-postgres`.

Architecture references:

- `docs/architecture/agent-session-domain-model.md`
- `docs/architecture/postgres-schema.md`
- `docs/architecture/runtime-adapter-contract.md`

### Task 1: Add domain schemas and transition invariants

**Files:**
- Create: `packages/core/src/agent-session/schemas.ts`
- Create: `packages/core/src/agent-session/transitions.ts`
- Create: `packages/core/src/agent-session/transitions.test.ts`
- Create: `packages/core/src/agent-session/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing transition and fork command tests**

```ts
// packages/core/src/agent-session/transitions.test.ts
import { describe, expect, it } from 'vitest';
import {
  CreateBranchSessionCommandSchema,
  assertGrowthTransition,
  assertRunTransition,
} from './index';

describe('agent-session invariants', () => {
  it('accepts valid run transitions and rejects terminal resurrection', () => {
    expect(() => assertRunTransition('queued', 'running')).not.toThrow();
    expect(() => assertRunTransition('running', 'waiting_approval')).not.toThrow();
    expect(() => assertRunTransition('waiting_approval', 'running')).not.toThrow();
    expect(() => assertRunTransition('running', 'reconciling')).not.toThrow();
    expect(() => assertRunTransition('reconciling', 'failed')).not.toThrow();
    expect(() => assertRunTransition('running', 'succeeded')).not.toThrow();
    expect(() => assertRunTransition('cancelled', 'succeeded')).toThrowError(
      'Invalid run transition: cancelled -> succeeded',
    );
  });

  it('keeps metabolized branches terminal', () => {
    expect(() => assertGrowthTransition('active', 'dormant')).not.toThrow();
    expect(() => assertGrowthTransition('dormant', 'active')).not.toThrow();
    expect(() => assertGrowthTransition('active', 'metabolized')).not.toThrow();
    expect(() => assertGrowthTransition('metabolized', 'active')).toThrowError(
      'Invalid growth transition: metabolized -> active',
    );
  });

  it('requires a stable message, revision and text quote for message fork', () => {
    const command = CreateBranchSessionCommandSchema.parse({
      kind: 'fork-message',
      commandId: '22222222-2222-4222-8222-222222222222',
      workflowId: '33333333-3333-4333-8333-333333333333',
      parentSessionId: '44444444-4444-4444-8444-444444444444',
      atMessageId: '55555555-5555-4555-8555-555555555555',
      sourceRevisionId: '66666666-6666-4666-8666-666666666666',
      title: '从关键句生长的新会话',
      anchor: {
        sourceKind: 'message',
        sourceId: '55555555-5555-4555-8555-555555555555',
        selector: {
          kind: 'text-quote',
          exact: '每个 Chat 块是一个 Session',
          startCodePoint: 0,
          endCodePoint: 23,
        },
      },
    });

    expect(command.anchor.selector.exact).toContain('Session');
    expect(() => CreateBranchSessionCommandSchema.parse({ ...command, atMessageId: '' })).toThrow();
    expect(() => CreateBranchSessionCommandSchema.parse({
      ...command,
      anchor: {
        ...command.anchor,
        sourceId: '77777777-7777-4777-8777-777777777777',
      },
    })).toThrowError('message anchor must reference atMessageId');
    expect(() => CreateBranchSessionCommandSchema.parse({
      ...command,
      anchor: { ...command.anchor, selector: { ...command.anchor.selector, endCodePoint: undefined } },
    })).toThrowError('startCodePoint and endCodePoint must be provided together');
  });

  it('represents a trunk anchor without fake parent/message fields', () => {
    const command = CreateBranchSessionCommandSchema.parse({
      kind: 'anchor-trunk',
      commandId: '26262626-2626-4626-8626-262626262626',
      workflowId: '33333333-3333-4333-8333-333333333333',
      sourceRevisionId: '66666666-6666-4666-8666-666666666666',
      agentBindingId: '77777777-7777-4777-8777-777777777777',
      title: '从主干生长',
      anchor: {
        sourceKind: 'trunk-revision',
        sourceId: '66666666-6666-4666-8666-666666666666',
        selector: { kind: 'text-quote', exact: '关键主干句' },
      },
    });
    expect(command.kind).toBe('anchor-trunk');
    expect('parentSessionId' in command).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest run packages/core/src/agent-session/transitions.test.ts
```

Expected: FAIL because `packages/core/src/agent-session/index.ts` does not exist.

- [ ] **Step 3: Implement exact domain schemas**

```ts
// packages/core/src/agent-session/schemas.ts
import { z } from 'zod';

export const CanvasIdSchema = z.string().uuid();
export const ActorContextSchema = z.object({
  accountId: CanvasIdSchema,
  authSubject: z.string().trim().min(1),
});
export const GrowthStateSchema = z.enum(['active', 'dormant', 'metabolized']);
export const SessionStatusSchema = z.enum([
  'provisioning',
  'active',
  'dormant',
  'closed',
  'archived',
  'error',
]);
export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'reconciling',
  'succeeded',
  'failed',
  'cancelled',
]);

export const TextQuoteSelectorSchema = z.object({
  kind: z.literal('text-quote'),
  exact: z.string().min(1),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  startCodePoint: z.number().int().nonnegative().optional(),
  endCodePoint: z.number().int().positive().optional(),
}).superRefine((selector, context) => {
  if ((selector.startCodePoint === undefined) !== (selector.endCodePoint === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'startCodePoint and endCodePoint must be provided together',
    });
  }
  if (
    selector.startCodePoint !== undefined
    && selector.endCodePoint !== undefined
    && selector.endCodePoint <= selector.startCodePoint
  ) {
    context.addIssue({
      code: 'custom',
      message: 'endCodePoint must be greater than startCodePoint',
    });
  }
});

const CommandBaseSchema = z.object({
  commandId: CanvasIdSchema,
  workflowId: CanvasIdSchema,
  sourceRevisionId: CanvasIdSchema,
  title: z.string().trim().min(1).max(160),
});

export const ForkMessageSessionCommandSchema = CommandBaseSchema.extend({
  kind: z.literal('fork-message'),
  parentSessionId: CanvasIdSchema,
  atMessageId: CanvasIdSchema,
  agentBindingId: CanvasIdSchema.optional(),
  anchor: z.object({
    sourceKind: z.literal('message'),
    sourceId: CanvasIdSchema,
    selector: TextQuoteSelectorSchema,
  }),
});

export const CreateAnchoredSessionCommandSchema = CommandBaseSchema.extend({
  kind: z.literal('anchor-trunk'),
  agentBindingId: CanvasIdSchema,
  anchor: z.object({
    sourceKind: z.literal('trunk-revision'),
    sourceId: CanvasIdSchema,
    selector: TextQuoteSelectorSchema,
  }),
});

export const CreateBranchSessionCommandSchema = z.discriminatedUnion('kind', [
  ForkMessageSessionCommandSchema,
  CreateAnchoredSessionCommandSchema,
]).superRefine((command, context) => {
  if (command.kind === 'anchor-trunk' && command.anchor.sourceId !== command.sourceRevisionId) {
    context.addIssue({ code: 'custom', message: 'trunk anchor must reference sourceRevisionId' });
  }
  if (command.kind === 'fork-message' && command.anchor.sourceId !== command.atMessageId) {
    context.addIssue({ code: 'custom', message: 'message anchor must reference atMessageId' });
  }
});

export type GrowthState = z.infer<typeof GrowthStateSchema>;
export type ActorContext = z.infer<typeof ActorContextSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type CreateBranchSessionCommand = z.infer<typeof CreateBranchSessionCommandSchema>;
export type ForkMessageSessionCommand = z.infer<typeof ForkMessageSessionCommandSchema>;
```

```ts
// packages/core/src/agent-session/transitions.ts
import type { GrowthState, RunStatus } from './schemas';

const runTransitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'reconciling', 'failed', 'cancelled'],
  running: ['waiting_approval', 'reconciling', 'succeeded', 'failed', 'cancelled'],
  waiting_approval: ['running', 'reconciling', 'failed', 'cancelled'],
  reconciling: ['running', 'waiting_approval', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const growthTransitions: Record<GrowthState, readonly GrowthState[]> = {
  active: ['dormant', 'metabolized'],
  dormant: ['active', 'metabolized'],
  metabolized: [],
};

export function assertRunTransition(current: RunStatus, next: RunStatus): void {
  if (!runTransitions[current].includes(next)) {
    throw new Error(`Invalid run transition: ${current} -> ${next}`);
  }
}

export function assertGrowthTransition(current: GrowthState, next: GrowthState): void {
  if (!growthTransitions[current].includes(next)) {
    throw new Error(`Invalid growth transition: ${current} -> ${next}`);
  }
}
```

```ts
// packages/core/src/agent-session/index.ts
export * from './schemas';
export * from './transitions';
```

Append to `packages/core/src/index.ts`:

```ts
export * from './agent-session';
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
pnpm vitest run packages/core/src/agent-session/transitions.test.ts
pnpm --filter @ai-super-canvas/core typecheck
```

Expected: PASS with four tests and zero TypeScript errors.

- [ ] **Step 5: Commit the domain contract**

```bash
git add packages/core/src/agent-session packages/core/src/index.ts
git commit -m "feat(core): define agent session domain contract"
```

### Task 2: Add the runtime contract and deterministic FakeRuntime

**Files:**
- Create: `packages/ai/src/runtime/contract.ts`
- Create: `packages/ai/src/runtime/deterministic-fake.ts`
- Create: `packages/ai/src/runtime/contract-suite.ts`
- Create: `packages/ai/src/runtime/deterministic-fake.test.ts`
- Create: `packages/ai/src/runtime/index.ts`
- Modify: `packages/ai/src/index.ts`

- [ ] **Step 1: Write the reusable contract suite and failing FakeRuntime test**

```ts
// packages/ai/src/runtime/contract-suite.ts
import { expect } from 'vitest';
import {
  digestRuntimeTranscript,
  type RuntimeAdapter,
  type RuntimeAdapterError,
  type RuntimeBindingContext,
  type RuntimeCapabilities,
  type RuntimeTranscriptMessage,
} from './contract';

export const contractBinding: RuntimeBindingContext = {
  canvasAgentBindingId: '77777777-7777-4777-8777-777777777777',
  isolationKey: 'contract-agent-a',
};
const binding = contractBinding;

export interface RuntimeContractHarness {
  adapter: RuntimeAdapter;
  restartRuntime(): Promise<RuntimeAdapter>;
  crashRuntime(): Promise<RuntimeAdapter>;
  dispose(): Promise<void>;
}

export type RuntimeContractHarnessFactory = () => Promise<RuntimeContractHarness>;

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function expectRuntimeFailure(
  operation: Promise<unknown>,
  expectedCode: RuntimeAdapterError['code'],
  typedFailures: boolean,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  if (typedFailures) expect(caught).toMatchObject({ code: expectedCode });
}

export async function verifyRuntimeContract(runtime: RuntimeAdapter): Promise<void> {
  const descriptor = await runtime.describe(binding);
  const supports = (capability: keyof typeof descriptor.capabilities): boolean =>
    descriptor.capabilities[capability] !== 'unsupported';
  const modelEntry = (await runtime.listModels(binding))[0];
  expect(modelEntry).toBeDefined();
  const model = {
    providerKey: modelEntry!.providerKey,
    modelKey: modelEntry!.modelKey,
  };

  const parent = await runtime.createSession({
    commandId: '88888888-8888-4888-8888-888888888888',
    binding,
    canvasSessionId: '99999999-9999-4999-8999-999999999999',
    model,
    toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
    context: [],
  });

  if (supports('clientIdempotency')) {
    const duplicateParent = await runtime.createSession({
      commandId: '88888888-8888-4888-8888-888888888888',
      binding,
      canvasSessionId: '99999999-9999-4999-8999-999999999999',
      model,
      toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
      context: [],
    });
    expect(duplicateParent.externalSessionRef).toBe(parent.externalSessionRef);
  }

  await expectRuntimeFailure(runtime.loadSession({
    commandId: '29292929-2929-4929-8929-292929292929',
    binding: { canvasAgentBindingId: '30303030-3030-4030-8030-303030303030', isolationKey: 'other' },
    canvasSessionId: '99999999-9999-4999-8999-999999999999',
    externalSessionRef: parent.externalSessionRef,
  }), 'session_ownership_mismatch', supports('typedFailures'));
  await expectRuntimeFailure(runtime.loadSession({
    commandId: '30303030-3030-4030-8030-303030303031',
    binding,
    canvasSessionId: '41414141-4141-4141-8141-414141414141',
    externalSessionRef: parent.externalSessionRef,
  }), 'session_ownership_mismatch', supports('typedFailures'));

  const parentRun = await runtime.startRun({
    commandId: '31313131-3131-4131-8131-313131313131',
    idempotencyKey: 'parent-turn-1',
    binding,
    canvasRunId: '32323232-3232-4232-8232-323232323232',
    canvasSessionId: '99999999-9999-4999-8999-999999999999',
    externalSessionRef: parent.externalSessionRef,
    expectedHistoryDigest: parent.historyDigest!,
    prompt: {
      canvasMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      role: 'user',
      content: 'fork here',
    },
    model,
    toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
    context: [],
  });
  await collectAsync(runtime.streamRunEvents({
    binding,
    canvasRunId: '32323232-3232-4232-8232-323232323232',
    externalRunRef: parentRun.externalRunRef,
  }));

  const loaded = await runtime.loadSession({
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    binding,
    canvasSessionId: '99999999-9999-4999-8999-999999999999',
    externalSessionRef: parent.externalSessionRef,
  });
  expect(loaded.externalSessionRef).toBe(parent.externalSessionRef);
  const listed = await runtime.listSessions({ binding });
  expect(listed.sessions.map((session) => session.externalSessionRef)).toContain(parent.externalSessionRef);

  const prefix: RuntimeTranscriptMessage[] = [{
    canvasMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    role: 'user',
    content: 'fork here',
  }];
  let targetSession = loaded;

  if (supports('forkAtMessage')) {
    await expectRuntimeFailure(runtime.forkSession({
      commandId: '33333333-3333-4333-8333-333333333329',
      binding,
      parentCanvasSessionId: '41414141-4141-4141-8141-414141414141',
      parentExternalSessionRef: parent.externalSessionRef,
      childCanvasSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      atCanvasMessageId: prefix[0]!.canvasMessageId,
      sourceRevisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expectedParentHistoryDigest: loaded.historyDigest!,
      transcriptPrefixDigest: digestRuntimeTranscript(prefix),
      transcriptPrefix: prefix,
      model,
      toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
      context: [],
    }), 'session_ownership_mismatch', supports('typedFailures'));

    await expectRuntimeFailure(runtime.forkSession({
      commandId: '33333333-3333-4333-8333-333333333330',
      binding,
      parentCanvasSessionId: '99999999-9999-4999-8999-999999999999',
      parentExternalSessionRef: parent.externalSessionRef,
      childCanvasSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      atCanvasMessageId: prefix[0]!.canvasMessageId,
      sourceRevisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expectedParentHistoryDigest: 'sha256:wrong',
      transcriptPrefixDigest: digestRuntimeTranscript(prefix),
      transcriptPrefix: prefix,
      model,
      toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
      context: [],
    }), 'history_diverged', supports('typedFailures'));

    const child = await runtime.forkSession({
    commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    binding,
    parentCanvasSessionId: '99999999-9999-4999-8999-999999999999',
    parentExternalSessionRef: parent.externalSessionRef,
    childCanvasSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    atCanvasMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sourceRevisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    expectedParentHistoryDigest: loaded.historyDigest!,
    transcriptPrefixDigest: digestRuntimeTranscript(prefix),
    transcriptPrefix: prefix,
    model,
    toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
    context: [],
  });
    expect(child.externalSessionRef).not.toBe(parent.externalSessionRef);
    expect(child.lineage).toEqual({
      parentCanvasSessionId: parent.metadata.canvasSessionId,
      atCanvasMessageId: prefix[0]!.canvasMessageId,
      sourceRevisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      transcriptPrefixDigest: digestRuntimeTranscript(prefix),
    });
    targetSession = child;
  }

  const run = await runtime.startRun({
    commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    idempotencyKey: 'contract-run-1',
    binding,
    canvasRunId: '11111111-1111-4111-8111-111111111111',
    canvasSessionId: targetSession.metadata.canvasSessionId as string,
    externalSessionRef: targetSession.externalSessionRef,
    expectedHistoryDigest: targetSession.historyDigest!,
    prompt: {
      canvasMessageId: '12121212-1212-4212-8212-121212121212',
      role: 'user',
      content: 'hello runtime',
    },
    model,
    toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
    context: [],
  });

  const events = await collectAsync(runtime.streamRunEvents({
    binding,
    canvasRunId: '11111111-1111-4111-8111-111111111111',
    externalRunRef: run.externalRunRef,
  }));
  expect(events[0]?.type).toBe('run.accepted');
  if (supports('exactlyOneTerminalEvent')) {
    expect(events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toHaveLength(1);
  }
  if (supports('streamingText')) {
    const deltas = events.filter((event) => event.type === 'model.output.delta');
    const completed = events.find((event) => event.type === 'message.completed');
    expect(deltas.map((event) => event.text).join('')).toBe(completed?.content);
  }
  if (supports('eventReplay')) {
    const replayCursor = events[1]!.externalEventRef;
    expect(replayCursor).toBeDefined();
    const replay = await collectAsync(runtime.streamRunEvents({
      binding,
      canvasRunId: '11111111-1111-4111-8111-111111111111',
      externalRunRef: run.externalRunRef,
      afterExternalEventRef: replayCursor!,
    }));
    expect(replay.map((event) => event.eventId)).toEqual(events.slice(2).map((event) => event.eventId));
    await expectRuntimeFailure(collectAsync(runtime.streamRunEvents({
      binding,
      canvasRunId: '11111111-1111-4111-8111-111111111111',
      externalRunRef: run.externalRunRef,
      afterExternalEventRef: 'unknown-cursor',
    })), 'protocol_error', supports('typedFailures'));
  }

  if (supports('cancellation')) {
    const refreshedTarget = await runtime.loadSession({
      commandId: '36363636-3636-4636-8636-363636363636', binding,
      canvasSessionId: targetSession.metadata.canvasSessionId as string,
      externalSessionRef: targetSession.externalSessionRef,
    });
    const cancellable = await runtime.startRun({
    commandId: '34343434-3434-4434-8434-343434343434',
    idempotencyKey: 'contract-cancel-1',
    binding,
    canvasRunId: '35353535-3535-4535-8535-353535353535',
    canvasSessionId: targetSession.metadata.canvasSessionId as string,
    externalSessionRef: targetSession.externalSessionRef,
    expectedHistoryDigest: refreshedTarget.historyDigest!,
    prompt: { canvasMessageId: '37373737-3737-4737-8737-373737373737', role: 'user', content: 'cancel me' },
    model,
    toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
    context: [],
  });
    expect(await runtime.cancelRun({
    commandId: '38383838-3838-4838-8838-383838383838', binding,
    canvasRunId: '35353535-3535-4535-8535-353535353535',
    externalRunRef: cancellable.externalRunRef,
    })).toMatchObject({ outcome: 'accepted' });
    const cancelledEvents = await collectAsync(runtime.streamRunEvents({
    binding, canvasRunId: '35353535-3535-4535-8535-353535353535',
    externalRunRef: cancellable.externalRunRef,
    }));
    expect(cancelledEvents.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toHaveLength(1);
    expect((await runtime.cancelRun({
    commandId: '39393939-3939-4939-8939-393939393939', binding,
    canvasRunId: '35353535-3535-4535-8535-353535353535',
    externalRunRef: cancellable.externalRunRef,
    })).outcome).toBe('already-terminal');
  }
}

type CapabilityTest = (harness: RuntimeContractHarness) => Promise<void>;

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

const unsupportedCapabilityTests: Partial<Record<
  keyof RuntimeCapabilities,
  CapabilityTest
>> = {
  toolApproval: verifyUnsupportedToolApproval,
  sessionModelSwitch: verifyUnsupportedSessionModelSwitch,
  sessionToolPolicy: verifyUnsupportedSessionToolPolicy,
  perSessionMcpPolicy: verifyUnsupportedPerSessionMcpPolicy,
  cancellation: verifyUnsupportedCancellation,
  forkAtMessage: verifyUnsupportedExactMessageFork,
};

export async function verifyClaimedCapabilities(
  createHarness: RuntimeContractHarnessFactory,
): Promise<void> {
  const baseline = await createHarness();
  let capabilities: RuntimeCapabilities;
  try {
    capabilities = (await baseline.adapter.describe(binding)).capabilities;
    await verifyRuntimeContract(baseline.adapter);
  } finally {
    await baseline.dispose();
  }

  for (const capability of Object.keys(capabilities) as Array<keyof RuntimeCapabilities>) {
    const harness = await createHarness();
    try {
      if (capabilities[capability] !== 'unsupported') {
        await capabilityTests[capability](harness);
      } else {
        await unsupportedCapabilityTests[capability]?.(harness);
      }
    } finally {
      await harness.dispose();
    }
  }
}
```

Implement every named helper in `contract-suite.ts`; no helper may be empty. The positive registry is exhaustive at compile time, so adding a capability breaks typecheck until its test exists. Every helper receives a fresh `RuntimeContractHarness` and starts from `harness.adapter`. `verifyPersistentSessions` must create a Session, call `restartRuntime()`, and load it through the returned fresh Adapter; `verifyInFlightResume` must interrupt an active Run with `crashRuntime()`, then prove resume/replay or the declared reconciliation result. A Harness factory owns one isolated worker/storage fixture: `restartRuntime()` performs a controlled process restart without deleting durable state, `crashRuntime()` performs an ungraceful stop, and idempotent `dispose()` waits for process exit and fails the test if sessions, streams, ports or temp resources leak. A positive lifecycle capability is invalid if these methods are stubs. Adapter-specific process control lives only in the Harness, never in the shared domain expectations.

A separate `unsupportedCapabilityTests` registry asserts that callable unsupported operations fail rather than silently degrade; persistence-style flags declared unsupported are not subjected to restart guarantees. For Fake, coverage includes concurrent Session isolation; exact fork digest/lineage; cursor-based event replay with stable IDs; two identical deltas; typed ownership/history failures; cancellation before streaming and after partial delta/message consumption; immutable replay of already-emitted events plus exactly one later cancelled terminal; snapshot deep-clone round-trip plus invalid format/version/payload rejection; and model catalog discovery.

```ts
// packages/ai/src/runtime/deterministic-fake.test.ts
import { describe, expect, it } from 'vitest';
import { DeterministicFakeRuntime } from './deterministic-fake';
import {
  contractBinding,
  type RuntimeContractHarness,
  verifyClaimedCapabilities,
} from './contract-suite';

async function createFakeHarness(): Promise<RuntimeContractHarness> {
  const adapter = new DeterministicFakeRuntime();
  const unsupportedLifecycle = async (): Promise<never> => {
    throw new Error('DeterministicFakeRuntime has no process lifecycle');
  };
  return {
    adapter,
    restartRuntime: unsupportedLifecycle,
    crashRuntime: unsupportedLifecycle,
    dispose: () => adapter.shutdown({ binding: contractBinding, reason: 'test' }),
  };
}

describe('DeterministicFakeRuntime', () => {
  it('satisfies the shared runtime contract', async () => {
    const probe = await createFakeHarness();
    try {
      expect((await probe.adapter.describe(contractBinding)).capabilities).toMatchObject({
        persistentSessions: 'unsupported',
        completedTurnPersistence: 'unsupported',
        inFlightResume: 'unsupported',
        toolApproval: 'unsupported',
        sessionModelSwitch: 'unsupported',
        sessionToolPolicy: 'unsupported',
        perSessionMcpPolicy: 'unsupported',
        clientIdempotency: 'unsupported',
      });
    } finally {
      await probe.dispose();
    }
    await verifyClaimedCapabilities(createFakeHarness);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest run packages/ai/src/runtime/deterministic-fake.test.ts
```

Expected: FAIL because `contract.ts` and `deterministic-fake.ts` do not exist.

- [ ] **Step 3: Implement the runtime contract subset required by S1**

Create `packages/ai/src/runtime/contract.ts` using the exact public types and method signatures from `docs/architecture/runtime-adapter-contract.md`, including every `RuntimeEvent` variant, `RuntimeCancelAck`, and `digestRuntimeTranscript()` using canonical JSON plus SHA-256. The exported `RuntimeAdapter` must contain all methods in that document. An implementation must throw the typed error for every operation it declares unsupported; it may never return success from an empty method.

The capability error is exact:

```ts
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
    super('protocol_error', `Runtime capability is not available: ${capability}`, false, 'not-applied');
    this.name = 'RuntimeCapabilityError';
  }
}
```

- [ ] **Step 4: Implement the deterministic adapter**

```ts
// packages/ai/src/runtime/deterministic-fake.ts
import { randomUUID } from 'node:crypto';
import {
  digestRuntimeTranscript,
  RuntimeAdapterError,
  RuntimeCapabilityError,
} from './contract';
import type {
  CreateRuntimeSessionInput,
  ForkRuntimeSessionInput,
  LoadRuntimeSessionInput,
  RuntimeAdapter,
  RuntimeBindingContext,
  RuntimeCancelAck,
  RuntimeDescriptor,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeModelEntry,
  RuntimeRunRef,
  RuntimeSessionRef,
  RuntimeSnapshot,
  RuntimeTranscriptMessage,
  StartRuntimeRunInput,
} from './contract';

interface FakeSession {
  bindingId: string;
  canvasSessionId: string;
  externalSessionRef: string;
  transcript: RuntimeTranscriptMessage[];
  historyDigest: string;
  lineage?: NonNullable<RuntimeSessionRef['lineage']>;
}

interface FakeRun {
  bindingId: string;
  externalRunRef: string;
  canvasSessionId: string;
  externalSessionRef: string;
  ledger: RuntimeEvent[];
  pending: RuntimeEvent[];
  terminal?: 'succeeded' | 'failed' | 'cancelled';
  cancelRequested: boolean;
  messageMaterialized: boolean;
}

export class DeterministicFakeRuntime implements RuntimeAdapter {
  private readonly sessions = new Map<string, FakeSession>();
  private readonly commandResults = new Map<string, RuntimeSessionRef>();
  private readonly runs = new Map<string, FakeRun>();

  private commandKey(binding: RuntimeBindingContext, commandId: string): string {
    return `${binding.canvasAgentBindingId}:${commandId}`;
  }

  async describe(): Promise<RuntimeDescriptor> {
    return {
      kind: 'fake',
      runtimeVersion: '1',
      adapterVersion: '1',
      capabilities: {
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
      },
    };
  }

  async health(): Promise<RuntimeHealth> {
    return { status: 'ready', checkedAt: new Date(0).toISOString(), details: {} };
  }

  async listModels(): Promise<RuntimeModelEntry[]> {
    return [{
      providerKey: 'fake',
      modelKey: 'deterministic-v1',
      displayName: 'Deterministic Fake v1',
      capabilities: { text: true, tools: true },
    }];
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSessionRef> {
    const commandKey = this.commandKey(input.binding, input.commandId);
    const prior = this.commandResults.get(commandKey);
    if (prior) {
      if (prior.metadata.canvasSessionId !== input.canvasSessionId) {
        throw new RuntimeAdapterError('transcript_conflict', 'commandId payload changed');
      }
      return prior;
    }
    const historyDigest = digestRuntimeTranscript([]);
    const result = {
      externalSessionRef: `fake-session-${randomUUID()}`,
      runtimeVersion: '1',
      replayStatus: 'complete' as const,
      historyDigest,
      metadata: { canvasSessionId: input.canvasSessionId },
    };
    this.sessions.set(result.externalSessionRef, {
      bindingId: input.binding.canvasAgentBindingId,
      canvasSessionId: input.canvasSessionId,
      externalSessionRef: result.externalSessionRef,
      transcript: [],
      historyDigest,
    });
    this.commandResults.set(commandKey, result);
    return result;
  }

  async loadSession(input: LoadRuntimeSessionInput): Promise<RuntimeSessionRef> {
    const session = this.requireSession(input.binding, input.externalSessionRef);
    if (session.canvasSessionId !== input.canvasSessionId) {
      throw new RuntimeAdapterError('session_ownership_mismatch', 'Canvas Session does not match Runtime Session');
    }
    return {
      externalSessionRef: session.externalSessionRef,
      runtimeVersion: '1',
      replayStatus: 'complete',
      historyDigest: session.historyDigest,
      lineage: session.lineage,
      metadata: { canvasSessionId: session.canvasSessionId },
    };
  }

  async listSessions(input: { binding: RuntimeBindingContext }): Promise<{ sessions: RuntimeSessionRef[] }> {
    return {
      sessions: [...this.sessions.values()]
        .filter((session) => session.bindingId === input.binding.canvasAgentBindingId)
        .map((session) => ({
          externalSessionRef: session.externalSessionRef,
          runtimeVersion: '1',
          replayStatus: 'complete',
          historyDigest: session.historyDigest,
          lineage: session.lineage,
          metadata: { canvasSessionId: session.canvasSessionId },
        })),
    };
  }

  async forkSession(input: ForkRuntimeSessionInput): Promise<RuntimeSessionRef> {
    const parent = this.requireSession(input.binding, input.parentExternalSessionRef);
    if (parent.canvasSessionId !== input.parentCanvasSessionId) {
      throw new RuntimeAdapterError('session_ownership_mismatch', 'parentCanvasSessionId does not match Runtime Session');
    }
    if (parent.historyDigest !== input.expectedParentHistoryDigest) {
      throw new RuntimeAdapterError('history_diverged', 'parent history digest changed');
    }
    if (digestRuntimeTranscript(input.transcriptPrefix) !== input.transcriptPrefixDigest) {
      throw new RuntimeAdapterError('transcript_conflict', 'prefix digest mismatch');
    }
    if (input.transcriptPrefix.at(-1)?.canvasMessageId !== input.atCanvasMessageId) {
      throw new RuntimeAdapterError('transcript_conflict', 'fork message is not prefix tail');
    }
    const parentPrefix = parent.transcript.slice(0, input.transcriptPrefix.length);
    if (digestRuntimeTranscript(parentPrefix) !== input.transcriptPrefixDigest) {
      throw new RuntimeAdapterError('history_diverged', 'prefix does not match parent transcript');
    }
    const created = await this.createSession({
      commandId: input.commandId,
      binding: input.binding,
      canvasSessionId: input.childCanvasSessionId,
      model: input.model,
      toolPolicy: input.toolPolicy,
      context: input.context,
    });
    const child = this.requireSession(input.binding, created.externalSessionRef);
    child.transcript = [...input.transcriptPrefix];
    child.historyDigest = input.transcriptPrefixDigest;
    child.lineage = {
      parentCanvasSessionId: input.parentCanvasSessionId,
      atCanvasMessageId: input.atCanvasMessageId,
      sourceRevisionId: input.sourceRevisionId,
      transcriptPrefixDigest: input.transcriptPrefixDigest,
    };
    return {
      ...created,
      historyDigest: child.historyDigest,
      lineage: child.lineage,
    };
  }

  async startRun(input: StartRuntimeRunInput): Promise<RuntimeRunRef> {
    const session = this.requireSession(input.binding, input.externalSessionRef);
    if (session.canvasSessionId !== input.canvasSessionId) {
      throw new RuntimeAdapterError('session_ownership_mismatch', 'Canvas Session does not match Runtime Session');
    }
    if (session.historyDigest !== input.expectedHistoryDigest) {
      throw new RuntimeAdapterError('history_diverged', 'startRun history digest changed');
    }
    const runKey = `${input.binding.canvasAgentBindingId}:${input.canvasRunId}`;
    const existing = this.runs.get(runKey);
    if (existing) return { externalRunRef: existing.externalRunRef, acceptedAt: new Date(0).toISOString() };
    session.transcript.push(input.prompt);
    session.historyDigest = digestRuntimeTranscript(session.transcript);
    const externalRunRef = `fake-run-${randomUUID()}`;
    const occurredAt = new Date(0).toISOString();
    const eventBase = {
      canvasSessionId: input.canvasSessionId,
      canvasRunId: input.canvasRunId,
      occurredAt,
    };
    this.runs.set(runKey, {
      bindingId: input.binding.canvasAgentBindingId,
      externalRunRef,
      canvasSessionId: input.canvasSessionId,
      externalSessionRef: input.externalSessionRef,
      cancelRequested: false,
      messageMaterialized: false,
      ledger: [],
      pending: [
        { ...eventBase, eventId: `${input.canvasRunId}:1`, externalEventRef: `${input.canvasRunId}:1`, type: 'run.accepted', externalRunRef },
        { ...eventBase, eventId: `${input.canvasRunId}:2`, externalEventRef: `${input.canvasRunId}:2`, type: 'run.started' },
        { ...eventBase, eventId: `${input.canvasRunId}:3`, externalEventRef: `${input.canvasRunId}:3`, type: 'model.output.delta', text: 'fake ' },
        { ...eventBase, eventId: `${input.canvasRunId}:4`, externalEventRef: `${input.canvasRunId}:4`, type: 'model.output.delta', text: 'fake ' },
        { ...eventBase, eventId: `${input.canvasRunId}:5`, externalEventRef: `${input.canvasRunId}:5`, type: 'message.completed', role: 'assistant', content: 'fake fake ' },
        { ...eventBase, eventId: `${input.canvasRunId}:6`, externalEventRef: `${input.canvasRunId}:6`, type: 'run.completed' },
      ],
    });
    return { externalRunRef, acceptedAt: occurredAt };
  }

  async *streamRunEvents(input: {
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
    afterExternalEventRef?: string;
  }): AsyncIterable<RuntimeEvent> {
    const run = this.runs.get(`${input.binding.canvasAgentBindingId}:${input.canvasRunId}`);
    if (!run || (input.externalRunRef && input.externalRunRef !== run.externalRunRef)) {
      throw new RuntimeAdapterError('run_not_found', 'Run not found for Binding');
    }
    const cursorIndex = input.afterExternalEventRef === undefined
      ? -1
      : run.ledger.findIndex((event) => event.externalEventRef === input.afterExternalEventRef);
    if (input.afterExternalEventRef !== undefined && cursorIndex < 0) {
      throw new RuntimeAdapterError('protocol_error', 'Unknown replay cursor');
    }
    for (const event of run.ledger.slice(cursorIndex + 1)) yield event;
    while (run.pending.length > 0) {
      const event = run.pending.shift()!;
      if (event.type === 'message.completed' && !run.messageMaterialized) {
        const session = this.requireSession(input.binding, run.externalSessionRef);
        session.transcript.push({
          canvasMessageId: `${input.canvasRunId}:assistant`,
          role: event.role,
          content: event.content,
        });
        session.historyDigest = digestRuntimeTranscript(session.transcript);
        run.messageMaterialized = true;
      }
      if (event.type === 'run.completed') run.terminal = 'succeeded';
      if (event.type === 'run.failed') run.terminal = 'failed';
      if (event.type === 'run.cancelled') run.terminal = 'cancelled';
      run.ledger.push(event);
      yield event;
    }
  }

  async cancelRun(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
  }): Promise<RuntimeCancelAck> {
    const run = this.runs.get(`${input.binding.canvasAgentBindingId}:${input.canvasRunId}`);
    if (!run || (input.externalRunRef && input.externalRunRef !== run.externalRunRef)) {
      throw new RuntimeAdapterError('run_not_found', 'Run not found for Binding');
    }
    const acknowledgedAt = new Date(0).toISOString();
    if (run.terminal) {
      return { outcome: 'already-terminal', externalRunRef: run.externalRunRef, observedTerminal: run.terminal, acknowledgedAt };
    }
    if (run.cancelRequested) {
      return { outcome: 'accepted', externalRunRef: run.externalRunRef, acknowledgedAt };
    }
    run.cancelRequested = true;
    run.pending = run.pending.filter((event) => ['run.accepted', 'run.started'].includes(event.type));
    run.pending.push({
      eventId: `${input.canvasRunId}:cancelled`,
      externalEventRef: `${input.canvasRunId}:cancelled`,
      canvasSessionId: run.canvasSessionId,
      canvasRunId: input.canvasRunId,
      type: 'run.cancelled',
      reason: 'user',
      occurredAt: new Date(0).toISOString(),
    });
    return { outcome: 'accepted', externalRunRef: run.externalRunRef, acknowledgedAt };
  }

  async respondToApproval(): Promise<void> { throw new RuntimeCapabilityError('toolApproval'); }
  async setSessionModel(): Promise<void> { throw new RuntimeCapabilityError('sessionModelSwitch'); }
  async setSessionToolPolicy(): Promise<void> { throw new RuntimeCapabilityError('sessionToolPolicy'); }

  async exportSnapshot(input: LoadRuntimeSessionInput): Promise<RuntimeSnapshot> {
    const session = this.requireSession(input.binding, input.externalSessionRef);
    return { format: 'fake-json', version: '1', payload: structuredClone(session.transcript) };
  }

  async restoreSnapshot(input: CreateRuntimeSessionInput & { snapshot: RuntimeSnapshot }): Promise<RuntimeSessionRef> {
    if (
      input.snapshot.format !== 'fake-json'
      || input.snapshot.version !== '1'
      || !Array.isArray(input.snapshot.payload)
      || !input.snapshot.payload.every((message) => (
        typeof message === 'object'
        && message !== null
        && typeof (message as { canvasMessageId?: unknown }).canvasMessageId === 'string'
        && ['user', 'assistant', 'system', 'tool'].includes(
          String((message as { role?: unknown }).role),
        )
      ))
    ) {
      throw new RuntimeAdapterError('protocol_error', 'Invalid fake snapshot');
    }
    const created = await this.createSession(input);
    const session = this.requireSession(input.binding, created.externalSessionRef);
    session.transcript = structuredClone(input.snapshot.payload) as RuntimeTranscriptMessage[];
    session.historyDigest = digestRuntimeTranscript(session.transcript);
    return { ...created, historyDigest: session.historyDigest };
  }

  async shutdown(input: {
    binding: RuntimeBindingContext;
    reason: 'test' | 'deploy' | 'idle' | 'failure';
  }): Promise<void> {
    for (const [key, session] of this.sessions) {
      if (session.bindingId === input.binding.canvasAgentBindingId) this.sessions.delete(key);
    }
    for (const [key, run] of this.runs) {
      if (run.bindingId === input.binding.canvasAgentBindingId) this.runs.delete(key);
    }
    for (const key of this.commandResults.keys()) {
      if (key.startsWith(`${input.binding.canvasAgentBindingId}:`)) this.commandResults.delete(key);
    }
  }

  private requireSession(binding: RuntimeBindingContext, externalSessionRef: string): FakeSession {
    const session = this.sessions.get(externalSessionRef);
    if (!session) throw new RuntimeAdapterError('session_not_found', 'Runtime Session not found');
    if (session.bindingId !== binding.canvasAgentBindingId) {
      throw new RuntimeAdapterError('session_ownership_mismatch', 'Runtime Session belongs to another Binding');
    }
    return session;
  }
}
```

Create `packages/ai/src/runtime/index.ts`:

```ts
export * from './contract';
export * from './contract-suite';
export * from './deterministic-fake';
```

Append to `packages/ai/src/index.ts`:

```ts
export * from './runtime';
```

- [ ] **Step 5: Run tests, typecheck and commit**

Run:

```bash
pnpm vitest run packages/ai/src/runtime/deterministic-fake.test.ts
pnpm --filter @ai-super-canvas/ai typecheck
```

Expected: PASS. If TypeScript reports an interface mismatch, change the FakeRuntime signatures to match `contract.ts`; do not weaken the contract.

```bash
git add packages/ai/src/runtime packages/ai/src/index.ts
git commit -m "feat(ai): add runtime adapter contract and fake runtime"
```

### Task 3: Add the normalized Drizzle schema and migrations

**Files:**
- Create: `packages/db/src/schema/enums.ts`
- Create: `packages/db/src/schema/identity.ts`
- Create: `packages/db/src/schema/workflows.ts`
- Create: `packages/db/src/schema/execution.ts`
- Create: `packages/db/src/schema/authorization.ts`
- Create: `packages/db/src/schema/audit.ts`
- Create: `packages/db/src/schema/relations.ts`
- Create: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/drizzle.config.ts`
- Create: `compose.control-plane-test.yaml`
- Modify: `Dockerfile`

- [ ] **Step 1: Write a failing schema export test**

```ts
// packages/db/src/schema/schema-contract.test.ts
import { describe, expect, it } from 'vitest';
import {
  accounts,
  agentAccessGrants,
  agentBindings,
  agents,
  branchAnchors,
  bootstrapReceipts,
  messages,
  runEvents,
  runs,
  commandReceipts,
  contextRefs,
  domainEvents,
  modelCatalogEntries,
  runtimeCompensations,
  sessionEdges,
  sessionConfigRevisions,
  sessionNodes,
  sessionRuntimeRefs,
  sessions,
  toolApprovalDecisions,
  toolGrants,
  trunkRevisions,
  workflows,
  workspaceMembers,
  workspaces,
} from './index';

describe('control-plane schema exports', () => {
  it('exports every S1 aggregate table', () => {
    expect([
      accounts,
      agents,
      agentAccessGrants,
      agentBindings,
      workspaces,
      workflows,
      trunkRevisions,
      branchAnchors,
      bootstrapReceipts,
      sessions,
      sessionNodes,
      sessionEdges,
      sessionRuntimeRefs,
      modelCatalogEntries,
      sessionConfigRevisions,
      messages,
      runs,
      commandReceipts,
      runEvents,
      toolGrants,
      toolApprovalDecisions,
      contextRefs,
      domainEvents,
      runtimeCompensations,
      workspaceMembers,
    ]).toHaveLength(25);
  });
});
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run:

```bash
pnpm vitest run packages/db/src/schema/schema-contract.test.ts
```

Expected: FAIL because `packages/db/src/schema/index.ts` does not exist.

- [ ] **Step 3: Define enums and identity tables**

```ts
// packages/db/src/schema/enums.ts
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
export const growthState = pgEnum('growth_state', ['active', 'dormant', 'metabolized']);
export const sessionStatus = pgEnum('session_status', [
  'provisioning',
  'active',
  'dormant',
  'closed',
  'archived',
  'error',
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
export const messageRole = pgEnum('message_role', ['user', 'assistant', 'system', 'tool']);
export const sessionEdgeKind = pgEnum('session_edge_kind', [
  'derives',
  'references',
  'supports',
  'contradicts',
  'depends_on',
]);
```

```ts
// packages/db/src/schema/identity.ts
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bindingStatus, runtimeKind } from './enums';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  authSubject: text('auth_subject').notNull().unique(),
  email: text('email'),
  displayName: text('display_name').notNull(),
  defaultAgentId: uuid('default_agent_id'),
  ...timestamps,
}, (table) => [uniqueIndex('accounts_email_lower_unique').on(sql`lower(${table.email})`)]);

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  defaultModelKey: text('default_model_key'),
  memoryPolicy: jsonb('memory_policy').notNull().default({}),
  ...timestamps,
}, (table) => [
  index('agents_owner_status_idx').on(table.ownerAccountId, table.status),
  uniqueIndex('agents_owner_id_unique').on(table.ownerAccountId, table.id),
]);

export const agentAccessGrants = pgTable('agent_access_grants', {
  id: uuid('id').primaryKey(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  role: text('role').notNull(),
  grantedByAccountId: uuid('granted_by_account_id').notNull().references(() => accounts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('agent_access_active_unique')
    .on(table.agentId, table.accountId)
    .where(sql`${table.revokedAt} IS NULL`),
]);

export const agentBindings = pgTable('agent_bindings', {
  id: uuid('id').primaryKey(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  runtimeKind: runtimeKind('runtime_kind').notNull(),
  externalAgentRef: text('external_agent_ref'),
  isolationKey: text('isolation_key').notNull(),
  endpointRef: text('endpoint_ref'),
  secretRef: text('secret_ref'),
  runtimeVersion: text('runtime_version'),
  capabilities: jsonb('capabilities').notNull().default({}),
  status: bindingStatus('status').notNull().default('provisioning'),
  isPrimary: boolean('is_primary').notNull().default(false),
  ...timestamps,
}, (table) => [
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
]);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => accounts.id),
  name: text('name').notNull(),
  ...timestamps,
}, (table) => [index('workspaces_owner_updated_idx').on(table.ownerAccountId, table.updatedAt)]);

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.accountId] })]);
```

After `agents` exists, add the circular default Agent reference in the generated SQL migration:

```sql
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_default_agent_fk"
  FOREIGN KEY ("default_agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL;
```

Add a deferred constraint trigger `accounts_default_agent_authorized` that rejects a default Agent unless `agents.owner_account_id = accounts.id` or an active `agent_access_grants(account_id,agent_id)` row exists. Fire the same validation when a Grant is revoked, requiring the default pointer to be cleared in that transaction. Add CHECK constraints for grant role, Workspace member role, and Agent status in the same migration.

- [ ] **Step 4: Define Workflow and execution tables**

Implement the exact S1 columns, foreign keys, checks and indexes in sections 4 and 5 of `docs/architecture/postgres-schema.md`, with one correction required for Runtime portability: `sessions` contains no external Runtime ID. Create `session_runtime_refs` with these exact columns:

```ts
export const sessionRuntimeRefs = pgTable('session_runtime_refs', {
  id: uuid('id').primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  agentBindingId: uuid('agent_binding_id').notNull().references(() => agentBindings.id),
  externalSessionRef: text('external_session_ref').notNull(),
  isPrimary: boolean('is_primary').notNull().default(true),
  status: text('status').notNull().default('active'),
  syncCursor: jsonb('sync_cursor').notNull().default({}),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('runtime_session_ref_unique').on(table.agentBindingId, table.externalSessionRef),
  uniqueIndex('runtime_session_active_primary_unique')
    .on(table.sessionId)
    .where(sql`${table.isPrimary} = true AND ${table.status} = 'active'`),
  index('runtime_session_session_idx').on(table.sessionId, table.status),
]);
```

`session_edges.source_session_node_id` is nullable so a TrunkRevision anchor can create the first branch SessionNode. Add the exact checks in the generated SQL migration:

```sql
ALTER TABLE "session_edges" ADD CONSTRAINT "session_edges_not_self"
  CHECK ("source_session_node_id" IS NULL OR "source_session_node_id" <> "target_session_node_id");
ALTER TABLE "session_edges" ADD CONSTRAINT "session_edges_anchor_by_kind"
  CHECK (("kind" = 'derives' AND "anchor_id" IS NOT NULL)
      OR ("kind" <> 'derives' AND "anchor_id" IS NULL));
CREATE UNIQUE INDEX "session_nodes_session_unique" ON "session_nodes" ("session_id");
CREATE UNIQUE INDEX "session_edges_one_birth_unique"
  ON "session_edges" ("target_session_node_id") WHERE "kind" = 'derives';
CREATE UNIQUE INDEX "messages_session_ordinal_unique" ON "messages" ("session_id", "ordinal");
CREATE UNIQUE INDEX "messages_runtime_projection_unique"
  ON "messages" ("run_id", "source_runtime_event_key")
  WHERE "source_runtime_event_key" IS NOT NULL;
CREATE UNIQUE INDEX "runs_session_idempotency_unique" ON "runs" ("session_id", "idempotency_key");
CREATE UNIQUE INDEX "run_events_sequence_unique" ON "run_events" ("run_id", "sequence");
CREATE UNIQUE INDEX "runs_one_active_per_session"
  ON "runs" ("session_id")
  WHERE "status" IN ('queued', 'running', 'waiting_approval', 'reconciling');
```

The migration must also add every composite FK specified in `docs/architecture/postgres-schema.md`: Workflow/current TrunkRevision; parent/anchor/session-node/edge within one Workflow; SessionRuntimeRef and Run within the Session Binding; Run config/trigger Message and Message/run within one Session; ContextRef and ToolGrant nested scopes. Add a deferred cycle guard and a lineage consistency trigger requiring each derives Edge source/target/anchor to equal the target Session's parent/fork-anchor semantics.

For S1, `branch_anchors.source_kind` CHECK permits only `trunk_revision,message`; `source_artifact_id` remains nullable/reserved and cannot be populated. S4 adds Artifact tables, the composite Artifact FK, and widens the CHECK in one migration.

Also create `command_receipts`, `bootstrap_receipts`, `domain_events`, and `runtime_compensations` exactly as specified in `docs/architecture/postgres-schema.md`. The repository must reject reuse of a command key with different payload bytes, persist orchestration phase/result across restarts, append non-Run domain events in the same aggregate transaction, and retain either an external ref or lookup metadata for orphan-resource reconciliation.

Create `packages/db/src/schema/index.ts`:

```ts
export * from './enums';
export * from './identity';
export * from './workflows';
export * from './execution';
export * from './authorization';
export * from './audit';
export * from './relations';
```

Replace `packages/db/src/schema.ts` with:

```ts
export * from './schema/index';
export const schemaVersion = 1 as const;
```

Change `packages/db/drizzle.config.ts` to use:

```ts
export default {
  schema: './src/schema/index.ts',
};
```

The snippet shows the target property only: preserve the existing dialect, output directory, credentials and `defineConfig` wrapper; change only `schema`.

- [ ] **Step 5: Add a no-host-port Compose test runner, generate migration, and verify**

```yaml
# compose.control-plane-test.yaml
services:
  postgres-test:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: canvas_s1
      POSTGRES_PASSWORD: canvas-test-password
      POSTGRES_DB: canvas_s1_test
    volumes:
      - postgres-s1-test-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U canvas_s1 -d canvas_s1_test"]
      interval: 2s
      timeout: 3s
      retries: 30

  test:
    build:
      context: .
      dockerfile: Dockerfile
      target: test
    working_dir: /workspace
    environment:
      NODE_ENV: test
      ALLOW_TEST_DATABASE_RESET: "1"
      DATABASE_URL: postgres://canvas_s1:canvas-test-password@postgres-test:5432/canvas_s1_test
    depends_on:
      postgres-test:
        condition: service_healthy
    entrypoint: ["pnpm"]

volumes:
  postgres-s1-test-data: {}
```

Do not add top-level `name:` or a volume-level `name:`. The CLI `-p ai-super-canvas-s1-test` creates the isolated volume `ai-super-canvas-s1-test_postgres-s1-test-data`; no command in this plan combines this file with `compose.yaml`.
PostgreSQL 18 intentionally mounts `/var/lib/postgresql` (not the legacy `/var/lib/postgresql/data`) so the versioned cluster directory is actually persisted across the two migration runs.

Add this stage after `FROM dependencies AS builder` has been split so both stages inherit dependencies:

```dockerfile
FROM dependencies AS test
COPY . .
ENTRYPOINT ["pnpm"]

FROM dependencies AS builder
COPY . .
RUN pnpm --filter @ai-super-canvas/web build
```

Run:

```bash
DATABASE_URL=postgres://migration:unused@127.0.0.1:1/canvas_s1_test pnpm --filter @ai-super-canvas/db db:generate
test -n "$(git status --short --untracked-files=all packages/db/migrations)"
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml up -d postgres-test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm --build test --filter @ai-super-canvas/db db:migrate
pnpm vitest run packages/db/src/schema/schema-contract.test.ts
pnpm --filter @ai-super-canvas/db typecheck
```

Generate migrations on the host so Drizzle writes them into the tracked `packages/db/migrations` directory. `drizzle.config.ts` requires a syntactically valid `DATABASE_URL`, so generation receives an intentionally unreachable placeholder; `drizzle-kit generate` compares schema files and does not connect to it. The `test -n` guard fails when the host cannot see a new/changed migration before building the test image; the rebuilt image then copies those migrations for `db:migrate`. Never generate migrations only inside an ephemeral `docker compose run --rm` container, because its filesystem is discarded.

Expected: the host-visible migration, migration apply, and tests all exit 0. The test Compose file creates no host listener, so it does not change the service-port registry.

```bash
git add packages/db/src/schema packages/db/src/schema.ts packages/db/drizzle.config.ts packages/db/migrations compose.control-plane-test.yaml
git commit -m "feat(db): add agent session control-plane schema"
```

### Task 4: Add the repository contract and PostgreSQL integration tests

**Files:**
- Create: `packages/db/src/repositories/control-plane-repository.ts`
- Create: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Create: `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write failing integration tests for idempotent Session and ordered Run events**

```ts
// packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresControlPlaneRepository } from './postgres-control-plane-repository';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

function assertDisposableTestDatabase(url: string): void {
  const parsed = new URL(url);
  if (
    process.env.NODE_ENV !== 'test'
    || process.env.ALLOW_TEST_DATABASE_RESET !== '1'
    || parsed.hostname !== 'postgres-test'
    || parsed.pathname !== '/canvas_s1_test'
  ) {
    throw new Error('Refusing destructive reset outside isolated canvas_s1_test database');
  }
}

assertDisposableTestDatabase(databaseUrl);

describe('PostgresControlPlaneRepository', () => {
  const repository = createPostgresControlPlaneRepository(databaseUrl);

  beforeAll(async () => repository.resetTestData());
  afterAll(async () => repository.close());

  it('returns the same Session for the same command key', async () => {
    const bootstrap = await repository.bootstrapLocalAlpha({
      commandId: '40404040-4040-4040-8040-404040404040',
      authSubject: 'local:repository-contract',
      displayName: 'Repository contract owner',
    });
    const fixture = {
      actor: { accountId: bootstrap.accountId, authSubject: bootstrap.authSubject },
      workflowId: bootstrap.workflowId,
      agentBindingId: bootstrap.agentBindingId,
    };
    const first = await repository.createRootSession({
      commandId: '13131313-1313-4313-8313-131313131313',
      ...fixture,
      title: '主会话',
    });
    const second = await repository.createRootSession({
      commandId: '13131313-1313-4313-8313-131313131313',
      ...fixture,
      title: '主会话',
    });
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('ingests a monotonic event sequence and makes replay idempotent', async () => {
    const fixture = await repository.createRunFixture();
    await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: fixture.runId,
      externalEventRef: 'event-1',
      runtimeEventKey: 'fake:event-1',
      type: 'run.started',
      payload: {},
      occurredAt: new Date(0),
    });
    await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: fixture.runId,
      externalEventRef: 'event-2',
      runtimeEventKey: 'fake:event-2',
      type: 'run.completed',
      payload: {},
      occurredAt: new Date(1),
    });
    const events = await repository.listRunEvents({
      actor: fixture.actor,
      runId: fixture.runId,
      afterSequence: 0,
    });
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    await expect(repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: fixture.runId,
      externalEventRef: 'event-2',
      runtimeEventKey: 'fake:event-2',
      type: 'run.completed',
      payload: {},
      occurredAt: new Date(1),
    })).resolves.toMatchObject({ duplicate: true, sequence: 2 });
  });
});
```

Add negative integration cases in the same file. They must prove: a default Agent without owner/active Grant fails; mismatched `ActorContext.accountId/authSubject` fails; a different account cannot read Session/Run/events; revoked Workspace membership fails on the next query; `resolveActorContext` still resolves correctly after closing/reopening the Repository; a parent/anchor/node/edge from another Workflow fails; contradictory Session/derives-edge lineage fails; a second derives birth edge fails; a derives cycle fails at transaction commit; a second active-primary RuntimeSessionRef fails; config/trigger Message or AgentBinding from another Session fails; a second active or reconciling Run fails; and two identical delta payloads with different `runtimeEventKey` values both persist. These are acceptance tests for the migration, not optional service-layer checks.

Add atomic-ingestion integration cases for `message.completed` and each terminal event. Construct the Repository with a test-only fault injector that throws after `run-event-insert`, after `message-projection`, after `terminal-transition`, and immediately before commit. After every injected crash, close/reopen the Repository and prove RunEvent, Message and Run status are either all absent/unchanged or all committed—never partial. Replay the same `runtimeEventKey` after reopening and prove it creates exactly one event, one Message keyed by `(run_id,source_runtime_event_key)`, and one terminal transition. The fault hook must be impossible to configure unless `NODE_ENV=test` and the disposable database guard passes.

Add command-orchestration cases: retry after successful attach returns the stored Canvas result without a second Runtime dispatch; a crash after Runtime success but before attach leaves `runtime_known/reconciling` plus one compensation row; reopening the Repository preserves that phase; and retry never creates a second external resource. A transport-unknown case stores lookup metadata without an external ref and remains reconciling until adopt proves one match or proves absence. These assertions apply to root, anchored, fork and start-Run commands.

Add two concurrent `bootstrapLocalAlpha` calls with the same `authSubject + commandId`; both must return the same Account/Agent/Binding/Workspace/Workflow IDs and leave one `bootstrap_receipts` row. Reusing the key with a different payload hash must return conflict.

- [ ] **Step 2: Run the integration test and verify it fails**

Run:

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm --build test vitest run packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
```

Expected: FAIL because the repository module does not exist.

- [ ] **Step 3: Define the repository interface**

`packages/db/src/repositories/control-plane-repository.ts` must export concrete input/result types and this interface:

```ts
export interface ControlPlaneRepository {
  createRootSession(input: CreateRootSessionInput): Promise<CreatedSession>;
  prepareAnchoredSession(input: PrepareAnchoredSessionInput): Promise<PreparedAnchoredSession>;
  prepareFork(input: PrepareForkInput): Promise<PreparedFork>;
  bootstrapLocalAlpha(input: BootstrapLocalAlphaInput): Promise<BootstrappedControlPlane>;
  resolveActorContext(input: { authSubject: string }): Promise<ActorContext | null>;
  beginRuntimeDispatch(input: BeginRuntimeDispatchInput): Promise<RuntimeDispatchState>;
  recordRuntimeResourceKnown(input: RuntimeResourceKnownInput): Promise<void>;
  attachRuntimeSession(input: AttachRuntimeSessionInput): Promise<void>;
  markRuntimeCommandFailure(input: RuntimeCommandFailureInput): Promise<void>;
  markRuntimeCommandReconciling(input: RuntimeCommandReconcileInput): Promise<void>;
  createRun(input: CreateRunInput): Promise<CreatedRun>;
  attachRuntimeRun(input: AttachRuntimeRunInput): Promise<void>;
  ingestRuntimeEvent(input: IngestRuntimeEventInput): Promise<IngestedRuntimeEvent>;
  markRunReconciling(input: MarkRunReconcilingInput): Promise<void>;
  getSessionRuntimeContext(input: AuthorizedSessionQuery): Promise<SessionRuntimeContext>;
  getRunExecutionContext(input: AuthorizedRunQuery): Promise<RunExecutionContext>;
  loadSessionTranscript(input: AuthorizedSessionQuery): Promise<StoredMessage[]>;
  listRunEvents(input: AuthorizedRunQuery & { afterSequence: number }): Promise<StoredRunEvent[]>;
  reconcileOrphanedActiveRunsAfterRestart(input: { reason: string }): Promise<number>;
}
```

`ActorContext` is the canonical type from `@ai-super-canvas/core`; DB and control-plane import it from there, avoiding a reverse/circular package dependency. It contains only `accountId/authSubject`. `resolveActorContext({ authSubject })` resolves the current Account after every process restart; all authorized Repository queries re-check that the two fields still identify the same active Account and query current Workspace membership/AgentAccessGrant from PostgreSQL. Membership is never trusted as a cached claim. Every `AuthorizedSessionQuery`/`AuthorizedRunQuery` contains `{ actor, sessionId/runId }`. `PreparedFork` must contain the new Canvas Session/Node IDs, the parent transcript prefix through `atMessageId`, AgentBinding, resolved model, tool policy, and ContextRefs. No Runtime SDK object can appear in this interface.

Every prepared command result also returns its persisted orchestration phase and any attached Canvas result/runtime ref. `beginRuntimeDispatch` atomically changes only `canvas_prepared/retryable_failure → runtime_dispatched`; it returns the existing phase without dispatch permission for `runtime_dispatched/runtime_known/attached/reconciling`. `recordRuntimeResourceKnown` durably stores the external ref before attach. `attachRuntimeSession` and `attachRuntimeRun` atomically write the active RuntimeRef plus receipt phase/result=`attached`. `markRuntimeCommandReconciling` atomically advances the receipt and inserts/upserts its `runtime_compensations` row, including lookup metadata when the external ref is unknown. No caller may compose those state changes from separate Repository calls.

`reconcileOrphanedActiveRunsAfterRestart` is an internal maintenance method, not exported through an HTTP handler. In S1 it atomically moves queued/running/waiting_approval rows left without a live in-process pump to `reconciling` and appends a DomainEvent; it never marks success or retries a Runtime action.

- [ ] **Step 4: Implement transactional idempotency and event sequencing**

`createRootSession` must insert a `command_receipts` row before Session creation and return its phase/stored result on unique-key conflict. `bootstrapLocalAlpha` instead inserts `bootstrap_receipts` before Account/Workflow creation in the same transaction, because no business FK exists yet.

`ingestRuntimeEvent` is the only event-write entrypoint. In one transaction it re-authorizes ActorContext, locks the Run, checks `(run_id,runtime_event_key)`, allocates `max(sequence)+1`, inserts RunEvent, writes a completed Message with the same `source_runtime_event_key` when applicable, and conditionally advances terminal Run state. It returns `{ duplicate, sequence, projectedMessageId?, terminalState? }` only after commit. Duplicate replay returns the existing projection and performs no second write. Never use event payload hash as identity; never expose separate public `appendRunEvent`/`appendCompletedMessage` calls.

`resetTestData()` is a test-only method and must repeat the hard guard internally before issuing any TRUNCATE: `NODE_ENV === test`, `ALLOW_TEST_DATABASE_RESET === 1`, parsed hostname exactly `postgres-test`, and database path exactly `/canvas_s1_test`. A caller-side assertion alone is insufficient. Add four negative tests, one for each failed condition, and assert no SQL mutation function was invoked.

Use conditional terminal updates inside that same transaction:

```sql
UPDATE runs
SET status = $next_status, completed_at = now()
WHERE id = $run_id
  AND status IN ('queued', 'running', 'waiting_approval', 'reconciling');
```

If the update count is zero, reload the Run; terminal-to-terminal duplicate events are ignored and conflicting terminal events append `runtime.warning` without changing status.

- [ ] **Step 5: Run the integration suite and commit**

Run:

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm --build test vitest run packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
pnpm --filter @ai-super-canvas/db typecheck
```

Expected: PASS for idempotent Session creation and event sequences `[1, 2]`.

```bash
git add packages/db/src/repositories packages/db/src/index.ts
git commit -m "feat(db): add control-plane repository"
```

### Task 5: Add the control-plane application service

**Files:**
- Create: `packages/control-plane/package.json`
- Create: `packages/control-plane/tsconfig.json`
- Create: `packages/control-plane/src/session-service.ts`
- Create: `packages/control-plane/src/session-service.test.ts`
- Create: `packages/control-plane/src/run-event-pump.ts`
- Create: `packages/control-plane/src/run-event-pump.test.ts`
- Create: `packages/control-plane/src/index.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `Dockerfile`

- [ ] **Step 1: Create the package manifest and failing service test**

```json
{
  "name": "@ai-super-canvas/control-plane",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@ai-super-canvas/ai": "workspace:*",
    "@ai-super-canvas/core": "workspace:*",
    "@ai-super-canvas/db": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "24.4.0",
    "eslint": "9.39.5",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

```json
// packages/control-plane/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "types": ["node"] },
  "include": ["src/**/*.ts"]
}
```

```ts
// packages/control-plane/src/session-service.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DeterministicFakeRuntime } from '@ai-super-canvas/ai';
import { SessionService } from './session-service';

describe('SessionService', () => {
  it('attaches a Runtime ref after creating a Canvas Session', async () => {
    const repository = {
      createRootSession: vi.fn().mockResolvedValue({
        commandReceiptId: '20202020-2020-4020-8020-202020202020',
        orchestration: { phase: 'canvas_prepared' },
        sessionId: '14141414-1414-4414-8414-141414141414',
        nodeId: '15151515-1515-4515-8515-151515151515',
        binding: {
          canvasAgentBindingId: '16161616-1616-4616-8616-161616161616',
          isolationKey: 'test-agent-workspace',
        },
        model: { providerKey: 'fake', modelKey: 'deterministic-v1' },
        toolPolicy: { allowedToolKeys: [], deniedToolKeys: [], approvalRequiredToolKeys: [] },
        context: [],
      }),
      beginRuntimeDispatch: vi.fn().mockResolvedValue({
        phase: 'runtime_dispatched',
        dispatchAllowed: true,
      }),
      recordRuntimeResourceKnown: vi.fn().mockResolvedValue(undefined),
      attachRuntimeSession: vi.fn().mockResolvedValue(undefined),
      markRuntimeCommandFailure: vi.fn().mockResolvedValue(undefined),
      markRuntimeCommandReconciling: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SessionService(repository as never, new DeterministicFakeRuntime());
    const result = await service.createRootSession({
      commandId: '17171717-1717-4717-8717-171717171717',
      actor: {
        accountId: '18181818-1818-4818-8818-181818181818',
        authSubject: 'local:test-owner',
      },
      workflowId: '19191919-1919-4919-8919-191919191919',
      agentBindingId: '16161616-1616-4616-8616-161616161616',
      title: '主会话',
    });

    expect(result.status).toBe('active');
    expect(repository.attachRuntimeSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: '14141414-1414-4414-8414-141414141414',
      externalSessionRef: expect.stringMatching(/^fake-session-/),
    }));
  });
});
```

- [ ] **Step 2: Install workspace links and verify the test fails**

Run:

```bash
pnpm install --lockfile-only
pnpm vitest run packages/control-plane/src/session-service.test.ts
pnpm vitest run packages/control-plane/src/run-event-pump.test.ts
```

Expected: FAIL because `session-service.ts` does not exist.

- [ ] **Step 3: Implement Session creation with compensation**

```ts
// packages/control-plane/src/session-service.ts
import { RuntimeAdapterError, type RuntimeAdapter } from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type { ControlPlaneRepository } from '@ai-super-canvas/db';

export interface CreateRootSessionRequest {
  commandId: string;
  actor: ActorContext;
  workflowId: string;
  agentBindingId: string;
  title: string;
}

export class CommandRequiresReconciliationError extends Error {
  constructor(readonly commandReceiptId: string, readonly phase: string) {
    super(`Runtime command requires reconciliation: ${phase}`);
    this.name = 'CommandRequiresReconciliationError';
  }
}

export class SessionService {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly runtime: RuntimeAdapter,
  ) {}

  async createRootSession(input: CreateRootSessionRequest): Promise<{
    sessionId: string;
    nodeId: string;
    status: 'active';
  }> {
    const prepared = await this.repository.createRootSession(input);
    if (prepared.orchestration.phase === 'attached') {
      const stored = prepared.orchestration.result;
      if (!stored) throw new Error('Attached command receipt is missing its Canvas result');
      return { sessionId: stored.sessionId, nodeId: stored.nodeId, status: 'active' };
    }

    const dispatch = await this.repository.beginRuntimeDispatch({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
    });
    if (!dispatch.dispatchAllowed) {
      throw new CommandRequiresReconciliationError(prepared.commandReceiptId, dispatch.phase);
    }

    let runtimeSession: Awaited<ReturnType<RuntimeAdapter['createSession']>>;
    try {
      runtimeSession = await this.runtime.createSession({
        commandId: input.commandId,
        binding: prepared.binding,
        canvasSessionId: prepared.sessionId,
        model: prepared.model,
        toolPolicy: prepared.toolPolicy,
        context: prepared.context,
      });
    } catch (reason) {
      const errorMessage = reason instanceof Error ? reason.message : 'runtime_session_create_failed';
      if (reason instanceof RuntimeAdapterError && reason.operationEffect === 'not-applied') {
        await this.repository.markRuntimeCommandFailure({
          actor: input.actor,
          commandReceiptId: prepared.commandReceiptId,
          retryable: reason.retryable,
          errorCode: reason.code,
          errorMessage,
        });
      } else {
        await this.repository.markRuntimeCommandReconciling({
          actor: input.actor,
          commandReceiptId: prepared.commandReceiptId,
          agentBindingId: prepared.binding.canvasAgentBindingId,
          canvasSessionId: prepared.sessionId,
          externalResourceKind: 'session',
          externalResourceRef: null,
          lookupMetadata: { commandId: input.commandId, canvasSessionId: prepared.sessionId },
          errorMessage,
        });
      }
      throw reason;
    }

    try {
      await this.repository.recordRuntimeResourceKnown({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'session',
        externalResourceRef: runtimeSession.externalSessionRef,
      });
      await this.repository.attachRuntimeSession({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        sessionId: prepared.sessionId,
        agentBindingId: prepared.binding.canvasAgentBindingId,
        externalSessionRef: runtimeSession.externalSessionRef,
        runtimeVersion: runtimeSession.runtimeVersion,
        metadata: runtimeSession.metadata,
      });
      return { sessionId: prepared.sessionId, nodeId: prepared.nodeId, status: 'active' };
    } catch (reason) {
      await this.repository.markRuntimeCommandReconciling({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        agentBindingId: prepared.binding.canvasAgentBindingId,
        canvasSessionId: prepared.sessionId,
        externalResourceKind: 'session',
        externalResourceRef: runtimeSession.externalSessionRef,
        lookupMetadata: { commandId: input.commandId, canvasSessionId: prepared.sessionId },
        errorMessage: reason instanceof Error ? reason.message : 'runtime_session_attach_failed',
      });
      throw reason;
    }
  }
}
```

```ts
// packages/control-plane/src/index.ts
export * from './session-service';
```

- [ ] **Step 4: Add the event pump, fork, Run and cancellation methods**

Implement `RunEventPump` as the only Runtime→Canvas event-ingestion executor in S1:

```ts
export interface RunEventPump {
  start(input: { actor: ActorContext; runId: string }): void;
  waitForTerminal(input: {
    actor: ActorContext;
    runId: string;
    timeoutMs: number;
  }): Promise<'succeeded' | 'failed' | 'cancelled' | 'timeout'>;
  reconcileAfterRestart(): Promise<void>;
}
```

`start()` is synchronous and idempotent per Run: it registers an internally observed active Promise before opening `streamRunEvents`, so simultaneous start/cancel cannot create two consumers. The internal runner gets the authorized execution context and submits each normalized event once to Repository `ingestRuntimeEvent`; that single transaction owns RunEvent dedupe, completed-Message projection and terminal Run transition. The Pump never calls separate append/projection/transition methods. It settles only after exactly one committed terminal. Stream end/error without a terminal atomically marks the Run `reconciling`; the pump catches every internal rejection, persists it, and never creates an unhandled Promise. `reconcileAfterRestart()` runs at server bootstrap and moves database-active Runs without a live pump to `reconciling`—it never retries side-effecting tools automatically.

Add these methods to `SessionService` with the same compensation pattern:

```ts
export interface SessionServiceCommands {
bootstrapLocalAlpha(input: {
  commandId: string;
  authSubject: string;
  displayName: string;
}): Promise<BootstrappedControlPlane>;
createAnchoredSession(input: {
  actor: ActorContext;
  command: CreateAnchoredSessionCommand;
}): Promise<{ sessionId: string; nodeId: string; status: 'active' }>;
forkSession(input: {
  actor: ActorContext;
  command: ForkMessageSessionCommand;
}): Promise<{ sessionId: string; nodeId: string; status: 'active' }>;
startRun(input: {
  commandId: string;
  idempotencyKey: string;
  actor: ActorContext;
  sessionId: string;
  content: unknown;
}): Promise<{ runId: string; status: 'queued' | 'running' }>;
ingestRunEvents(input: { actor: ActorContext; runId: string }): Promise<void>;
cancelRun(input: {
  commandId: string;
  actor: ActorContext;
  runId: string;
}): Promise<{ state: 'terminal' | 'reconciling' }>;
}
```

Required behavior:

1. `bootstrapLocalAlpha` is idempotent by `authSubject + commandId`; it uses the dedicated `bootstrap_receipts` row in the same transaction that creates/loads Account, owned default Agent, Fake Binding, Workspace, `workspace_members(role=owner)`, first TrunkRevision and Workflow. It accepts no database ID from the caller and returns only after the owner membership is queryable. Concurrent duplicate requests return the completed receipt result; payload-hash mismatch is a conflict.
2. Every authenticated method passes server-created `ActorContext` into Repository authorization queries; no method reads actor identity from command JSON or hidden process globals.
3. `createAnchoredSession` parses `CreateAnchoredSessionCommandSchema`, calls `prepareAnchoredSession({ actor,command })`, validates the TrunkRevision quote, and creates a Session/SessionNode whose derives edge has a null source SessionNode and the Trunk anchor. It uses the same receipt phase machine as root creation; no fake parent/message fields are introduced.
4. `forkSession` parses `ForkMessageSessionCommandSchema`, calls `repository.prepareFork({ actor, command })`, then dispatches `runtime.forkSession` only after `beginRuntimeDispatch` grants the one dispatch. If Runtime declares `forkAtMessage = unsupported`, record a `not-applied` terminal failure before any Runtime resource exists. The exact transcript prefix remains part of the receipt payload hash.
5. `startRun` first calls `getSessionRuntimeContext({ actor,sessionId })`, then creates the Canvas user Message, Run and command receipt before Runtime. Actual Binding/external ref/model/tool/context snapshots come from the authorized Repository result; request payload cannot supply policies. It follows the same dispatch/known/attach phase machine. After atomic attach of the Runtime run ref and receipt, it calls `eventPump.start({ actor,runId })` before returning 202.
6. `ingestRunEvents` delegates to the same pump; there is no second ingestion implementation. The pump persists `event.eventId` as `runtimeEventKey` through one `ingestRuntimeEvent` transaction, which alone writes completed Messages and terminal state. Equal payloads remain separate; equal eventId is an idempotent replay.
7. `cancelRun` gets the same authorized execution context and evaluates `RuntimeCancelAck`. For `accepted`, it ensures the pump is started and awaits `waitForTerminal` up to `CANCEL_TERMINAL_TIMEOUT_MS`; a cancelled terminal returns terminal, while timeout atomically marks `reconciling`. Known `observedTerminal` is converted to a deterministic normalized terminal event keyed by the cancel command and ingested through the same transaction. `unknown/not-active` without proof also transitions to `reconciling`. S1 therefore returns only terminal or reconciling, never an unowned durable `cancellation-requested` state.
8. Any exception after dispatch permission is treated as outcome unknown unless `RuntimeAdapterError.operationEffect === 'not-applied'`. A known external ref is persisted before attach. Attach failure atomically marks the receipt reconciling and upserts compensation; unknown ref stores lookup metadata. If attach actually committed but its response was lost, that update must observe `attached` and never regress it.
9. On retry, `attached` returns the stored Canvas result without Runtime I/O; `runtime_dispatched/runtime_known/reconciling` returns `CommandRequiresReconciliationError`, mapped to HTTP 202 with `commandReceiptId` and `Retry-After`. The client polls by safely repeating the same idempotent POST; only `canvas_prepared/retryable_failure` can receive a new dispatch lease. Apply this rule to root, anchor, fork and Run commands, including after Repository close/reopen.

`run-event-pump.test.ts` uses a deferred Runtime stream to prove: startRun registers one consumer; accepted cancel releases a `run.cancelled` event and persists terminal; no event before timeout yields `reconciling`; duplicate start/cancel uses one consumer; stream failure is observed; and the HTTP events reader can subsequently read the persisted terminal without calling Runtime itself. `session-service.test.ts` additionally proves successful-command retry makes one Runtime call total, split attach failure records one compensation, transport unknown is not redispatched, and all three behaviors survive a new Repository instance.

- [ ] **Step 5: Run unit tests, typecheck, update Docker package copy, and commit**

Add to the Dockerfile dependency-copy block:

```dockerfile
COPY packages/control-plane/package.json packages/control-plane/package.json
```

Run:

```bash
pnpm vitest run packages/control-plane/src/session-service.test.ts
pnpm --filter @ai-super-canvas/control-plane typecheck
pnpm install --frozen-lockfile
```

Expected: PASS and lockfile unchanged after the frozen install.

```bash
git add packages/control-plane Dockerfile pnpm-lock.yaml
git commit -m "feat(control-plane): orchestrate sessions and runtime runs"
```

### Task 6: Expose local-alpha API routes and replayable events

**Files:**
- Create: `apps/web/src/server/control-plane.ts`
- Create: `apps/web/src/app/api/control-plane/bootstrap/route.ts`
- Create: `apps/web/src/app/api/control-plane/workflows/[workflowId]/sessions/anchor/route.ts`
- Create: `apps/web/src/app/api/control-plane/sessions/route.ts`
- Create: `apps/web/src/app/api/control-plane/sessions/[sessionId]/fork/route.ts`
- Create: `apps/web/src/app/api/control-plane/sessions/[sessionId]/runs/route.ts`
- Create: `apps/web/src/app/api/control-plane/runs/[runId]/events/route.ts`
- Create: `apps/web/src/app/api/control-plane/runs/[runId]/cancel/route.ts`
- Create: `apps/web/src/app/api/control-plane/route-contract.test.ts`
- Modify: `apps/web/package.json`
- Modify: `.env.example`
- Modify: `compose.yaml`

- [ ] **Step 1: Write failing route contract tests**

```ts
// apps/web/src/app/api/control-plane/route-contract.test.ts
import { describe, expect, it, vi } from 'vitest';
import { makeCreateSessionHandler } from './sessions/route';

describe('control-plane routes', () => {
  it('creates a Session using the server account, not a client account id', async () => {
    const service = {
      createRootSession: vi.fn().mockResolvedValue({
        sessionId: '20202020-2020-4020-8020-202020202020',
        nodeId: '21212121-2121-4121-8121-212121212121',
        status: 'active',
      }),
    };
    const handler = makeCreateSessionHandler({
      service: service as never,
      actor: {
        accountId: '22222222-2222-4222-8222-222222222222',
        authSubject: 'local:test-owner',
      },
    });
    const response = await handler(new Request('http://localhost/api/control-plane/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: '23232323-2323-4323-8323-232323232323',
        workflowId: '24242424-2424-4424-8424-242424242424',
        agentBindingId: '25252525-2525-4525-8525-252525252525',
        title: '主会话',
        accountId: 'attacker-controlled-value',
      }),
    }));

    expect(response.status).toBe(201);
    expect(service.createRootSession).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({
        accountId: '22222222-2222-4222-8222-222222222222',
        authSubject: 'local:test-owner',
      }),
    }));
  });
});
```

The same test file must cover malformed JSON (400, not 500), bootstrap idempotency, fork path/parent mismatch (409), SSE authorization, cancel accepted/unknown/terminal responses, `CommandRequiresReconciliationError` mapping to 202 + `Retry-After` without a second Runtime call, and a forged `accountId/authSubject` in JSON never replacing the injected ActorContext.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
```

Expected: FAIL because the route factory does not exist.

- [ ] **Step 3: Build the server-only dependency and create Session route**

`apps/web/src/server/control-plane.ts` must create the PostgreSQL repository, DeterministicFakeRuntime, RunEventPump and SessionService only on the server, then invoke `eventPump.reconcileAfterRestart()` once with an observed Promise before serving control-plane routes. It reads `APP_OWNER_SUBJECT` (default `local:owner`) as a stable auth subject, never as a database UUID, and never accepts actor identity from request JSON. Export `getControlPlane()` and async `getLocalActorContext()`; the latter must call `repository.resolveActorContext({ authSubject })` on the current repository instance and fail closed when absent—no module cache may synthesize an Account ID. In local-alpha, `POST /api/control-plane/bootstrap` idempotently creates/loads Account, owned default Agent, Fake Binding, Workspace plus owner membership, first TrunkRevision and Workflow, then returns all Canvas IDs. The route is enabled only when `AUTH_MODE=local`; production auth replaces this boundary.

Add non-secret bootstrap configuration to `.env.example`:

```dotenv
AUTH_MODE=local
APP_OWNER_SUBJECT=local:owner
```

Replace the deprecated `APP_OWNER_ID` entry in `compose.yaml` without changing its port mapping:

```yaml
environment:
  AUTH_MODE: ${AUTH_MODE:-local}
  APP_OWNER_SUBJECT: ${APP_OWNER_SUBJECT:-local:owner}
```

```ts
// apps/web/src/app/api/control-plane/sessions/route.ts
import { z } from 'zod';
import type { ActorContext } from '@ai-super-canvas/core';
import type { SessionService } from '@ai-super-canvas/control-plane';
import { getControlPlane, getLocalActorContext } from '@/server/control-plane';

interface Dependencies {
  service: SessionService;
  actor: ActorContext;
}

const CreateSessionRequestSchema = z.object({
  commandId: z.string().uuid(),
  workflowId: z.string().uuid(),
  agentBindingId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
});

export function makeCreateSessionHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: { code: 'malformed_json' } }, { status: 400 });
    }
    const parsed = CreateSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({
        error: { code: 'invalid_request', issues: parsed.error.issues },
      }, { status: 400 });
    }
    const result = await dependencies.service.createRootSession({
      commandId: parsed.data.commandId,
      actor: dependencies.actor,
      workflowId: parsed.data.workflowId,
      agentBindingId: parsed.data.agentBindingId,
      title: parsed.data.title,
    });
    return Response.json(result, { status: 201 });
  };
}

export async function POST(request: Request): Promise<Response> {
  return makeCreateSessionHandler({
    service: getControlPlane(),
    actor: await getLocalActorContext(),
  })(request);
}
```

- [ ] **Step 4: Add fork, Run and event replay routes**

Request/response contracts:

```text
POST /api/control-plane/bootstrap
  body: { commandId, displayName? }
  result: 200 { accountId, agentId, agentBindingId, workspaceId, workflowId, trunkRevisionId }

POST /api/control-plane/workflows/:workflowId/sessions/anchor
  body: CreateAnchoredSessionCommand without ActorContext; path workflowId must match body
  result: 201 { sessionId, nodeId, status }

POST /api/control-plane/sessions/:sessionId/fork
  body: ForkMessageSessionCommand without ActorContext; path sessionId must equal parentSessionId
  result: 201 { sessionId, nodeId, status }

POST /api/control-plane/sessions/:sessionId/runs
  body: { commandId, idempotencyKey, content }
  result: 202 { runId, status }

GET /api/control-plane/runs/:runId/events?after=0
  authorization: repository verifies injected ActorContext membership
  result: text/event-stream; each frame uses Canvas RunEvent sequence as id

POST /api/control-plane/runs/:runId/cancel
  body: { commandId }
  result: 202 { state: reconciling } or 200 { state: terminal }
```

The event route writes exact frames:

```ts
const frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
controller.enqueue(new TextEncoder().encode(frame));
```

It sends all already-persisted events with `sequence > after`, then closes in S1. `RunEventPump` independently continues Runtime→Canvas ingestion; browser polling/reconnection repeats the GET with the last sequence until a terminal arrives. A continuously open push stream may replace polling in S2/S3, but it does not replace the pump.

- [ ] **Step 5: Verify route contracts, typecheck and commit**

Add `@ai-super-canvas/control-plane` and `zod: 4.4.3` to `apps/web/package.json` dependencies, then run:

```bash
pnpm install --lockfile-only
pnpm vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
pnpm --filter @ai-super-canvas/web typecheck
```

Expected: PASS; invalid UUID/body tests return 400, mismatched fork path returns 409, unauthorized resource returns 404 without leaking existence.

```bash
git add apps/web/src/server apps/web/src/app/api/control-plane apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): expose agent session control-plane API"
```

### Task 7: Add an idempotent WorkspaceState v1 import projection

**Files:**
- Create: `packages/core/src/agent-session/legacy-import.ts`
- Create: `packages/core/src/agent-session/legacy-import.test.ts`
- Modify: `packages/core/src/agent-session/index.ts`

- [ ] **Step 1: Write a failing import projection test**

```ts
// packages/core/src/agent-session/legacy-import.test.ts
import { describe, expect, it } from 'vitest';
import { createDemoWorkspace } from '../workspace';
import { projectWorkspaceV1Import } from './legacy-import';

describe('WorkspaceState v1 import', () => {
  it('maps every legacy Branch to one Session and SessionNode', () => {
    const workspace = createDemoWorkspace();
    const projected = projectWorkspaceV1Import(workspace, {
      accountId: '26262626-2626-4626-8626-262626262626',
      workflowId: '27272727-2727-4727-8727-272727272727',
      agentBindingId: '28282828-2828-4828-8828-282828282828',
    });
    expect(projected.sessions).toHaveLength(workspace.branches.length);
    expect(projected.sessionNodes).toHaveLength(workspace.branches.length);
    expect(new Set(projected.sessionNodes.map((node) => node.sessionId)).size)
      .toBe(workspace.branches.length);
    expect(projected.warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm vitest run packages/core/src/agent-session/legacy-import.test.ts
```

Expected: FAIL because `legacy-import.ts` does not exist.

- [ ] **Step 3: Implement a pure import projection**

The function must:

1. validate `WorkspaceState.version === 1` and all branch/anchor/message/card references;
2. use deterministic UUIDs derived from `workflowId + legacy kind + legacy id`, so the same input maps to the same Canvas IDs;
3. map each Branch to one Session/SessionNode and one derives Edge;
4. preserve Unicode code-point selectors and source revision IDs;
5. order Messages by original array index, using timestamps only as metadata;
6. map ready cards to ready Artifact/pending Proposal import records with `provenanceMode = legacy_import`, nullable source Run, and audited importer/source/content digest provenance;
7. map integrated cards only when `integratedRevisionId` exists, otherwise emit `integrated_card_missing_revision`;
8. move `modelByNodeId` out of layout into unresolved Session model selections;
9. return structured warnings; never silently drop an object.

Use `@noble/hashes/sha256` already present in `packages/core` to derive a stable 16-byte UUID with RFC 4122 version/variant bits. Do not use `Date.now()` or the current `workspace.ts` ID generator.

- [ ] **Step 4: Add malformed and repeatability tests**

Add tests proving:

- the same WorkspaceState produces byte-for-byte equal import projection;
- a missing Anchor fails before returning partial data;
- an integrated card without revision produces one warning;
- CJK and emoji selectors preserve code-point offsets;
- no Runtime external ID is generated during import.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm vitest run packages/core/src/agent-session/legacy-import.test.ts
pnpm --filter @ai-super-canvas/core typecheck
```

Expected: PASS for deterministic and malformed fixtures.

```bash
git add packages/core/src/agent-session
git commit -m "feat(core): project legacy workspace into session graph import"
```

### Task 8: Verify the S1 Golden Path and update execution evidence

**Files:**
- Create: `tests/integration/control-plane-golden-path.test.ts`
- Modify: `docs/architecture/development-roadmap.md`
- Modify: `docs/architecture/README.md`

- [ ] **Step 1: Write the database-backed Golden Path test**

The test starts from an empty isolated database and invokes the same idempotent local-alpha bootstrap service used by the API; it must not call a hidden identity fixture. Then execute:

```text
bootstrap Account/default owned Agent/Fake Binding/Workspace/Workflow
create one Trunk-anchored Session and verify its derives edge has null source SessionNode
create root Session
start Fake Run
RunEventPump ingests six normalized events, including two identical deltas with different eventId
events API polls persisted rows until terminal without calling Runtime
fork at completed user Message
continue parent and child independently
close Repository, Runtime and SessionService
create fresh Repository, FakeRuntime and SessionService instances
load both Canvas Session transcripts and Run events through authorized Repository queries
assert fresh FakeRuntime cannot load old refs and declares persistentSessions=unsupported
```

S1 proves Canvas persistence and truthful capability negotiation. It deliberately does not claim FakeRuntime process persistence; S2 must prove Runtime restart recovery against the Hermes gate before the product promises it.

Assertions:

```ts
expect(parentTranscript).not.toEqual(childTranscript);
expect(childTranscript.slice(0, forkOrdinal + 1)).toEqual(parentPrefix);
expect(parentStatus).toBe('active');
expect(childStatus).toBe('active');
expect(runEvents.at(-1)?.type).toBe('run.completed');
expect(new Set(runEvents.map((event) => event.sequence)).size).toBe(runEvents.length);
```

- [ ] **Step 2: Run focused and full verification**

Run:

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm --build test vitest run tests/integration/control-plane-golden-path.test.ts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0. No live model key is required; no new host port is opened.

- [ ] **Step 3: Run migration-from-empty twice**

Run:

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml down -v --remove-orphans
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml up -d postgres-test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm --build test --filter @ai-super-canvas/db db:migrate
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm --build test --filter @ai-super-canvas/db db:migrate
```

Expected: first run applies migrations; second run reports no pending migration and exits 0. Before and after this block, if `ai-super-canvas-postgres` exists, record `docker volume inspect ai-super-canvas-postgres --format '{{.Mountpoint}}'` and assert the value is unchanged. Never create, mount, or delete that volume from the S1 test project.

- [ ] **Step 4: Record evidence without claiming Hermes readiness**

Update the S1 section of `docs/architecture/development-roadmap.md` with the commit SHA, migration name, test command and pass counts. Keep S2 marked blocked until `docs/architecture/hermes-acp-capability-gates.md` is executed against a fixed Hermes artifact.

- [ ] **Step 5: Commit the completed foundation**

```bash
git add tests/integration/control-plane-golden-path.test.ts docs/architecture
git commit -m "test: prove agent session control-plane golden path"
```

## Self-review checklist

Before handing this plan to an implementation agent:

- [ ] Every S1 entity maps to the accepted domain document.
- [ ] `Account`, `Agent`, `Session`, and `Run` remain separate IDs and types.
- [ ] `session_runtime_refs` prevents Runtime IDs from entering Session primary keys.
- [ ] Branch from Trunk and fork from Message are both representable.
- [ ] A parent Session remains active after fork.
- [ ] Run events are ordered/idempotent; event row, completed Message and terminal Run projection commit atomically.
- [ ] Fault injection at every ingestion stage rolls back fully and replay repairs without duplicate projection.
- [ ] `reconciling` is persisted and still blocks a second active Run; cancel uses structured ack plus terminal event.
- [ ] Every Runtime capability declared native/adapter has a registered contract test; Fake persistence/policy gaps remain unsupported.
- [ ] Model and tool snapshots come from server policy, never Canvas layout state.
- [ ] No API route trusts `accountId`, model allowlist, or tool grants from request JSON.
- [ ] ActorContext reaches fork, Run ingestion, cancellation and event replay Repository queries.
- [ ] The standalone test Compose project creates no host listener and cannot reference/delete `ai-super-canvas-postgres`.
- [ ] Destructive reset has NODE_ENV, explicit opt-in, host and `_test` database-name guards.
- [ ] Bootstrap from an empty database returns usable Account/Agent/Binding/Workspace/Workflow IDs without hidden fixtures.
- [ ] Concurrent bootstrap is serialized by its pre-Account receipt; payload mismatch conflicts.
- [ ] An attached command retry performs zero Runtime calls; dispatched/known/unknown commands reconcile and never redispatch blindly after restart.
- [ ] No Hermes, Letta, OpenAI, or real provider SDK type appears in `packages/core`, `packages/db`, or `packages/control-plane` public interfaces.
- [ ] No implementation step edits the existing Chat UI before the control-plane Golden Path passes.

## Execution handoff

After this plan is accepted, execute it with `superpowers:subagent-driven-development`. Use one fresh implementation agent per task and two-stage review after each task. Do not combine S1 with Hermes S2 in the same commit series.

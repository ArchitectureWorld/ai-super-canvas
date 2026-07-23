# Server-Persisted Session Application Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `@ai-super-canvas/control-plane` application package，用服务器拥有的策略编排 root Session、Run、Runtime 事件持久化、transcript 读取和 FakeRuntime 重启可用性探测。

**Architecture:** `SessionService` 是 HTTP 层与现有 Repository/Runtime 契约之间的唯一业务入口；`RunEventPump` 是每个 Run 唯一的进程内 Runtime event consumer；`runtime-event-mapper.ts` 穷尽映射 Runtime union。应用层不执行 SQL、不依赖 Next.js，也不把 external Runtime ref 暴露进公开 DTO。

**Tech Stack:** TypeScript 6.0.3、Node.js 24.18.0、pnpm 11.15.1 workspace、Vitest 4.1.10、现有 `@ai-super-canvas/core`、`@ai-super-canvas/ai` 和 `@ai-super-canvas/db` 契约。

## Global Constraints

- 权威设计：`docs/superpowers/specs/2026-07-23-server-persisted-session-vertical-slice-design.md`。
- 计划编写基线：`main` 的 `2a06bff4a2ed10e6fde7e746313cbea069b9a53a`；执行前必须重新 fetch，并从最新 `origin/main` 建立新的隔离 worktree。
- 本计划只交付设计规格第 12 节的 **Application PR**；不修改 `apps/web`、Route Handler、`/control-plane-test`、Hermes、现有 `/` 画布或 World Canvas。
- application package 只依赖 `@ai-super-canvas/core`、`@ai-super-canvas/ai`、`@ai-super-canvas/db`；禁止依赖 React、Next.js、`postgres` 或 Drizzle。
- 所有 Runtime dispatch 先取得 Repository dispatch lease；所有 external ref 先 `recordRuntimeResourceKnown`，再 attach。
- `RuntimeAdapterError.operationEffect === "not-applied"` 才能进入失败/可重试路径；其他 Runtime 结果一律进入 reconciliation，禁止盲目再次 dispatch。
- `RunEventPump` 只提供单进程互斥，不宣称多副本安全；多副本 lease/worker 不属于本 PR。
- 公开 DTO 不包含 `externalSessionRef`、`externalRunRef`、`externalEventRef`、`runtimeEventKey`、`secretRef` 或内部错误文本。
- Fake 模型、工具策略和 ActorContext 都由服务端输入或 Repository snapshot 决定；环境变量和浏览器不能覆盖 Run 的模型与工具策略。
- 每个任务遵循 red-green-refactor：先写失败测试并观察目标失败，再写最小实现；每个任务使用独立提交。
- 任何任务提交前至少通过该任务的 focused test 与 `@ai-super-canvas/control-plane` typecheck；最终任务运行 lint、typecheck、全部 unit test 和 root build。

---

## File Map

### Workspace wiring

- Create: `packages/control-plane/package.json` — workspace manifest、脚本和三项内部依赖。
- Create: `packages/control-plane/tsconfig.json` — Node 24 严格 TypeScript 配置。
- Modify: `pnpm-lock.yaml` — 新 workspace importer。
- Modify: `Dockerfile` — dependencies stage 复制新 package manifest。

### Stable application contract

- Create: `packages/control-plane/src/dto.ts` — server/API 可依赖的 application input/output DTO；不含 external Runtime ref。
- Create: `packages/control-plane/src/errors.ts` — 稳定 application error code、safe message、retryable 和 command receipt 信息。
- Create: `packages/control-plane/src/index.ts` — 只导出 DTO、error、`RunEventPump` 和 `SessionService`。

### Runtime orchestration

- Create: `packages/control-plane/src/runtime-event-mapper.ts` — 穷尽映射每个 `RuntimeEvent` 到 `PersistableRunEvent`。
- Create: `packages/control-plane/src/run-event-pump.ts` — 单消费者注册、event ingest、终态 history digest 同步、提前结束 reconciliation 和异步错误捕获。
- Create: `packages/control-plane/src/session-service.ts` — bootstrap、root Session、Run、事件页、transcript 和 Runtime availability 编排。

### Unit tests

- Create: `packages/control-plane/src/runtime-event-mapper.test.ts` — 覆盖 Runtime union 的每个成员及 message/terminal 投影。
- Create: `packages/control-plane/src/errors.test.ts` — 稳定错误字段与 safe message。
- Create: `packages/control-plane/src/run-event-pump.test.ts` — 单消费者、终态、身份错配、提前结束和未观察 Promise。
- Create: `packages/control-plane/src/session-service.test.ts` — dispatch/attach 顺序、幂等 replay、`not-applied`/`unknown`、Run 启动、读取和重启探测。

## Public Interfaces Locked by This Plan

```ts
export class SessionService {
  constructor(
    repository: ControlPlaneRepository,
    runtime: RuntimeAdapter,
    eventPump: RunEventPumpPort,
  );

  bootstrapLocalAlpha(input: BootstrapLocalAlphaInput): Promise<LocalAlphaBootstrapDto>;
  createRootSession(input: CreateRootSessionInput): Promise<CreatedSessionDto>;
  startRun(input: StartSessionRunInput): Promise<StartedRunDto>;
  getRunEvents(input: GetRunEventsInput): Promise<RunEventsPageDto>;
  getSessionTranscript(
    input: GetSessionTranscriptInput,
  ): Promise<SessionTranscriptDto>;
}

export class RunEventPump implements RunEventPumpPort {
  start(input: { actor: ActorContext; runId: string }): 'started' | 'already-active';
  waitForIdle(runId: string): Promise<void>;
  reconcileAfterRestart(): Promise<number>;
}

export function mapRuntimeEvent(event: RuntimeEvent): PersistableRunEvent;
```

`mapRuntimeEvent` 保持 package-internal，不从 `src/index.ts` 导出；API PR 只能依赖 `SessionService`、`RunEventPump`、DTO 和 application error。

---

### Task 1: Scaffold the package and exhaustively map Runtime events

**Files:**
- Create: `packages/control-plane/package.json`
- Create: `packages/control-plane/tsconfig.json`
- Create: `packages/control-plane/src/index.ts`
- Create: `packages/control-plane/src/runtime-event-mapper.test.ts`
- Create: `packages/control-plane/src/runtime-event-mapper.ts`
- Modify: `Dockerfile`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `RuntimeEvent` from `@ai-super-canvas/ai`; `PersistableRunEvent` from `@ai-super-canvas/db`.
- Produces: internal `mapRuntimeEvent(event: RuntimeEvent): PersistableRunEvent`, used by Task 3.

- [ ] **Step 1: Create the workspace manifest and TypeScript configuration**

Create `packages/control-plane/package.json`:

```json
{
  "name": "@ai-super-canvas/control-plane",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
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

Create `packages/control-plane/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

Create the initial `packages/control-plane/src/index.ts`:

```ts
export {};
```

Add this line after the existing `packages/ai/package.json` copy in the Dockerfile dependencies stage:

```dockerfile
COPY packages/control-plane/package.json packages/control-plane/package.json
```

Regenerate only the workspace lockfile with the repository-pinned pnpm:

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$PWD:/workspace" \
  -w /workspace \
  node:24.18.0-bookworm-slim \
  npx --yes pnpm@11.15.1 install --lockfile-only
```

Expected: `pnpm-lock.yaml` gains an importer for `packages/control-plane`; no dependency version changes outside workspace links.

- [ ] **Step 2: Write the failing mapper test**

Create `packages/control-plane/src/runtime-event-mapper.test.ts`:

```ts
import type { RuntimeEvent } from '@ai-super-canvas/ai';
import { describe, expect, it } from 'vitest';

import { mapRuntimeEvent } from './runtime-event-mapper';

const base = {
  canvasSessionId: '11111111-1111-4111-8111-111111111111',
  canvasRunId: '22222222-2222-4222-8222-222222222222',
  occurredAt: new Date(0).toISOString(),
};

const passiveEvents: RuntimeEvent[] = [
  {
    ...base,
    eventId: 'event-accepted',
    type: 'run.accepted',
    externalRunRef: 'fake-run-1',
  },
  { ...base, eventId: 'event-started', type: 'run.started' },
  {
    ...base,
    eventId: 'event-delta',
    type: 'model.output.delta',
    text: 'fake ',
  },
  {
    ...base,
    eventId: 'event-tool-requested',
    type: 'tool.requested',
    toolCallRef: 'tool-call-1',
    toolKey: 'search',
    input: { query: 'canvas' },
  },
  {
    ...base,
    eventId: 'event-approval',
    type: 'approval.required',
    approvalRef: 'approval-1',
    toolCallRef: 'tool-call-1',
    toolKey: 'search',
    risk: 'low',
    choices: ['allow-once', 'deny'],
  },
  {
    ...base,
    eventId: 'event-tool-started',
    type: 'tool.started',
    toolCallRef: 'tool-call-1',
  },
  {
    ...base,
    eventId: 'event-tool-delta',
    type: 'tool.output.delta',
    toolCallRef: 'tool-call-1',
    content: 'partial',
  },
  {
    ...base,
    eventId: 'event-tool-completed',
    type: 'tool.completed',
    toolCallRef: 'tool-call-1',
    output: { result: 'done' },
    isError: false,
  },
  {
    ...base,
    eventId: 'event-artifact',
    type: 'artifact.updated',
    artifactKind: 'text',
    title: 'Result',
    content: 'artifact',
  },
  {
    ...base,
    eventId: 'event-warning',
    type: 'runtime.warning',
    code: 'slow',
    message: 'Runtime is slow',
  },
];

describe('mapRuntimeEvent', () => {
  it.each(passiveEvents)('preserves $type without inventing a projection', (event) => {
    expect(mapRuntimeEvent(event)).toEqual({
      runtimeEventKey: event.eventId,
      eventType: event.type,
      payload: event,
      occurredAt: event.occurredAt,
    });
  });

  it('projects completed messages exactly once', () => {
    const event: RuntimeEvent = {
      ...base,
      eventId: 'event-message',
      externalEventRef: 'fake-run-1:event:5',
      type: 'message.completed',
      role: 'assistant',
      content: 'fake fake ',
      externalMessageRef: 'fake-run-1:message:1',
    };

    expect(mapRuntimeEvent(event)).toEqual({
      runtimeEventKey: event.eventId,
      eventType: 'message.completed',
      payload: event,
      externalEventRef: 'fake-run-1:event:5',
      occurredAt: event.occurredAt,
      message: {
        role: 'assistant',
        content: 'fake fake ',
        externalMessageRef: 'fake-run-1:message:1',
      },
    });
  });

  it.each([
    [
      {
        ...base,
        eventId: 'event-completed',
        type: 'run.completed',
      } satisfies RuntimeEvent,
      { status: 'succeeded' },
    ],
    [
      {
        ...base,
        eventId: 'event-failed',
        type: 'run.failed',
        code: 'runtime_unavailable',
        message: 'offline',
        retryable: true,
      } satisfies RuntimeEvent,
      {
        status: 'failed',
        errorCode: 'runtime_unavailable',
        errorMessage: 'offline',
      },
    ],
    [
      {
        ...base,
        eventId: 'event-cancelled',
        type: 'run.cancelled',
        reason: 'user',
      } satisfies RuntimeEvent,
      { status: 'cancelled' },
    ],
  ] as const)('projects terminal event %s', (event, terminal) => {
    expect(mapRuntimeEvent(event).terminal).toEqual(terminal);
  });
});
```

- [ ] **Step 3: Run the focused test and observe the intended failure**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/runtime-event-mapper.test.ts
```

Expected: FAIL because `./runtime-event-mapper` does not exist. Dependency installation and test discovery must already succeed.

- [ ] **Step 4: Implement the exhaustive mapper**

Create `packages/control-plane/src/runtime-event-mapper.ts`:

```ts
import type { RuntimeEvent } from '@ai-super-canvas/ai';
import type { PersistableRunEvent } from '@ai-super-canvas/db';

function assertNever(value: never): never {
  throw new Error(`Unhandled Runtime event: ${JSON.stringify(value)}`);
}

function baseEvent(event: RuntimeEvent): PersistableRunEvent {
  return {
    runtimeEventKey: event.eventId,
    eventType: event.type,
    payload: event,
    ...(event.externalEventRef === undefined
      ? {}
      : { externalEventRef: event.externalEventRef }),
    occurredAt: event.occurredAt,
  };
}

export function mapRuntimeEvent(event: RuntimeEvent): PersistableRunEvent {
  const base = baseEvent(event);
  switch (event.type) {
    case 'message.completed':
      return {
        ...base,
        message: {
          role: event.role,
          content: event.content,
          ...(event.externalMessageRef === undefined
            ? {}
            : { externalMessageRef: event.externalMessageRef }),
        },
      };
    case 'run.completed':
      return { ...base, terminal: { status: 'succeeded' } };
    case 'run.failed':
      return {
        ...base,
        terminal: {
          status: 'failed',
          errorCode: event.code,
          errorMessage: event.message,
        },
      };
    case 'run.cancelled':
      return { ...base, terminal: { status: 'cancelled' } };
    case 'run.accepted':
    case 'run.started':
    case 'model.output.delta':
    case 'tool.requested':
    case 'approval.required':
    case 'tool.started':
    case 'tool.output.delta':
    case 'tool.completed':
    case 'artifact.updated':
    case 'runtime.warning':
      return base;
    default:
      return assertNever(event);
  }
}
```

The `default` branch must receive `never`; adding a new Runtime union member must fail typecheck until this switch is updated.

- [ ] **Step 5: Run mapper checks and commit**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/runtime-event-mapper.test.ts
docker run --rm ai-super-canvas:control-plane-tdd \
  --filter @ai-super-canvas/control-plane typecheck
docker run --rm ai-super-canvas:control-plane-tdd \
  install --frozen-lockfile
git add Dockerfile pnpm-lock.yaml packages/control-plane
git commit -m "feat(control-plane): map runtime events"
```

Expected: mapper tests and typecheck pass; frozen install produces no lockfile diff.

---

### Task 2: Define stable DTOs and application errors

**Files:**
- Create: `packages/control-plane/src/dto.ts`
- Create: `packages/control-plane/src/errors.test.ts`
- Create: `packages/control-plane/src/errors.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Consumes: `ActorContext` and `StoredRunStatus`.
- Produces: all `SessionService` input/output DTOs and `ControlPlaneApplicationError`.

- [ ] **Step 1: Write the failing error-contract test**

Create `packages/control-plane/src/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { ControlPlaneApplicationError } from './errors';

describe('ControlPlaneApplicationError', () => {
  it('exposes only a stable code, safe message, retryability and receipt id', () => {
    const cause = new Error('postgres://secret@internal/runtime_ref=fake-1');
    const error = new ControlPlaneApplicationError(
      'command_requires_reconciliation',
      'Runtime command requires reconciliation',
      true,
      '33333333-3333-4333-8333-333333333333',
      { cause },
    );

    expect(error).toMatchObject({
      name: 'ControlPlaneApplicationError',
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      retryable: true,
      commandReceiptId: '33333333-3333-4333-8333-333333333333',
      cause,
    });
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain('fake-1');
  });
});
```

- [ ] **Step 2: Run the test and observe the missing module**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/errors.test.ts
```

Expected: FAIL because `./errors` does not exist.

- [ ] **Step 3: Implement stable errors**

Create `packages/control-plane/src/errors.ts`:

```ts
export type ControlPlaneApplicationErrorCode =
  | 'command_requires_reconciliation'
  | 'runtime_operation_failed'
  | 'runtime_session_unavailable';

export class ControlPlaneApplicationError extends Error {
  constructor(
    readonly code: ControlPlaneApplicationErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly commandReceiptId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ControlPlaneApplicationError';
  }
}

export function commandRequiresReconciliation(
  commandReceiptId: string,
  cause?: unknown,
): ControlPlaneApplicationError {
  return new ControlPlaneApplicationError(
    'command_requires_reconciliation',
    'Runtime command requires reconciliation',
    true,
    commandReceiptId,
    { cause },
  );
}

export function runtimeOperationFailed(
  commandReceiptId: string,
  retryable: boolean,
  cause?: unknown,
): ControlPlaneApplicationError {
  return new ControlPlaneApplicationError(
    'runtime_operation_failed',
    'Runtime operation failed',
    retryable,
    commandReceiptId,
    { cause },
  );
}

export function runtimeSessionUnavailable(
  commandReceiptId?: string,
  cause?: unknown,
): ControlPlaneApplicationError {
  return new ControlPlaneApplicationError(
    'runtime_session_unavailable',
    'Runtime Session is unavailable; create a new test Session',
    false,
    commandReceiptId,
    { cause },
  );
}

```

- [ ] **Step 4: Define the application DTO contract**

Create `packages/control-plane/src/dto.ts`:

```ts
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
```

- [ ] **Step 5: Export only the stable surface, run checks and commit**

Replace `packages/control-plane/src/index.ts` with:

```ts
export * from './dto';
export * from './errors';
```

Run:

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/errors.test.ts
docker run --rm ai-super-canvas:control-plane-tdd \
  --filter @ai-super-canvas/control-plane typecheck
git add packages/control-plane/src/dto.ts \
  packages/control-plane/src/errors.ts \
  packages/control-plane/src/errors.test.ts \
  packages/control-plane/src/index.ts
git commit -m "feat(control-plane): define application contracts"
```

Expected: error test and typecheck pass; public DTOs contain no external Runtime-reference fields.

---

### Task 3: Implement the single-consumer RunEventPump

**Files:**
- Create: `packages/control-plane/src/run-event-pump.test.ts`
- Create: `packages/control-plane/src/run-event-pump.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Consumes: `mapRuntimeEvent`, `ControlPlaneRepository.getRunRuntimeContext`, `ingestRuntimeEvent`, `syncRuntimeSessionHistory`, `markRunReconciling`, `reconcileOrphanedRuns`, and `RuntimeAdapter.streamRunEvents/loadSession`.
- Produces: `RunEventPumpPort` and `RunEventPump`.

- [ ] **Step 1: Write failing tests for single consumption and terminal persistence**

Create `packages/control-plane/src/run-event-pump.test.ts`:

```ts
import type { RuntimeAdapter, RuntimeEvent } from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type {
  ControlPlaneRepository,
  PersistableRunEvent,
} from '@ai-super-canvas/db';
import { describe, expect, it, vi } from 'vitest';

import { RunEventPump } from './run-event-pump';

const actor: ActorContext = {
  accountId: '11111111-1111-4111-8111-111111111111',
  authSubject: 'local:test-owner',
};

const context = {
  actor,
  workflowId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  runId: '44444444-4444-4444-8444-444444444444',
  status: 'running' as const,
  binding: {
    canvasAgentBindingId: '55555555-5555-4555-8555-555555555555',
    agentId: '66666666-6666-4666-8666-666666666666',
    runtimeKind: 'fake',
    isolationKey: 'local-alpha',
  },
  externalSessionRef: 'fake-session-1',
  externalRunRef: 'fake-run-1',
};

function stream(events: RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function terminalEvents(): RuntimeEvent[] {
  const base = {
    canvasSessionId: context.sessionId,
    canvasRunId: context.runId,
    occurredAt: new Date(0).toISOString(),
  };
  return [
    {
      ...base,
      eventId: 'fake-run-1:event:5',
      externalEventRef: 'fake-run-1:event:5',
      type: 'message.completed',
      role: 'assistant',
      content: 'fake fake ',
      externalMessageRef: 'fake-run-1:message:1',
    },
    {
      ...base,
      eventId: 'fake-run-1:event:6',
      externalEventRef: 'fake-run-1:event:6',
      type: 'run.completed',
    },
  ];
}

function createHarness(events: RuntimeEvent[]) {
  const repository = {
    getRunRuntimeContext: vi.fn().mockResolvedValue(context),
    ingestRuntimeEvent: vi.fn().mockImplementation(async (
      { event }: { event: PersistableRunEvent },
    ) => ({
      runId: context.runId,
      sequence: event.runtimeEventKey.endsWith(':5') ? 1 : 2,
      eventType: event.eventType,
      payload: event.payload,
      externalEventRef: event.externalEventRef ?? null,
      runtimeEventKey: event.runtimeEventKey,
      occurredAt: event.occurredAt,
    })),
    syncRuntimeSessionHistory: vi.fn().mockResolvedValue(undefined),
    markRunReconciling: vi.fn().mockResolvedValue(undefined),
    reconcileOrphanedRuns: vi.fn().mockResolvedValue(0),
  };
  const runtime = {
    streamRunEvents: vi.fn().mockImplementation(() => stream(events)),
    loadSession: vi.fn().mockResolvedValue({
      externalSessionRef: context.externalSessionRef,
      runtimeVersion: '1',
      replayStatus: 'complete',
      historyDigest: 'sha256:after-run',
      metadata: {},
    }),
  };
  const logger = { error: vi.fn() };
  return {
    repository,
    runtime,
    logger,
    pump: new RunEventPump(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      logger,
    ),
  };
}

describe('RunEventPump', () => {
  it('opens one Runtime stream and persists one terminal sequence', async () => {
    const harness = createHarness(terminalEvents());

    expect(harness.pump.start({ actor, runId: context.runId })).toBe('started');
    expect(harness.pump.start({ actor, runId: context.runId })).toBe('already-active');
    await harness.pump.waitForIdle(context.runId);

    expect(harness.runtime.streamRunEvents).toHaveBeenCalledTimes(1);
    expect(harness.repository.ingestRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(harness.repository.syncRuntimeSessionHistory).toHaveBeenCalledWith({
      actor,
      sessionId: context.sessionId,
      historyDigest: 'sha256:after-run',
    });
    expect(harness.repository.markRunReconciling).not.toHaveBeenCalled();
  });

  it('marks a Run reconciling when the stream ends without a terminal event', async () => {
    const harness = createHarness([]);

    harness.pump.start({ actor, runId: context.runId });
    await harness.pump.waitForIdle(context.runId);

    expect(harness.repository.markRunReconciling).toHaveBeenCalledWith({
      actor,
      runId: context.runId,
      error: 'runtime_event_stream_ended_without_terminal:none',
    });
  });

  it('rejects an event that names another Canvas Run', async () => {
    const [event] = terminalEvents();
    const harness = createHarness([
      { ...event!, canvasRunId: '77777777-7777-4777-8777-777777777777' },
    ]);

    harness.pump.start({ actor, runId: context.runId });
    await harness.pump.waitForIdle(context.runId);

    expect(harness.repository.ingestRuntimeEvent).not.toHaveBeenCalled();
    expect(harness.repository.markRunReconciling).toHaveBeenCalledWith({
      actor,
      runId: context.runId,
      error: 'runtime_event_identity_mismatch',
    });
  });

  it('observes both stream and reconciliation failures without an unhandled rejection', async () => {
    const harness = createHarness([]);
    harness.repository.markRunReconciling.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      harness.pump.start({ actor, runId: context.runId });
      await harness.pump.waitForIdle(context.runId);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(harness.logger.error).toHaveBeenCalledWith(
        'run_event_pump_reconciliation_failed',
        expect.objectContaining({ runId: context.runId }),
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
```

- [ ] **Step 2: Run the focused test and observe the missing pump**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/run-event-pump.test.ts
```

Expected: FAIL because `./run-event-pump` does not exist.

- [ ] **Step 3: Implement the event pump**

Create `packages/control-plane/src/run-event-pump.ts`:

```ts
import type {
  RuntimeAdapter,
  RuntimeBindingContext,
  RuntimeEvent,
} from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type {
  ControlPlaneRepository,
  RunRuntimeContext,
} from '@ai-super-canvas/db';

import { mapRuntimeEvent } from './runtime-event-mapper';

export interface RunEventPumpPort {
  start(input: {
    actor: ActorContext;
    runId: string;
  }): 'started' | 'already-active';
}

export interface RunEventPumpLogger {
  error(event: string, context: Record<string, unknown>): void;
}

const defaultLogger: RunEventPumpLogger = {
  error(event, context) {
    console.error(event, context);
  },
};

function toRuntimeBinding(
  binding: RunRuntimeContext['binding'],
): RuntimeBindingContext {
  return {
    canvasAgentBindingId: binding.canvasAgentBindingId,
    isolationKey: binding.isolationKey,
    ...(binding.endpointRef === undefined
      ? {}
      : { endpointRef: binding.endpointRef }),
    ...(binding.secretRef === undefined
      ? {}
      : { secretRef: binding.secretRef }),
  };
}

function isTerminal(event: RuntimeEvent): boolean {
  return event.type === 'run.completed'
    || event.type === 'run.failed'
    || event.type === 'run.cancelled';
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : 'runtime_event_stream_failed';
}

export class RunEventPump implements RunEventPumpPort {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: RunEventPumpLogger = defaultLogger,
  ) {}

  start(input: {
    actor: ActorContext;
    runId: string;
  }): 'started' | 'already-active' {
    if (this.active.has(input.runId)) return 'already-active';
    const runner = this.consume(input)
      .catch(async (reason: unknown) => {
        try {
          await this.repository.markRunReconciling({
            actor: input.actor,
            runId: input.runId,
            error: errorMessage(reason),
          });
        } catch (reconciliationReason) {
          this.logger.error('run_event_pump_reconciliation_failed', {
            runId: input.runId,
            error: errorMessage(reconciliationReason),
          });
        }
      })
      .finally(() => {
        this.active.delete(input.runId);
      });
    this.active.set(input.runId, runner);
    return 'started';
  }

  async waitForIdle(runId: string): Promise<void> {
    await this.active.get(runId);
  }

  async reconcileAfterRestart(): Promise<number> {
    return this.repository.reconcileOrphanedRuns();
  }

  private async consume(input: {
    actor: ActorContext;
    runId: string;
  }): Promise<void> {
    const context = await this.repository.getRunRuntimeContext(input);
    if (!context.externalRunRef) {
      throw new Error('runtime_run_ref_missing');
    }
    const binding = toRuntimeBinding(context.binding);
    let terminalSeen = false;
    let lastExternalEventRef: string | undefined;

    for await (const event of this.runtime.streamRunEvents({
      binding,
      canvasRunId: context.runId,
      externalRunRef: context.externalRunRef,
    })) {
      if (
        event.canvasRunId !== context.runId
        || event.canvasSessionId !== context.sessionId
      ) {
        throw new Error('runtime_event_identity_mismatch');
      }

      if (isTerminal(event)) {
        const runtimeSession = await this.runtime.loadSession({
          commandId: `sync-history:${context.runId}`,
          binding,
          canvasSessionId: context.sessionId,
          externalSessionRef: context.externalSessionRef,
        });
        if (!runtimeSession.historyDigest) {
          throw new Error('runtime_terminal_history_digest_missing');
        }
        await this.repository.syncRuntimeSessionHistory({
          actor: input.actor,
          sessionId: context.sessionId,
          historyDigest: runtimeSession.historyDigest,
        });
      }

      await this.repository.ingestRuntimeEvent({
        actor: input.actor,
        runId: input.runId,
        event: mapRuntimeEvent(event),
      });
      lastExternalEventRef = event.externalEventRef ?? lastExternalEventRef;

      if (isTerminal(event)) {
        terminalSeen = true;
        break;
      }
    }

    if (!terminalSeen) {
      throw new Error(
        `runtime_event_stream_ended_without_terminal:${lastExternalEventRef ?? 'none'}`,
      );
    }
  }
}
```

- [ ] **Step 4: Export the pump, run checks and commit**

Append to `packages/control-plane/src/index.ts`:

```ts
export * from './run-event-pump';
```

Run:

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/runtime-event-mapper.test.ts \
  packages/control-plane/src/run-event-pump.test.ts
docker run --rm ai-super-canvas:control-plane-tdd \
  --filter @ai-super-canvas/control-plane typecheck
git add packages/control-plane/src/run-event-pump.ts \
  packages/control-plane/src/run-event-pump.test.ts \
  packages/control-plane/src/index.ts
git commit -m "feat(control-plane): persist runtime event streams"
```

Expected: duplicate `start` opens one stream; all internal Promise rejections are observed; non-terminal stream exit persists reconciliation.

---

### Task 4: Bootstrap local Alpha and attach root Runtime Sessions

**Files:**
- Create: `packages/control-plane/src/session-service.test.ts`
- Create: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Consumes: Task 2 DTO/error contract, `ControlPlaneRepository`, `RuntimeAdapter`, and Task 3 `RunEventPumpPort`.
- Produces: `SessionService.bootstrapLocalAlpha` and `SessionService.createRootSession`.

- [ ] **Step 1: Write failing tests for server-owned bootstrap and idempotent Session dispatch**

Create `packages/control-plane/src/session-service.test.ts` with these shared fixtures:

```ts
import {
  DeterministicFakeRuntime,
  RuntimeAdapterError,
  type RuntimeAdapter,
} from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type { ControlPlaneRepository } from '@ai-super-canvas/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneApplicationError } from './errors';
import type { RunEventPumpPort } from './run-event-pump';
import { SessionService } from './session-service';

const actor: ActorContext = {
  accountId: '11111111-1111-4111-8111-111111111111',
  authSubject: 'local:test-owner',
};

const ids = {
  commandId: '22222222-2222-4222-8222-222222222222',
  receiptId: '33333333-3333-4333-8333-333333333333',
  workflowId: '44444444-4444-4444-8444-444444444444',
  bindingId: '55555555-5555-4555-8555-555555555555',
  agentId: '66666666-6666-4666-8666-666666666666',
  sessionId: '77777777-7777-4777-8777-777777777777',
  nodeId: '88888888-8888-4888-8888-888888888888',
};

function sessionContext() {
  return {
    sessionId: ids.sessionId,
    workflowId: ids.workflowId,
    status: 'provisioning',
    binding: {
      agentBindingId: ids.bindingId,
      agentId: ids.agentId,
      runtimeKind: 'fake',
      isolationKey: 'local-alpha',
      endpointRef: null,
      secretRef: null,
    },
    externalSessionRef: null,
    expectedHistoryDigest: null,
    config: {
      id: '99999999-9999-4999-8999-999999999999',
      sessionId: ids.sessionId,
      version: 1,
      modelEntryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      model: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        runtimeKind: 'fake',
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
        displayName: 'Deterministic Fake v1',
        capabilities: {},
      },
      instructionsOverlay: null,
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: [],
        approvalRequiredToolKeys: [],
      },
      contextPolicy: {},
    },
    context: [],
  };
}

function createSessionRepository() {
  return {
    bootstrapLocalAlpha: vi.fn().mockResolvedValue({
      accountId: actor.accountId,
      authSubject: actor.authSubject,
      agentId: ids.agentId,
      agentBindingId: ids.bindingId,
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workflowId: ids.workflowId,
      trunkRevisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      defaultModelEntryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
    createRootSession: vi.fn().mockResolvedValue({
      commandReceiptId: ids.receiptId,
      phase: 'canvas_prepared',
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      status: 'provisioning',
      config: sessionContext().config,
    }),
    beginRuntimeDispatch: vi.fn().mockResolvedValue({
      phase: 'runtime_dispatched',
      dispatchAllowed: true,
    }),
    getSessionRuntimeContext: vi.fn().mockResolvedValue(sessionContext()),
    recordRuntimeResourceKnown: vi.fn().mockResolvedValue(undefined),
    attachRuntimeSession: vi.fn().mockResolvedValue(undefined),
    markRuntimeCommandFailure: vi.fn().mockResolvedValue(undefined),
    markRuntimeCommandReconciling: vi.fn().mockResolvedValue(undefined),
  };
}

const pump: RunEventPumpPort = {
  start: vi.fn().mockReturnValue('started'),
};

describe('SessionService Session creation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds only the server-owned Fake model', async () => {
    const repository = createSessionRepository();
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      new DeterministicFakeRuntime(),
      pump,
    );

    await service.bootstrapLocalAlpha({
      commandId: ids.commandId,
      authSubject: actor.authSubject,
    });

    expect(repository.bootstrapLocalAlpha).toHaveBeenCalledWith({
      commandId: ids.commandId,
      authSubject: actor.authSubject,
      displayName: 'Local Alpha',
      availableModels: [{
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
        displayName: 'Deterministic Fake v1',
        capabilities: { text: true, tools: false },
      }],
      defaultModelProviderKey: 'fake',
      defaultModelKey: 'deterministic-v1',
    });
  });

  it('records a Runtime Session ref before attach and dispatches once on replay', async () => {
    const repository = createSessionRepository();
    const runtime = new DeterministicFakeRuntime();
    const createSpy = vi.spyOn(runtime, 'createSession');
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime,
      pump,
    );
    const request = {
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    };

    const first = await service.createRootSession(request);
    repository.createRootSession.mockResolvedValueOnce({
      commandReceiptId: ids.receiptId,
      phase: 'attached',
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      status: 'active',
      config: sessionContext().config,
    });
    const replay = await service.createRootSession(request);

    expect(first).toEqual({
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      status: 'active',
    });
    expect(replay).toEqual(first);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(repository.recordRuntimeResourceKnown.mock.invocationCallOrder[0])
      .toBeLessThan(repository.attachRuntimeSession.mock.invocationCallOrder[0]!);
  });

  it('marks not-applied failures without entering reconciliation', async () => {
    const repository = createSessionRepository();
    const runtime = {
      createSession: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'runtime_unavailable',
          'offline',
          true,
          'not-applied',
        ),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    })).rejects.toMatchObject({
      code: 'runtime_operation_failed',
      retryable: true,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandFailure).toHaveBeenCalledOnce();
    expect(repository.markRuntimeCommandReconciling).not.toHaveBeenCalled();
  });

  it('persists unknown outcomes as reconciliation and returns a safe error', async () => {
    const repository = createSessionRepository();
    const runtime = {
      createSession: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'runtime_unavailable',
          'internal endpoint timed out',
          true,
          'unknown',
        ),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    })).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        commandReceiptId: ids.receiptId,
        externalResourceKind: 'session',
      }),
    );
  });
});
```

- [ ] **Step 2: Run the focused test and observe the missing service**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/session-service.test.ts
```

Expected: FAIL because `./session-service` does not exist.

- [ ] **Step 3: Implement bootstrap and root Session orchestration**

Create `packages/control-plane/src/session-service.ts` with imports, mapping helpers and the first two methods:

```ts
import {
  RuntimeAdapterError,
  type RuntimeAdapter,
  type RuntimeBindingContext,
  type RuntimeContextItem,
  type RuntimeToolPolicy,
} from '@ai-super-canvas/ai';
import type {
  ControlPlaneRepository,
  OrchestrationPhase,
  SessionRuntimeContext,
} from '@ai-super-canvas/db';

import type {
  BootstrapLocalAlphaInput,
  CreatedSessionDto,
  CreateRootSessionInput,
  LocalAlphaBootstrapDto,
} from './dto';
import {
  commandRequiresReconciliation,
  runtimeOperationFailed,
} from './errors';
import type { RunEventPumpPort } from './run-event-pump';

function runtimeFailureText(reason: unknown, fallback: string): string {
  if (reason instanceof RuntimeAdapterError) {
    return `${reason.code}:${reason.message}`;
  }
  return reason instanceof Error ? reason.message : fallback;
}

function toSessionBinding(
  binding: SessionRuntimeContext['binding'],
): RuntimeBindingContext {
  return {
    canvasAgentBindingId: binding.agentBindingId,
    isolationKey: binding.isolationKey,
    ...(binding.endpointRef === null
      ? {}
      : { endpointRef: binding.endpointRef }),
    ...(binding.secretRef === null
      ? {}
      : { secretRef: binding.secretRef }),
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`stored_runtime_policy_invalid:${field}`);
  }
  return [...value];
}

function toRuntimeToolPolicy(
  value: Record<string, unknown>,
): RuntimeToolPolicy {
  return {
    allowedToolKeys: stringArray(value.allowedToolKeys, 'allowedToolKeys'),
    deniedToolKeys: stringArray(value.deniedToolKeys, 'deniedToolKeys'),
    approvalRequiredToolKeys: stringArray(
      value.approvalRequiredToolKeys,
      'approvalRequiredToolKeys',
    ),
  };
}

function toRuntimeContext(
  rows: Array<Record<string, unknown>>,
): RuntimeContextItem[] {
  return rows.map((row) => {
    if (
      typeof row.id !== 'string'
      || !['account', 'agent', 'workflow', 'session', 'run'].includes(String(row.scope))
      || !['private', 'workspace'].includes(String(row.visibility))
    ) {
      throw new Error('stored_runtime_context_invalid');
    }
    return {
      canvasContextRefId: row.id,
      scope: row.scope as RuntimeContextItem['scope'],
      visibility: row.visibility as RuntimeContextItem['visibility'],
      content: row.snapshot,
      provenance: {
        ...((row.provenance ?? {}) as Record<string, unknown>),
        sourceKind: row.sourceKind,
        sourceRef: row.sourceRef,
      },
    };
  });
}

function attachedSession(
  sessionId: string,
  nodeId: string,
): CreatedSessionDto {
  return { sessionId, nodeId, status: 'active' };
}

function nonDispatchable(
  commandReceiptId: string,
  phase: OrchestrationPhase,
): never {
  if (phase === 'terminal_failure') {
    throw runtimeOperationFailed(commandReceiptId, false);
  }
  throw commandRequiresReconciliation(commandReceiptId);
}

export class SessionService {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly runtime: RuntimeAdapter,
    private readonly eventPump: RunEventPumpPort,
  ) {}

  async bootstrapLocalAlpha(
    input: BootstrapLocalAlphaInput,
  ): Promise<LocalAlphaBootstrapDto> {
    const stored = await this.repository.bootstrapLocalAlpha({
      commandId: input.commandId,
      authSubject: input.authSubject,
      displayName: input.displayName ?? 'Local Alpha',
      availableModels: [{
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
        displayName: 'Deterministic Fake v1',
        capabilities: { text: true, tools: false },
      }],
      defaultModelProviderKey: 'fake',
      defaultModelKey: 'deterministic-v1',
    });
    return {
      accountId: stored.accountId,
      agentId: stored.agentId,
      agentBindingId: stored.agentBindingId,
      workspaceId: stored.workspaceId,
      workflowId: stored.workflowId,
      trunkRevisionId: stored.trunkRevisionId,
    };
  }

  async createRootSession(
    input: CreateRootSessionInput,
  ): Promise<CreatedSessionDto> {
    const prepared = await this.repository.createRootSession(input);
    if (prepared.phase === 'attached') {
      return attachedSession(prepared.sessionId, prepared.nodeId);
    }
    if (prepared.phase === 'terminal_failure') {
      return nonDispatchable(prepared.commandReceiptId, prepared.phase);
    }

    const dispatch = await this.repository.beginRuntimeDispatch({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
    });
    if (!dispatch.dispatchAllowed) {
      return nonDispatchable(prepared.commandReceiptId, dispatch.phase);
    }

    const context = await this.repository.getSessionRuntimeContext({
      actor: input.actor,
      sessionId: prepared.sessionId,
    });

    let runtimeSession: Awaited<ReturnType<RuntimeAdapter['createSession']>>;
    try {
      runtimeSession = await this.runtime.createSession({
        commandId: input.commandId,
        binding: toSessionBinding(context.binding),
        canvasSessionId: prepared.sessionId,
        model: {
          providerKey: context.config.model.providerKey,
          modelKey: context.config.model.modelKey,
        },
        toolPolicy: toRuntimeToolPolicy(context.config.toolPolicy),
        context: toRuntimeContext(context.context),
      });
    } catch (reason) {
      const error = runtimeFailureText(reason, 'runtime_session_create_failed');
      if (
        reason instanceof RuntimeAdapterError
        && reason.operationEffect === 'not-applied'
      ) {
        await this.repository.markRuntimeCommandFailure({
          actor: input.actor,
          commandReceiptId: prepared.commandReceiptId,
          retryable: reason.retryable,
          error,
        });
        throw runtimeOperationFailed(
          prepared.commandReceiptId,
          reason.retryable,
          reason,
        );
      }
      await this.repository.markRuntimeCommandReconciling({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'session',
        lookupMetadata: {
          commandId: input.commandId,
          canvasSessionId: prepared.sessionId,
        },
        error,
      });
      throw commandRequiresReconciliation(prepared.commandReceiptId, reason);
    }

    const externalSessionRef = runtimeSession.externalSessionRef;
    if (!externalSessionRef?.trim() || !runtimeSession.historyDigest) {
      await this.repository.markRuntimeCommandReconciling({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'session',
        ...(externalSessionRef?.trim()
          ? { externalResourceRef: externalSessionRef }
          : {}),
        lookupMetadata: {
          commandId: input.commandId,
          canvasSessionId: prepared.sessionId,
        },
        error: 'runtime_session_ref_or_history_digest_missing',
      });
      throw commandRequiresReconciliation(prepared.commandReceiptId);
    }

    try {
      await this.repository.recordRuntimeResourceKnown({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'session',
        externalResourceRef: externalSessionRef,
      });
      await this.repository.attachRuntimeSession({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        runtimeSession,
      });
    } catch (reason) {
      await this.repository.markRuntimeCommandReconciling({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'session',
        externalResourceRef: externalSessionRef,
        lookupMetadata: {
          commandId: input.commandId,
          canvasSessionId: prepared.sessionId,
        },
        error: runtimeFailureText(reason, 'runtime_session_attach_failed'),
      });
      throw commandRequiresReconciliation(prepared.commandReceiptId, reason);
    }

    return attachedSession(prepared.sessionId, prepared.nodeId);
  }
}
```

- [ ] **Step 4: Add the attach-response-loss regression**

Append this test inside the existing `describe`:

```ts
it('records a known external ref when attach persistence loses its response', async () => {
  const repository = createSessionRepository();
  repository.attachRuntimeSession.mockRejectedValueOnce(
    new Error('database response lost'),
  );
  const service = new SessionService(
    repository as unknown as ControlPlaneRepository,
    new DeterministicFakeRuntime(),
    pump,
  );

  await expect(service.createRootSession({
    actor,
    commandId: ids.commandId,
    workflowId: ids.workflowId,
    agentBindingId: ids.bindingId,
    title: 'Main Session',
  })).rejects.toMatchObject({
    code: 'command_requires_reconciliation',
    commandReceiptId: ids.receiptId,
  } satisfies Partial<ControlPlaneApplicationError>);
  expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith(
    expect.objectContaining({
      externalResourceKind: 'session',
      externalResourceRef: expect.stringMatching(/^fake-session-/),
    }),
  );
});
```

- [ ] **Step 5: Export the service, run checks and commit**

Append to `packages/control-plane/src/index.ts`:

```ts
export * from './session-service';
```

Run:

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/session-service.test.ts
docker run --rm ai-super-canvas:control-plane-tdd \
  --filter @ai-super-canvas/control-plane typecheck
git add packages/control-plane/src/session-service.ts \
  packages/control-plane/src/session-service.test.ts \
  packages/control-plane/src/index.ts
git commit -m "feat(control-plane): attach runtime sessions"
```

Expected: root Session replay dispatches once; `recordRuntimeResourceKnown` precedes attach; unknown effect returns the stable reconciliation error.

---

### Task 5: Start Runs and hand attached Runs to the event pump

**Files:**
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`

**Interfaces:**
- Consumes: `ControlPlaneRepository.prepareRun/beginRuntimeDispatch/recordRuntimeResourceKnown/attachRuntimeRun/markRuntimeCommandFailure/markRuntimeCommandReconciling/markRuntimeSessionUnavailable`.
- Produces: `SessionService.startRun(input): Promise<StartedRunDto>`.

- [ ] **Step 1: Add failing success, replay and Runtime-error tests**

Append a new `describe('SessionService Run start', ...)` to `session-service.test.ts`:

```ts
function preparedRun() {
  return {
    commandReceiptId: ids.receiptId,
    phase: 'canvas_prepared' as const,
    workflowId: ids.workflowId,
    sessionId: ids.sessionId,
    runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    status: 'queued' as const,
    prompt: {
      canvasMessageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      role: 'user' as const,
      content: 'say fake',
    },
    runtime: {
      binding: {
        canvasAgentBindingId: ids.bindingId,
        agentId: ids.agentId,
        runtimeKind: 'fake',
        isolationKey: 'local-alpha',
      },
      externalSessionRef: 'fake-session-1',
      expectedHistoryDigest: 'sha256:before-run',
      model: {
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
      },
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: [],
        approvalRequiredToolKeys: [],
      },
      context: [],
    },
  };
}

function createRunRepository() {
  return {
    prepareRun: vi.fn().mockResolvedValue(preparedRun()),
    beginRuntimeDispatch: vi.fn().mockResolvedValue({
      phase: 'runtime_dispatched',
      dispatchAllowed: true,
    }),
    recordRuntimeResourceKnown: vi.fn().mockResolvedValue(undefined),
    attachRuntimeRun: vi.fn().mockResolvedValue(undefined),
    markRuntimeCommandFailure: vi.fn().mockResolvedValue(undefined),
    markRuntimeCommandReconciling: vi.fn().mockResolvedValue(undefined),
    markRuntimeSessionUnavailable: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SessionService Run start', () => {
  const request = {
    actor,
    commandId: ids.commandId,
    idempotencyKey: 'browser-run-1',
    sessionId: ids.sessionId,
    content: 'say fake',
  };

  it('records and attaches a Runtime Run before starting the pump', async () => {
    const repository = createRunRepository();
    const runtime = {
      startRun: vi.fn().mockResolvedValue({
        externalRunRef: 'fake-run-1',
        acceptedAt: new Date(0).toISOString(),
      }),
    };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      eventPump,
    );

    await expect(service.startRun(request)).resolves.toEqual({
      runId: preparedRun().runId,
      status: 'running',
    });
    expect(runtime.startRun).toHaveBeenCalledWith({
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      binding: {
        canvasAgentBindingId: ids.bindingId,
        isolationKey: 'local-alpha',
      },
      canvasRunId: preparedRun().runId,
      canvasSessionId: ids.sessionId,
      externalSessionRef: 'fake-session-1',
      expectedHistoryDigest: 'sha256:before-run',
      prompt: preparedRun().prompt,
      model: preparedRun().runtime.model,
      toolPolicy: preparedRun().runtime.toolPolicy,
      context: [],
    });
    expect(repository.recordRuntimeResourceKnown.mock.invocationCallOrder[0])
      .toBeLessThan(repository.attachRuntimeRun.mock.invocationCallOrder[0]!);
    expect(repository.attachRuntimeRun.mock.invocationCallOrder[0])
      .toBeLessThan(eventPump.start.mock.invocationCallOrder[0]!);
  });

  it('reuses an attached active Run without dispatching it again', async () => {
    const repository = createRunRepository();
    repository.prepareRun.mockResolvedValueOnce({
      ...preparedRun(),
      phase: 'attached',
      status: 'running',
    });
    const runtime = { startRun: vi.fn() };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      eventPump,
    );

    await expect(service.startRun(request)).resolves.toEqual({
      runId: preparedRun().runId,
      status: 'running',
    });
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(eventPump.start).toHaveBeenCalledWith({
      actor,
      runId: preparedRun().runId,
    });
  });

  it('marks a missing Fake Session unavailable on a not-applied start', async () => {
    const repository = createRunRepository();
    const runtime = {
      startRun: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'session_not_found',
          'old process-local ref',
          false,
          'not-applied',
        ),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.startRun(request)).rejects.toMatchObject({
      code: 'runtime_session_unavailable',
      retryable: false,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeSessionUnavailable).toHaveBeenCalledWith({
      actor,
      sessionId: ids.sessionId,
      error: 'session_not_found:old process-local ref',
    });
    expect(repository.markRuntimeCommandFailure).toHaveBeenCalledOnce();
  });

  it('does not attach or pump an unknown Runtime outcome', async () => {
    const repository = createRunRepository();
    const runtime = {
      startRun: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'runtime_unavailable',
          'timeout',
          true,
          'unknown',
        ),
      ),
    };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      eventPump,
    );

    await expect(service.startRun(request)).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledOnce();
    expect(repository.attachRuntimeRun).not.toHaveBeenCalled();
    expect(eventPump.start).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the focused test and observe the missing method**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/session-service.test.ts
```

Expected: FAIL because `SessionService.startRun` does not exist.

- [ ] **Step 3: Add Run imports and implement `startRun`**

Extend the DTO import in `session-service.ts` with:

```ts
import type {
  BootstrapLocalAlphaInput,
  CreatedSessionDto,
  CreateRootSessionInput,
  LocalAlphaBootstrapDto,
  StartedRunDto,
  StartSessionRunInput,
} from './dto';
```

Extend the error import with:

```ts
import {
  commandRequiresReconciliation,
  runtimeOperationFailed,
  runtimeSessionUnavailable,
} from './errors';
```

Add this method inside `SessionService`:

```ts
async startRun(input: StartSessionRunInput): Promise<StartedRunDto> {
  const prepared = await this.repository.prepareRun(input);

  if (prepared.phase === 'attached') {
    if (prepared.status === 'reconciling') {
      throw commandRequiresReconciliation(prepared.commandReceiptId);
    }
    if (
      prepared.status === 'queued'
      || prepared.status === 'running'
      || prepared.status === 'waiting_approval'
    ) {
      this.eventPump.start({
        actor: input.actor,
        runId: prepared.runId,
      });
    }
    return { runId: prepared.runId, status: prepared.status };
  }

  if (prepared.phase === 'terminal_failure') {
    return { runId: prepared.runId, status: 'failed' };
  }

  const dispatch = await this.repository.beginRuntimeDispatch({
    actor: input.actor,
    commandReceiptId: prepared.commandReceiptId,
  });
  if (!dispatch.dispatchAllowed) {
    throw commandRequiresReconciliation(prepared.commandReceiptId);
  }

  let runtimeRun: Awaited<ReturnType<RuntimeAdapter['startRun']>>;
  try {
    runtimeRun = await this.runtime.startRun({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      binding: {
        canvasAgentBindingId: prepared.runtime.binding.canvasAgentBindingId,
        isolationKey: prepared.runtime.binding.isolationKey,
        ...(prepared.runtime.binding.endpointRef === undefined
          ? {}
          : { endpointRef: prepared.runtime.binding.endpointRef }),
        ...(prepared.runtime.binding.secretRef === undefined
          ? {}
          : { secretRef: prepared.runtime.binding.secretRef }),
      },
      canvasRunId: prepared.runId,
      canvasSessionId: prepared.sessionId,
      externalSessionRef: prepared.runtime.externalSessionRef,
      expectedHistoryDigest: prepared.runtime.expectedHistoryDigest,
      prompt: prepared.prompt,
      model: prepared.runtime.model,
      toolPolicy: prepared.runtime.toolPolicy,
      context: prepared.runtime.context,
    });
  } catch (reason) {
    const error = runtimeFailureText(reason, 'runtime_run_start_failed');
    if (
      reason instanceof RuntimeAdapterError
      && reason.operationEffect === 'not-applied'
    ) {
      if (reason.code === 'session_not_found') {
        await this.repository.markRuntimeSessionUnavailable({
          actor: input.actor,
          sessionId: input.sessionId,
          error,
        });
      }
      await this.repository.markRuntimeCommandFailure({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        retryable: reason.retryable,
        error,
      });
      if (reason.code === 'session_not_found') {
        throw runtimeSessionUnavailable(prepared.commandReceiptId, reason);
      }
      throw runtimeOperationFailed(
        prepared.commandReceiptId,
        reason.retryable,
        reason,
      );
    }
    await this.repository.markRuntimeCommandReconciling({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      lookupMetadata: {
        commandId: input.commandId,
        canvasRunId: prepared.runId,
      },
      error,
    });
    throw commandRequiresReconciliation(prepared.commandReceiptId, reason);
  }

  const externalRunRef = runtimeRun.externalRunRef;
  if (!externalRunRef?.trim()) {
    await this.repository.markRuntimeCommandReconciling({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      lookupMetadata: {
        commandId: input.commandId,
        canvasRunId: prepared.runId,
      },
      error: 'runtime_run_ref_missing',
    });
    throw commandRequiresReconciliation(prepared.commandReceiptId);
  }

  try {
    await this.repository.recordRuntimeResourceKnown({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      externalResourceRef: externalRunRef,
    });
    await this.repository.attachRuntimeRun({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      runtimeRun: {
        externalRunRef,
        acceptedAt: runtimeRun.acceptedAt,
      },
    });
  } catch (reason) {
    await this.repository.markRuntimeCommandReconciling({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      externalResourceRef: externalRunRef,
      lookupMetadata: {
        commandId: input.commandId,
        canvasRunId: prepared.runId,
      },
      error: runtimeFailureText(reason, 'runtime_run_attach_failed'),
    });
    throw commandRequiresReconciliation(prepared.commandReceiptId, reason);
  }

  this.eventPump.start({ actor: input.actor, runId: prepared.runId });
  return { runId: prepared.runId, status: 'running' };
}
```

- [ ] **Step 4: Add the missing external Run ref regression**

Append this test inside the Run-start `describe`:

```ts
it('reconciles an accepted Runtime response that omits externalRunRef', async () => {
  const repository = createRunRepository();
  const runtime = {
    startRun: vi.fn().mockResolvedValue({
      acceptedAt: new Date(0).toISOString(),
    }),
  };
  const eventPump = {
    start: vi.fn().mockReturnValue('started' as const),
  };
  const service = new SessionService(
    repository as unknown as ControlPlaneRepository,
    runtime as unknown as RuntimeAdapter,
    eventPump,
  );

  await expect(service.startRun(request)).rejects.toMatchObject({
    code: 'command_requires_reconciliation',
  } satisfies Partial<ControlPlaneApplicationError>);
  expect(repository.recordRuntimeResourceKnown).not.toHaveBeenCalled();
  expect(repository.attachRuntimeRun).not.toHaveBeenCalled();
  expect(eventPump.start).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run focused checks and commit**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/session-service.test.ts
docker run --rm ai-super-canvas:control-plane-tdd \
  --filter @ai-super-canvas/control-plane typecheck
git add packages/control-plane/src/session-service.ts \
  packages/control-plane/src/session-service.test.ts
git commit -m "feat(control-plane): dispatch persisted runs"
```

Expected: Run dispatch/attach/pump ordering is proven; replay never dispatches a second Runtime Run; missing ref and unknown effect enter reconciliation.

---

### Task 6: Read persisted events and probe transcript Runtime availability

**Files:**
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`

**Interfaces:**
- Consumes: `listRunEvents`, `getRunRuntimeContext`, `loadSessionSnapshot`, `getSessionRuntimeContext`, `markRuntimeSessionUnavailable`, and `RuntimeAdapter.loadSession`.
- Produces: `SessionService.getRunEvents` and `SessionService.getSessionTranscript`.

- [ ] **Step 1: Add failing read-model and restart tests**

Append:

```ts
describe('SessionService persisted reads', () => {
  const sessionSnapshot = {
    sessionId: ids.sessionId,
    status: 'active',
    messages: [{
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      sessionId: ids.sessionId,
      runId: null,
      ordinal: 0,
      role: 'user' as const,
      content: 'say fake',
      status: 'completed',
      externalMessageRef: null,
      sourceRuntimeEventKey: null,
    }],
    activeRun: null,
    runtimeRef: {
      externalSessionRef: 'fake-session-1',
      status: 'active' as const,
    },
  };

  it('returns a sanitized persisted event page and terminal status', async () => {
    const repository = {
      listRunEvents: vi.fn().mockResolvedValue([{
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        sequence: 6,
        eventType: 'run.completed',
        payload: { type: 'run.completed' },
        externalEventRef: 'fake-run-1:event:6',
        runtimeEventKey: 'fake-run-1:event:6',
        occurredAt: new Date(0).toISOString(),
      }]),
      getRunRuntimeContext: vi.fn().mockResolvedValue({
        ...preparedRun(),
        actor,
        workflowId: ids.workflowId,
        sessionId: ids.sessionId,
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        status: 'succeeded',
        binding: preparedRun().runtime.binding,
        externalSessionRef: 'fake-session-1',
        externalRunRef: 'fake-run-1',
      }),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      {} as RuntimeAdapter,
      pump,
    );

    await expect(service.getRunEvents({
      actor,
      runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      after: 5,
    })).resolves.toEqual({
      events: [{
        sequence: 6,
        eventType: 'run.completed',
        payload: { type: 'run.completed' },
        occurredAt: new Date(0).toISOString(),
      }],
      nextAfter: 6,
      terminal: { status: 'succeeded' },
    });
  });

  it('returns an active transcript without exposing the Runtime ref', async () => {
    const repository = {
      loadSessionSnapshot: vi.fn().mockResolvedValue(sessionSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: 'fake-session-1',
        expectedHistoryDigest: 'sha256:before-run',
      }),
      markRuntimeSessionUnavailable: vi.fn(),
    };
    const runtime = {
      loadSession: vi.fn().mockResolvedValue({
        externalSessionRef: 'fake-session-1',
        runtimeVersion: '1',
        replayStatus: 'complete',
        historyDigest: 'sha256:before-run',
        metadata: {},
      }),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    const result = await service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    });

    expect(result).toEqual({
      sessionId: ids.sessionId,
      status: 'active',
      messages: [{
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        runId: null,
        ordinal: 0,
        role: 'user',
        content: 'say fake',
        status: 'completed',
      }],
      activeRun: null,
      reconciliationState: null,
      runtimeAvailability: 'available',
    });
    expect(JSON.stringify(result)).not.toContain('fake-session-1');
  });

  it('marks a process-local Fake ref unavailable after service restart', async () => {
    const unavailableSnapshot = {
      ...sessionSnapshot,
      runtimeRef: {
        externalSessionRef: 'fake-session-1',
        status: 'error' as const,
      },
    };
    const repository = {
      loadSessionSnapshot: vi.fn()
        .mockResolvedValueOnce(sessionSnapshot)
        .mockResolvedValueOnce(unavailableSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: 'fake-session-1',
      }),
      markRuntimeSessionUnavailable: vi.fn().mockResolvedValue(undefined),
    };
    const freshRuntime = new DeterministicFakeRuntime();
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      freshRuntime,
      pump,
    );

    await expect(service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    })).resolves.toMatchObject({
      runtimeAvailability: 'unavailable',
      reconciliationState: {
        kind: 'runtime-unavailable',
      },
    });
    expect(repository.markRuntimeSessionUnavailable).toHaveBeenCalledWith({
      actor,
      sessionId: ids.sessionId,
      error: 'Runtime Session was not found',
    });
  });
});
```

- [ ] **Step 2: Run the focused test and observe the missing read methods**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/session-service.test.ts
```

Expected: FAIL because `getRunEvents` and `getSessionTranscript` do not exist.

- [ ] **Step 3: Add DTO and DB type imports**

Extend the DTO import:

```ts
import type {
  BootstrapLocalAlphaInput,
  CreatedSessionDto,
  CreateRootSessionInput,
  GetRunEventsInput,
  GetSessionTranscriptInput,
  LocalAlphaBootstrapDto,
  RunEventsPageDto,
  SessionTranscriptDto,
  StartedRunDto,
  StartSessionRunInput,
} from './dto';
```

Extend the DB type import:

```ts
import type {
  ControlPlaneRepository,
  OrchestrationPhase,
  SessionRuntimeContext,
  StoredSessionSnapshot,
} from '@ai-super-canvas/db';
```

- [ ] **Step 4: Implement the persisted read mappings**

Add these helpers above `SessionService`:

```ts
function terminalStatus(
  status: string,
): RunEventsPageDto['terminal'] {
  if (
    status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
  ) {
    return { status };
  }
  return null;
}

function toTranscriptDto(
  snapshot: StoredSessionSnapshot,
  runtimeAvailability: SessionTranscriptDto['runtimeAvailability'],
): SessionTranscriptDto {
  const reconciliationState = snapshot.activeRun?.status === 'reconciling'
    ? {
        kind: 'run-reconciling' as const,
        message: 'Run requires reconciliation',
      }
    : runtimeAvailability === 'unavailable'
      ? {
          kind: 'runtime-unavailable' as const,
          message: 'Runtime Session is unavailable; create a new test Session',
        }
      : null;
  return {
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    messages: snapshot.messages.map((message) => ({
      messageId: message.id,
      runId: message.runId,
      ordinal: message.ordinal,
      role: message.role,
      content: message.content,
      status: message.status,
    })),
    activeRun: snapshot.activeRun,
    reconciliationState,
    runtimeAvailability,
  };
}
```

Add these methods inside `SessionService`:

```ts
async getRunEvents(input: GetRunEventsInput): Promise<RunEventsPageDto> {
  const events = await this.repository.listRunEvents(input);
  const context = await this.repository.getRunRuntimeContext({
    actor: input.actor,
    runId: input.runId,
  });
  return {
    events: events.map((event) => ({
      sequence: event.sequence,
      eventType: event.eventType,
      payload: event.payload,
      occurredAt: event.occurredAt,
    })),
    nextAfter: events.at(-1)?.sequence ?? input.after,
    terminal: terminalStatus(context.status),
  };
}

async getSessionTranscript(
  input: GetSessionTranscriptInput,
): Promise<SessionTranscriptDto> {
  const snapshot = await this.repository.loadSessionSnapshot(input);
  if (snapshot.runtimeRef?.status !== 'active') {
    return toTranscriptDto(snapshot, 'unavailable');
  }

  const context = await this.repository.getSessionRuntimeContext(input);
  if (!context.externalSessionRef) {
    return toTranscriptDto(snapshot, 'unavailable');
  }

  try {
    await this.runtime.loadSession({
      commandId: `probe-session:${input.sessionId}`,
      binding: toSessionBinding(context.binding),
      canvasSessionId: input.sessionId,
      externalSessionRef: context.externalSessionRef,
    });
    return toTranscriptDto(snapshot, 'available');
  } catch (reason) {
    if (
      reason instanceof RuntimeAdapterError
      && reason.code === 'session_not_found'
      && reason.operationEffect === 'not-applied'
    ) {
      await this.repository.markRuntimeSessionUnavailable({
        ...input,
        error: reason.message,
      });
      const refreshed = await this.repository.loadSessionSnapshot(input);
      return toTranscriptDto(refreshed, 'unavailable');
    }
    throw reason;
  }
}
```

- [ ] **Step 5: Add a transient Runtime failure regression**

Append:

```ts
it('does not permanently mark a transient Runtime probe failure', async () => {
  const repository = {
    loadSessionSnapshot: vi.fn().mockResolvedValue(sessionSnapshot),
    getSessionRuntimeContext: vi.fn().mockResolvedValue({
      ...sessionContext(),
      status: 'active',
      externalSessionRef: 'fake-session-1',
    }),
    markRuntimeSessionUnavailable: vi.fn(),
  };
  const reason = new RuntimeAdapterError(
    'runtime_unavailable',
    'temporary outage',
    true,
    'not-applied',
  );
  const runtime = { loadSession: vi.fn().mockRejectedValue(reason) };
  const service = new SessionService(
    repository as unknown as ControlPlaneRepository,
    runtime as unknown as RuntimeAdapter,
    pump,
  );

  await expect(service.getSessionTranscript({
    actor,
    sessionId: ids.sessionId,
  })).rejects.toBe(reason);
  expect(repository.markRuntimeSessionUnavailable).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run focused checks and commit**

```bash
docker build --target test --tag ai-super-canvas:control-plane-tdd .
docker run --rm ai-super-canvas:control-plane-tdd \
  vitest run packages/control-plane/src/session-service.test.ts
docker run --rm ai-super-canvas:control-plane-tdd \
  --filter @ai-super-canvas/control-plane typecheck
git add packages/control-plane/src/session-service.ts \
  packages/control-plane/src/session-service.test.ts
git commit -m "feat(control-plane): expose persisted session reads"
```

Expected: event DTOs omit event keys and explicit external refs; transcript survives independently of Runtime; only definitive Fake `session_not_found` marks the stored ref unavailable.

---

### Task 7: Close the package boundary and run the Application PR gate

**Files:**
- Modify only if checks require a scoped correction:
  - `packages/control-plane/src/*.ts`
  - `packages/control-plane/package.json`
  - `pnpm-lock.yaml`
  - `Dockerfile`

**Interfaces:**
- Consumes: all preceding task outputs.
- Produces: a review-ready Application PR with no API, page or database changes.

- [ ] **Step 1: Verify the public export boundary**

`packages/control-plane/src/index.ts` must contain exactly:

```ts
export * from './dto';
export * from './errors';
export * from './run-event-pump';
export * from './session-service';
```

Confirm the internal mapper is not exported:

```bash
! rg "runtime-event-mapper" packages/control-plane/src/index.ts
```

Expected: command exits 0.

- [ ] **Step 2: Scan for placeholders, forbidden dependencies and leaked ref fields**

```bash
! rg -n \
  "T[B]D|T[O]DO|FIX[M]E|implement[[:space:]]later|fill[[:space:]]in[[:space:]]details" \
  packages/control-plane
! rg -n "from ['\"](next|react|postgres|drizzle-orm)" packages/control-plane/src
! rg -n \
  "externalSessionRef|externalRunRef|externalEventRef|runtimeEventKey|secretRef" \
  packages/control-plane/src/dto.ts
git diff --check
```

Expected: all commands exit 0; Runtime refs appear only in internal service/pump code and Repository/Runtime calls.

- [ ] **Step 3: Run fresh package and repository-wide verification**

```bash
docker build --target test --tag ai-super-canvas:application-pr .
docker run --rm ai-super-canvas:application-pr \
  --filter @ai-super-canvas/control-plane lint
docker run --rm ai-super-canvas:application-pr \
  --filter @ai-super-canvas/control-plane typecheck
docker run --rm ai-super-canvas:application-pr \
  vitest run packages/control-plane/src
docker run --rm ai-super-canvas:application-pr lint
docker run --rm ai-super-canvas:application-pr typecheck
docker run --rm ai-super-canvas:application-pr test
docker run --rm ai-super-canvas:application-pr build
docker run --rm ai-super-canvas:application-pr install --frozen-lockfile
bash ./scripts/test-integration.sh
git diff --check
git status -sb
```

Expected:

- control-plane focused tests pass;
- repository unit suite remains green;
- existing PostgreSQL integration suite remains green;
- all workspace lint/typecheck/build commands pass;
- frozen install leaves `pnpm-lock.yaml` unchanged;
- status contains only Application PR files.

- [ ] **Step 4: Inspect the complete branch diff**

```bash
git fetch origin --prune
git rev-list --left-right --count HEAD...origin/main
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: branch is based on current `origin/main`; diff contains `packages/control-plane`, `Dockerfile`, and `pnpm-lock.yaml` only; commits correspond to Tasks 1–6.

- [ ] **Step 5: Push and open the Application PR**

Create `/tmp/server-persisted-session-application-pr.md` with `apply_patch`
and this exact content:

```markdown
## Summary

- add the `@ai-super-canvas/control-plane` application package
- lease and dispatch root Sessions and Runs through the existing Repository and Runtime contracts
- persist Runtime events through one process-local `RunEventPump`
- expose sanitized transcript and event DTOs with honest FakeRuntime restart availability

## Safety and boundaries

- records external refs before attach
- separates `not-applied` failures from unknown effects that require reconciliation
- keeps ActorContext, model and tool policy server-owned
- does not add Next.js routes, browser UI, Hermes, SQL or multi-replica claims

## Validation

- control-plane focused Vitest suite
- workspace lint and typecheck
- repository unit suite
- PostgreSQL integration suite
- workspace build
- frozen pnpm install
- `git diff --check`
```

Then publish:

```bash
git push -u origin agent/server-persisted-session-application
gh pr create \
  --draft \
  --base main \
  --head agent/server-persisted-session-application \
  --title "feat(control-plane): add persisted Session application layer" \
  --body-file /tmp/server-persisted-session-application-pr.md
```

- [ ] **Step 6: Wait for required checks**

```bash
gh pr checks --watch --interval 10
```

Expected: Quality, Integration and CodeQL are green before changing the PR from Draft to ready for review. Do not merge without user approval.

---

## Spec Coverage Self-Review

| Approved requirement | Implemented by |
| --- | --- |
| `packages/control-plane` only; no React/Next/SQL | Tasks 1–7 |
| server-owned Fake model and policy | Task 4 |
| root Session dispatch exactly once | Task 4 |
| external ref recorded before attach | Tasks 4–5 |
| `not-applied` versus `unknown` | Tasks 4–5 |
| one event consumer per Run | Task 3 |
| exhaustive RuntimeEvent mapping | Task 1 |
| event/message/terminal persistence | Task 3 |
| stream without terminal enters reconciliation | Task 3 |
| async pump rejection is observed | Task 3 |
| Run dispatch and pump handoff | Task 5 |
| persisted event pagination DTO | Task 6 |
| refresh reads PostgreSQL snapshot | Task 6 |
| process restart marks old Fake ref unavailable | Task 6 |
| no Runtime ref in stable DTO | Tasks 2, 6 and 7 |
| multi-process safety is not claimed | Global Constraints and Task 3 |
| API/page/Hermes/World Canvas excluded | Global Constraints and Task 7 |

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-server-persisted-session-application-layer.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task and review each task before the next one.
2. **Inline Execution** — execute this plan in the current task with `superpowers:executing-plans`, in batches with review checkpoints.

The user chooses the execution mode after approving the plan PR. Regardless of mode, the completed Application layer is delivered as one Draft PR and is not merged without explicit approval.

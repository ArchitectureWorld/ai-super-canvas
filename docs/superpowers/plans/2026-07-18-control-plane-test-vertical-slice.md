# Control Plane 真实后端测试纵切 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个不影响现有画布的 `/control-plane-test` 页面，让用户能够通过真实 Next.js API、PostgreSQL 和 `DeterministicFakeRuntime` 完成创建 Session、发送消息、接收回复和刷新恢复。

**Architecture:** PostgreSQL Repository 负责 Run、RunEvent、Message 和命令收据的一致性；新的 `@ai-super-canvas/control-plane` 负责 Runtime dispatch、attach、事件摄取和补偿；Next.js 只负责服务端身份注入与 HTTP 映射。浏览器只保存最后一个 Session 指针和待重试 commandId，transcript 与事件始终从 PostgreSQL 读取。

**Tech Stack:** TypeScript 6、Node.js 24、pnpm workspace、Next.js 16 App Router、React 19、PostgreSQL 18、postgres.js、Zod 4、Vitest 4、Playwright 1.61、Docker Compose。

---

## 实施前约束

- 工作目录：`/home/youran/Development/AI-Super-Canvas/.worktrees/risk-first-vertical-slice`。
- 当前分支：`feat/risk-first-vertical-slice`。
- 设计规格：`docs/superpowers/specs/2026-07-18-control-plane-test-vertical-slice-design.md`。
- 现有画布 `apps/web/src/components/workspace-prototype.tsx` 本次不改数据源。
- 不新增或修改主机端口；应用继续使用现有容器端口 `3000` 和现有 Compose 映射，因此不修改 `/home/youran/data/service-ports.md` 与 `/home/youran/data/service-ports.json`。
- 不接入外部 Runtime，不需要模型密钥。
- 宿主机 Node 版本低于仓库要求时，所有权威测试都通过 `compose.control-plane-test.yaml` 的 Node 24 `test` 服务运行。
- 每个任务先观察测试失败，再写最小实现；每个任务单独提交。

## 文件结构

### Repository 与持久化

- Modify: `packages/db/src/repositories/control-plane-repository.ts` — 在现有 Repository 合约中增加 Run、事件、Session snapshot 和 Runtime 可用性方法。
- Create: `packages/db/src/repositories/control-plane-run-types.ts` — 保存 Run DTO、事件摄取 DTO 和 Session snapshot DTO，避免继续膨胀主合约文件。
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts` — 实现 Run 准备、attach、事件原子投影、读取和对账状态。
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts` — PostgreSQL 事务、幂等、授权和回滚证明。
- Modify: `packages/db/src/index.ts` — 导出新增公共类型。

### Control Plane 应用服务

- Create: `packages/control-plane/package.json` — 新 workspace package。
- Create: `packages/control-plane/tsconfig.json` — Node 24 TypeScript 配置。
- Create: `packages/control-plane/src/runtime-mapping.ts` — Repository DTO 到 Runtime Adapter DTO 的唯一映射位置。
- Create: `packages/control-plane/src/session-service.ts` — bootstrap、Session 创建、Run 创建与 Session snapshot 编排。
- Create: `packages/control-plane/src/run-event-pump.ts` — Runtime→PostgreSQL 的唯一事件消费者。
- Create: `packages/control-plane/src/session-service.test.ts` — dispatch、attach、重试与 Runtime 丢失测试。
- Create: `packages/control-plane/src/run-event-pump.test.ts` — 单消费者、事件投影、终态和流失败测试。
- Create: `packages/control-plane/src/index.ts` — 包公开导出。
- Modify: `pnpm-lock.yaml` — workspace 链接。
- Modify: `Dockerfile` — dependencies 阶段复制新包 manifest。

### Next.js 服务端与 API

- Create: `apps/web/src/server/control-plane.ts` — 组合 Repository、Fake Runtime、Pump 与 Service。
- Create: `apps/web/src/app/api/control-plane/http.ts` — JSON 解析和稳定错误映射。
- Create: `apps/web/src/app/api/control-plane/bootstrap/route.ts` — local-alpha bootstrap。
- Create: `apps/web/src/app/api/control-plane/sessions/route.ts` — 创建 root Session。
- Create: `apps/web/src/app/api/control-plane/sessions/[sessionId]/runs/route.ts` — 启动 Run。
- Create: `apps/web/src/app/api/control-plane/sessions/[sessionId]/transcript/route.ts` — 授权读取 transcript 与 Runtime 可用性。
- Create: `apps/web/src/app/api/control-plane/runs/[runId]/events/route.ts` — 重放 PostgreSQL 中的 SSE 事件。
- Create: `apps/web/src/app/api/control-plane/route-contract.test.ts` — API 身份、校验、冲突、SSE 和错误映射。
- Modify: `apps/web/package.json` — 增加 control-plane 与 Zod 依赖。
- Modify: `.env.example` — 用稳定 auth subject 替换旧 owner ID。
- Modify: `compose.yaml` — 注入 `AUTH_MODE` 与 `APP_OWNER_SUBJECT`，不改端口。

### 浏览器测试入口与验收

- Create: `apps/web/src/app/control-plane-test/page.tsx` — Server Component 外壳。
- Create: `apps/web/src/app/control-plane-test/control-plane-test-client.tsx` — 浏览器状态机和 API 调用。
- Create: `apps/web/src/app/control-plane-test/control-plane-test.module.css` — 隔离样式。
- Create: `packages/control-plane/src/control-plane-test-golden-path.integration.test.ts` — 从空数据库执行真实服务 Golden Path。
- Create: `tests/e2e/control-plane-test.spec.ts` — 浏览器创建、运行和刷新恢复。
- Modify: `docs/architecture/development-roadmap.md` — 记录纵切通过证据与 Fake Runtime 限制。

### Task 1: 定义 Run、事件与 Session snapshot Repository 合约

**Files:**
- Create: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`

- [ ] **Step 1: 在集成测试中写出失败的 Run 准备合约**

在现有 `describe('PostgresControlPlaneRepository')` 中增加测试。测试先复用当前 `bootstrapFixture()`，创建并 attach 一个 root Session，然后要求 `prepareRun` 原子写入用户 Message、Run 和命令收据：

```ts
it('prepares one idempotent Run from server-owned Session policy', async () => {
  const fixture = await bootstrapFixture();
  const session = await repository.createRootSession({
    commandId: '10101010-1010-4010-8010-101010101010',
    actor: fixture.actor,
    workflowId: fixture.workflowId,
    agentBindingId: fixture.agentBindingId,
    title: '真实后端测试',
  });
  await repository.beginRuntimeDispatch({
    actor: fixture.actor,
    commandReceiptId: session.commandReceiptId,
  });
  await repository.recordRuntimeResourceKnown({
    actor: fixture.actor,
    commandReceiptId: session.commandReceiptId,
    externalResourceKind: 'session',
    externalResourceRef: 'fake-session-repository-run',
  });
  await repository.attachRuntimeSession({
    actor: fixture.actor,
    commandReceiptId: session.commandReceiptId,
    runtimeSession: {
      externalSessionRef: 'fake-session-repository-run',
      runtimeVersion: 'deterministic-v1',
      replayStatus: 'complete',
      historyDigest: 'empty-history-digest',
      metadata: {},
    },
  });

  const input = {
    actor: fixture.actor,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'browser-run-1',
    sessionId: session.sessionId,
    content: '请返回确定性测试回复',
  } as const;
  const [first, replay] = await Promise.all([
    repository.prepareRun(input),
    repository.prepareRun({ ...input }),
  ]);

  expect(replay).toEqual(first);
  expect(first.phase).toBe('canvas_prepared');
  expect(first.status).toBe('queued');
  expect(first.prompt).toMatchObject({
    role: 'user',
    content: '请返回确定性测试回复',
  });
  expect(first.runtime.externalSessionRef).toBe('fake-session-repository-run');
  expect(first.runtime.model).toMatchObject({
    providerKey: 'fake',
    modelKey: 'deterministic-v1',
  });
  expect(first.runtime.toolPolicy).toEqual({
    allowedToolKeys: [],
    deniedToolKeys: [],
    approvalRequiredToolKeys: [],
  });

  const [counts] = await sql<{
    messages: number;
    runs: number;
    receipts: number;
  }[]>`
    SELECT
      (SELECT count(*)::integer FROM messages WHERE session_id = ${session.sessionId}) AS messages,
      (SELECT count(*)::integer FROM runs WHERE session_id = ${session.sessionId}) AS runs,
      (SELECT count(*)::integer FROM command_receipts
       WHERE workflow_id = ${fixture.workflowId}
         AND command_key = ${input.commandId}) AS receipts
  `;
  expect(counts).toEqual({ messages: 1, runs: 1, receipts: 1 });
});
```

- [ ] **Step 2: 运行集成测试并确认缺少 `prepareRun`**

Run:

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml up -d postgres-test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/db db:migrate
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run --config vitest.integration.config.ts packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
```

Expected: FAIL，TypeScript 报告 `prepareRun` 不存在。

- [ ] **Step 3: 新增独立 Run 合约类型文件**

创建 `packages/db/src/repositories/control-plane-run-types.ts`：

```ts
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
    content: unknown;
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
  content: unknown;
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
  externalRunRef: string;
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
```

- [ ] **Step 4: 扩展 Repository 接口并公开导出**

在 `control-plane-repository.ts` 中先导入 Task 1 实际使用的新增类型：

```ts
import type {
  PreparedRun,
  PrepareRunInput,
} from './control-plane-run-types';
```

然后给 `ControlPlaneRepository` 增加：

```ts
prepareRun(input: PrepareRunInput): Promise<PreparedRun>;
```

其余 Run/event/snapshot 方法在 Task 2 实现时再加入接口，确保 Task 1
提交本身可以通过 `PostgresControlPlaneRepository implements
ControlPlaneRepository` 的类型检查。Task 2 需补充导入并增加：

```ts
attachRuntimeRun(input: {
  actor: ActorContext;
  commandReceiptId: string;
  runtimeRun: RuntimeRunAttachment;
}): Promise<void>;
getRunRuntimeContext(input: {
  actor: ActorContext;
  runId: string;
}): Promise<RunRuntimeContext>;
ingestRuntimeEvent(input: {
  actor: ActorContext;
  runId: string;
  event: PersistableRunEvent;
}): Promise<StoredRunEvent>;
listRunEvents(input: {
  actor: ActorContext;
  runId: string;
  after: number;
}): Promise<StoredRunEvent[]>;
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
```

在 `packages/db/src/index.ts` 增加：

```ts
export * from './repositories/control-plane-run-types';
```

- [ ] **Step 5: 为 `prepareRun` 添加最小事务实现**

在 `PostgresControlPlaneRepository` 中实现 `prepareRun`。事务必须按以下顺序执行：

1. `authorizeSession` 并锁定 Session；
2. 对 `{ sessionId, idempotencyKey, content }` 做现有 canonical payload；
3. 使用带 `ON CONFLICT DO NOTHING` 的 `INSERT` 创建 `command_type = 'start-run'` 的收据；
4. 使用带 `FOR UPDATE` 的 `SELECT` 校验 canonical bytes；
5. 若已有 `result_payload`，查询当前 Run 状态并返回当前 phase；
6. 校验 Session 为 `active`，且存在 `active` primary Runtime ref 与 `historyDigest`；
7. 读取最新 config、模型、Binding 和授权 context；
8. 锁定 Session 后计算下一个 Message ordinal；
9. 插入 completed user Message；
10. 插入 queued Run，model/tool/context snapshot 只取服务端查询结果；
11. 把 `result_type = 'run'`、`result_id` 和完整 `PreparedRun` 写回收据。

新增的映射必须生成以下形状，不能接受调用者提供的策略：

```ts
const runtime = {
  binding: {
    canvasAgentBindingId: authorization.agent_binding_id,
    agentId: authorization.agent_id,
    runtimeKind: authorization.runtime_kind,
    isolationKey: authorization.isolation_key,
    ...(authorization.endpoint_ref ? { endpointRef: authorization.endpoint_ref } : {}),
    ...(authorization.secret_ref ? { secretRef: authorization.secret_ref } : {}),
  },
  externalSessionRef: runtimeRef.external_session_ref,
  expectedHistoryDigest: historyDigest,
  model: {
    providerKey: config.model.providerKey,
    modelKey: config.model.modelKey,
  },
  toolPolicy: {
    allowedToolKeys: stringArray(config.toolPolicy.allowedToolKeys),
    deniedToolKeys: stringArray(config.toolPolicy.deniedToolKeys),
    approvalRequiredToolKeys: stringArray(
      config.toolPolicy.approvalRequiredToolKeys,
    ),
  },
  context: contextRows.map((row) => ({
    canvasContextRefId: row.id,
    scope: row.scope,
    visibility: row.visibility,
    content: row.snapshot,
    provenance: {
      ...row.provenance,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
    },
  })),
};
```

并添加一个局部严格数组读取函数：

```ts
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Stored Runtime tool policy is invalid');
  }
  return [...value];
}
```

- [ ] **Step 6: 增加冲突与并发断言并跑绿**

在同一测试中继续断言：

```ts
await expect(repository.prepareRun({
  ...input,
  content: '同一个 commandId 的不同内容',
})).rejects.toThrow(/payload conflict/i);

await expect(repository.prepareRun({
  ...input,
  commandId: '12121212-1212-4212-8212-121212121212',
  content: '同一个 idempotencyKey 的不同命令',
})).rejects.toThrow(/idempotency/i);
```

Run:

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run --config vitest.integration.config.ts packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/db typecheck
```

Expected: PASS，数据库中只有一个用户 Message、一个 Run 和一个 start-run 收据。

- [ ] **Step 7: 提交 Repository Run 准备合约**

```bash
git add packages/db/src/repositories
git commit -m "feat(db): prepare idempotent runtime runs"
```

### Task 2: 实现 Run attach、事件原子投影与持久化读取

**Files:**
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`

- [ ] **Step 1: 写失败测试证明事件与 Message 同事务提交**

在 Task 1 的 Run fixture 基础上，先 dispatch、记录外部 Run ref 并 attach：

```ts
const dispatch = await repository.beginRuntimeDispatch({
  actor: fixture.actor,
  commandReceiptId: prepared.commandReceiptId,
});
expect(dispatch).toEqual({ phase: 'runtime_dispatched', dispatchAllowed: true });
await repository.recordRuntimeResourceKnown({
  actor: fixture.actor,
  commandReceiptId: prepared.commandReceiptId,
  externalResourceKind: 'run',
  externalResourceRef: 'fake-run-repository-1',
});
await repository.attachRuntimeRun({
  actor: fixture.actor,
  commandReceiptId: prepared.commandReceiptId,
  runtimeRun: {
    externalRunRef: 'fake-run-repository-1',
    acceptedAt: new Date(0).toISOString(),
  },
});

await repository.ingestRuntimeEvent({
  actor: fixture.actor,
  runId: prepared.runId,
  event: {
    runtimeEventKey: 'fake-run-repository-1:event:5',
    externalEventRef: 'fake-run-repository-1:event:5',
    eventType: 'message.completed',
    occurredAt: new Date(0).toISOString(),
    payload: { type: 'message.completed', content: 'fake fake ' },
    message: {
      role: 'assistant',
      content: 'fake fake ',
      externalMessageRef: 'fake-run-repository-1:message:1',
    },
  },
});
const terminal = await repository.ingestRuntimeEvent({
  actor: fixture.actor,
  runId: prepared.runId,
  event: {
    runtimeEventKey: 'fake-run-repository-1:event:6',
    externalEventRef: 'fake-run-repository-1:event:6',
    eventType: 'run.completed',
    occurredAt: new Date(0).toISOString(),
    payload: { type: 'run.completed' },
    terminal: { status: 'succeeded' },
  },
});

expect(terminal.sequence).toBe(2);
expect(await repository.loadSessionTranscript({
  actor: fixture.actor,
  sessionId: prepared.sessionId,
})).toEqual([
  expect.objectContaining({ role: 'user', content: '请返回确定性测试回复' }),
  expect.objectContaining({ role: 'assistant', content: 'fake fake ' }),
]);
```

- [ ] **Step 2: 运行测试并确认 attach/ingest 方法缺失**

Run:

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run --config vitest.integration.config.ts packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
```

Expected: FAIL，报告 `attachRuntimeRun` 或 `ingestRuntimeEvent` 不存在。

- [ ] **Step 3: 实现 Runtime Run attach**

`attachRuntimeRun` 必须在一个事务内：

- `authorizeReceipt`；
- 已 attached 时直接返回；
- 只允许 `result_type = 'run'` 且 phase 为 `runtime_known` 或 `reconciling`；
- 校验记录的 external ref 与返回值一致；
- 更新 `runs.runtime_run_ref`、`status = 'running'`、`started_at`；
- 更新收据为 `attached` 并保留 result payload；
- 若 attach 的数据库响应丢失，重复调用观察 attached 后直接返回。

使用以下更新语句：

```ts
await tx`
  UPDATE runs
  SET runtime_run_ref = COALESCE(runtime_run_ref, ${input.runtimeRun.externalRunRef}),
      status = CASE WHEN status = 'queued' THEN 'running'::run_status ELSE status END,
      started_at = COALESCE(started_at, ${input.runtimeRun.acceptedAt}::timestamptz)
  WHERE id = ${receipt.run_id}
    AND (runtime_run_ref IS NULL OR runtime_run_ref = ${input.runtimeRun.externalRunRef})
`;
await tx`
  UPDATE command_receipts
  SET orchestration_phase = 'attached',
      external_resource_kind = 'run',
      external_resource_ref = ${input.runtimeRun.externalRunRef},
      completed_at = COALESCE(completed_at, now()),
      last_error = NULL
  WHERE id = ${receipt.id}
`;
```

同时让现有命令阶段机同步 Run 状态，避免失败的 queued Run 永久占用 active 唯一索引：

```ts
// beginRuntimeDispatch 获得新的 dispatch lease 时
if (receipt.run_id) {
  await tx`
    UPDATE runs
    SET status = 'queued', error_code = NULL, error_message = NULL,
        completed_at = NULL
    WHERE id = ${receipt.run_id}
      AND status IN ('queued', 'failed')
  `;
}

// markRuntimeCommandFailure 写入收据失败状态的同一事务中
if (receipt.run_id) {
  await tx`
    UPDATE runs
    SET status = 'failed', error_message = ${input.error}, completed_at = now()
    WHERE id = ${receipt.run_id}
      AND status IN ('queued', 'running', 'waiting_approval', 'reconciling')
  `;
}

// markRuntimeCommandReconciling 写入收据 reconciling 的同一事务中
if (receipt.run_id) {
  await tx`
    UPDATE runs
    SET status = 'reconciling', error_message = ${input.error}
    WHERE id = ${receipt.run_id}
      AND status IN ('queued', 'running', 'waiting_approval')
  `;
}
```

- [ ] **Step 4: 实现 `getRunRuntimeContext` 与授权读取**

查询必须通过 Run→Session→Workflow membership 与 Agent grant 进行现有授权，然后返回：

```ts
return {
  actor: input.actor,
  workflowId: row.workflow_id,
  sessionId: row.session_id,
  runId: input.runId,
  status: row.status,
  binding: {
    canvasAgentBindingId: row.agent_binding_id,
    agentId: row.agent_id,
    runtimeKind: row.runtime_kind,
    isolationKey: row.isolation_key,
    ...(row.endpoint_ref ? { endpointRef: row.endpoint_ref } : {}),
    ...(row.secret_ref ? { secretRef: row.secret_ref } : {}),
  },
  externalSessionRef: row.external_session_ref,
  externalRunRef: row.runtime_run_ref,
};
```

任何一个外部 ref 为空都抛出稳定错误，不返回部分上下文。

- [ ] **Step 5: 实现幂等事件摄取事务**

`ingestRuntimeEvent` 的单个 PostgreSQL 事务按以下顺序：

1. 授权并 `SELECT Run FOR UPDATE`；
2. 先按 `(run_id, runtime_event_key)` 查重，存在时返回原事件；
3. `sequence = COALESCE(MAX(sequence), 0) + 1`；
4. 插入 RunEvent；
5. 若 `event.message` 存在，锁定 Session，分配下一个 ordinal，并以 `(run_id, source_runtime_event_key)` 去重插入 completed Message；
6. 若 `event.terminal` 存在，按终态更新 Run 与 `completed_at`；
7. 所有步骤一同提交。

Message 插入使用绑定所属 Agent，而不是调用者传入的 Agent：

```ts
await tx`
  INSERT INTO messages (
    id, workflow_id, session_id, run_id, ordinal, role,
    actor_account_id, actor_agent_id, content, status,
    external_message_ref, source_runtime_event_key
  ) VALUES (
    ${randomUUID()}, ${run.workflow_id}, ${run.session_id}, ${input.runId},
    ${nextOrdinal}, ${event.message.role}::message_role,
    NULL, ${run.agent_id}, ${tx.json(event.message.content as postgres.JSONValue)},
    'completed', ${event.message.externalMessageRef ?? null},
    ${event.runtimeEventKey}
  )
  ON CONFLICT (run_id, source_runtime_event_key)
    WHERE source_runtime_event_key IS NOT NULL
  DO NOTHING
`;
```

终态更新使用：

```ts
if (event.terminal) {
  await tx`
    UPDATE runs
    SET status = ${event.terminal.status}::run_status,
        error_code = ${event.terminal.errorCode ?? null},
        error_message = ${event.terminal.errorMessage ?? null},
        completed_at = COALESCE(completed_at, now())
    WHERE id = ${input.runId}
      AND status IN ('queued', 'running', 'waiting_approval', 'reconciling')
  `;
}
```

- [ ] **Step 6: 实现事件、snapshot、历史 digest 和不可用状态方法**

实现这些确定性行为：

```ts
// listRunEvents
SELECT sequence, event_type, payload, external_event_ref,
       runtime_event_key, occurred_at
FROM run_events
WHERE run_id = ${input.runId} AND sequence > ${input.after}
ORDER BY sequence;

// syncRuntimeSessionHistory
UPDATE session_runtime_refs
SET metadata = jsonb_set(metadata, '{historyDigest}', to_jsonb(${input.historyDigest}::text)),
    updated_at = now()
WHERE session_id = ${input.sessionId} AND is_primary = true AND status = 'active';

// markRuntimeSessionUnavailable
UPDATE session_runtime_refs
SET status = 'error', metadata = metadata || ${tx.json({ lastError: input.error })},
    updated_at = now()
WHERE session_id = ${input.sessionId} AND is_primary = true AND status = 'active';

// markRunReconciling
UPDATE runs
SET status = 'reconciling', error_message = ${input.error}
WHERE id = ${input.runId}
  AND status IN ('queued', 'running', 'waiting_approval');

// reconcileOrphanedRuns
UPDATE runs
SET status = 'reconciling', error_message = 'event_pump_missing_after_restart'
WHERE status IN ('queued', 'running', 'waiting_approval');
```

`loadSessionSnapshot` 必须在 repeatable-read 事务中组合 `loadSessionTranscript` 等价查询、最新活动 Run 与 primary Runtime ref，且先执行 Session 授权。

- [ ] **Step 7: 证明事件幂等、内容相同但 key 不同、以及回滚**

增加以下断言：

在 ingest terminal 之前，先重放第一个事件，再写入两个内容相同但 key 不同的 delta：

```ts
const duplicate = await repository.ingestRuntimeEvent({
  actor: fixture.actor,
  runId: prepared.runId,
  event: completedMessageEvent,
});
expect(duplicate.sequence).toBe(1);

for (const suffix of ['3', '4']) {
  await repository.ingestRuntimeEvent({
    actor: fixture.actor,
    runId: prepared.runId,
    event: {
      runtimeEventKey: `fake-run-repository-1:event:${suffix}`,
      externalEventRef: `fake-run-repository-1:event:${suffix}`,
      eventType: 'model.output.delta',
      occurredAt: new Date(0).toISOString(),
      payload: { type: 'model.output.delta', text: 'fake ' },
    },
  });
}
await repository.ingestRuntimeEvent({
  actor: fixture.actor,
  runId: prepared.runId,
  event: terminalEvent,
});
const events = await repository.listRunEvents({
  actor: fixture.actor,
  runId: prepared.runId,
  after: 0,
});
expect(events.map((event) => event.runtimeEventKey)).toEqual([
  'fake-run-repository-1:event:5',
  'fake-run-repository-1:event:3',
  'fake-run-repository-1:event:4',
  'fake-run-repository-1:event:6',
]);
```

摄取实现必须拒绝终态后的新 event，但允许终态前已经提交的 eventId 幂等重放。

再创建并 attach 一个尚未终态的 `rollbackPrepared` Run，让 Message JSON 序列化在 RunEvent 插入后失败，证明整个摄取事务回滚；随后用相同 eventId 的合法内容重放。下面代码中的 `prepared` 指向该新 Run：

```ts
await expect(repository.ingestRuntimeEvent({
  actor: fixture.actor,
  runId: prepared.runId,
  event: {
    runtimeEventKey: 'fake-run-repository-1:event:rollback',
    eventType: 'message.completed',
    occurredAt: new Date(0).toISOString(),
    payload: { type: 'message.completed' },
    message: {
      role: 'assistant',
      content: 1n as never,
    },
  },
})).rejects.toThrow();
const [rolledBack] = await sql<{ events: number; messages: number }[]>`
  SELECT
    (SELECT count(*)::integer FROM run_events
     WHERE runtime_event_key = 'fake-run-repository-1:event:rollback') AS events,
    (SELECT count(*)::integer FROM messages
     WHERE source_runtime_event_key = 'fake-run-repository-1:event:rollback') AS messages
`;
expect(rolledBack).toEqual({ events: 0, messages: 0 });

await repository.ingestRuntimeEvent({
  actor: fixture.actor,
  runId: prepared.runId,
  event: {
    runtimeEventKey: 'fake-run-repository-1:event:rollback',
    eventType: 'message.completed',
    occurredAt: new Date(0).toISOString(),
    payload: { type: 'message.completed' },
    message: { role: 'assistant', content: 'replayed safely' },
  },
});
```

- [ ] **Step 8: 运行 PostgreSQL 集成测试并提交**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run --config vitest.integration.config.ts packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/db typecheck
git add packages/db/src/repositories
git commit -m "feat(db): persist runtime run events atomically"
```

Expected: Repository 集成测试全部通过；重复 event key 不新增行；终态与 completed Message 同事务提交。

### Task 3: 创建 Control Plane package 并编排 Runtime Session

**Files:**
- Create: `packages/control-plane/package.json`
- Create: `packages/control-plane/tsconfig.json`
- Create: `packages/control-plane/src/runtime-mapping.ts`
- Create: `packages/control-plane/src/session-service.ts`
- Create: `packages/control-plane/src/session-service.test.ts`
- Create: `packages/control-plane/src/index.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `Dockerfile`

- [ ] **Step 1: 创建 package manifest 和 TypeScript 配置**

`packages/control-plane/package.json`：

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

`packages/control-plane/tsconfig.json`：

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

同时在 Dockerfile dependencies 阶段增加新 workspace manifest，确保后续测试镜像能建立 workspace links：

```dockerfile
COPY packages/control-plane/package.json packages/control-plane/package.json
```

- [ ] **Step 2: 写失败测试证明 root Session 只 dispatch 一次**

创建 `session-service.test.ts`，使用结构化 Repository mock 与真实 Fake Runtime：

```ts
import { DeterministicFakeRuntime } from '@ai-super-canvas/ai';
import { describe, expect, it, vi } from 'vitest';
import { SessionService } from './session-service';

const actor = {
  accountId: '18181818-1818-4818-8818-181818181818',
  authSubject: 'local:test-owner',
};

describe('SessionService', () => {
  it('creates and attaches one Runtime Session across an idempotent retry', async () => {
    const repository = {
      createRootSession: vi.fn().mockResolvedValue({
        commandReceiptId: '20202020-2020-4020-8020-202020202020',
        phase: 'canvas_prepared',
        sessionId: '14141414-1414-4414-8414-141414141414',
        nodeId: '15151515-1515-4515-8515-151515151515',
        status: 'provisioning',
        config: {},
      }),
      beginRuntimeDispatch: vi.fn().mockResolvedValue({
        phase: 'runtime_dispatched',
        dispatchAllowed: true,
      }),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        sessionId: '14141414-1414-4414-8414-141414141414',
        workflowId: '19191919-1919-4919-8919-191919191919',
        status: 'provisioning',
        binding: {
          agentBindingId: '16161616-1616-4616-8616-161616161616',
          agentId: '21212121-2121-4121-8121-212121212121',
          runtimeKind: 'fake',
          isolationKey: 'test-agent-workspace',
          endpointRef: null,
          secretRef: null,
        },
        externalSessionRef: null,
        expectedHistoryDigest: null,
        config: {
          model: { providerKey: 'fake', modelKey: 'deterministic-v1' },
          toolPolicy: {
            allowedToolKeys: [],
            deniedToolKeys: [],
            approvalRequiredToolKeys: [],
          },
        },
        context: [],
      }),
      recordRuntimeResourceKnown: vi.fn().mockResolvedValue(undefined),
      attachRuntimeSession: vi.fn().mockResolvedValue(undefined),
      markRuntimeCommandFailure: vi.fn().mockResolvedValue(undefined),
      markRuntimeCommandReconciling: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new DeterministicFakeRuntime();
    const createSpy = vi.spyOn(runtime, 'createSession');
    const service = new SessionService(repository as never, runtime, null);
    const request = {
      commandId: '17171717-1717-4717-8717-171717171717',
      actor,
      workflowId: '19191919-1919-4919-8919-191919191919',
      agentBindingId: '16161616-1616-4616-8616-161616161616',
      title: '主会话',
    };

    const first = await service.createRootSession(request);
    repository.createRootSession.mockResolvedValueOnce({
      commandReceiptId: '20202020-2020-4020-8020-202020202020',
      phase: 'attached',
      sessionId: first.sessionId,
      nodeId: first.nodeId,
      status: 'active',
      config: {},
    });
    const replay = await service.createRootSession(request);

    expect(replay).toEqual(first);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(repository.attachRuntimeSession).toHaveBeenCalledWith({
      actor,
      commandReceiptId: '20202020-2020-4020-8020-202020202020',
      runtimeSession: expect.objectContaining({
        externalSessionRef: expect.stringMatching(/^fake-session-/),
        historyDigest: expect.any(String),
      }),
    });
  });
});
```

- [ ] **Step 3: 生成 workspace lockfile 并确认测试失败**

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$PWD:/workspace" -w /workspace node:24.18.0-bookworm-slim \
  npx --yes pnpm@11.12.0 install --lockfile-only
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml build test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run packages/control-plane/src/session-service.test.ts
```

Expected: FAIL，因为 `session-service.ts` 不存在。

- [ ] **Step 4: 实现唯一 Runtime DTO 映射文件**

创建 `runtime-mapping.ts`：

```ts
import type {
  RuntimeBindingContext,
  RuntimeContextItem,
  RuntimeToolPolicy,
} from '@ai-super-canvas/ai';
import type { SessionRuntimeContext } from '@ai-super-canvas/db';

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Stored Runtime policy field is invalid: ${field}`);
  }
  return [...value];
}

export function toRuntimeBinding(
  binding: SessionRuntimeContext['binding'],
): RuntimeBindingContext {
  return {
    canvasAgentBindingId: binding.agentBindingId,
    isolationKey: binding.isolationKey,
    ...(binding.endpointRef ? { endpointRef: binding.endpointRef } : {}),
    ...(binding.secretRef ? { secretRef: binding.secretRef } : {}),
  };
}

export function toRuntimeToolPolicy(
  policy: Record<string, unknown>,
): RuntimeToolPolicy {
  return {
    allowedToolKeys: stringArray(policy.allowedToolKeys, 'allowedToolKeys'),
    deniedToolKeys: stringArray(policy.deniedToolKeys, 'deniedToolKeys'),
    approvalRequiredToolKeys: stringArray(
      policy.approvalRequiredToolKeys,
      'approvalRequiredToolKeys',
    ),
  };
}

export function toRuntimeContext(
  rows: Array<Record<string, unknown>>,
): RuntimeContextItem[] {
  return rows.map((row) => {
    if (
      typeof row.id !== 'string'
      || !['account', 'agent', 'workflow', 'session', 'run'].includes(String(row.scope))
      || !['private', 'workspace'].includes(String(row.visibility))
    ) {
      throw new Error('Stored Runtime context item is invalid');
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
```

- [ ] **Step 5: 实现 Session Service 的 Session 创建阶段机**

创建 `session-service.ts`。先定义公开请求、错误和最小 pump 端口：

```ts
import {
  RuntimeAdapterError,
  type RuntimeAdapter,
} from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type {
  ControlPlaneRepository,
} from '@ai-super-canvas/db';
import {
  toRuntimeBinding,
  toRuntimeContext,
  toRuntimeToolPolicy,
} from './runtime-mapping';

export interface EventPumpPort {
  start(input: { actor: ActorContext; runId: string }): void;
}

export class CommandRequiresReconciliationError extends Error {
  constructor(
    readonly commandReceiptId: string,
    readonly phase: string,
  ) {
    super(`Runtime command requires reconciliation: ${phase}`);
    this.name = 'CommandRequiresReconciliationError';
  }
}

export class RuntimeSessionUnavailableError extends Error {
  constructor(readonly sessionId: string) {
    super('Runtime Session is unavailable; create a new test Session');
    this.name = 'RuntimeSessionUnavailableError';
  }
}
```

然后声明公开 bootstrap 视图并打开 `SessionService` 类；Task 4 的新方法继续放在同一个类中：

```ts
export interface LocalAlphaBootstrapView {
  accountId: string;
  agentId: string;
  agentBindingId: string;
  workspaceId: string;
  workflowId: string;
  trunkRevisionId: string;
}

export class SessionService {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly runtime: RuntimeAdapter,
    private readonly eventPump: EventPumpPort | null,
  ) {}

  async bootstrapLocalAlpha(input: {
    commandId: string;
    authSubject: string;
    displayName: string;
  }): Promise<LocalAlphaBootstrapView> {
    const stored = await this.repository.bootstrapLocalAlpha({
      ...input,
      availableModels: [{
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
        displayName: 'Deterministic v1',
        capabilities: { streaming: true },
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
```

`createRootSession` 使用完整补偿逻辑：

```ts
  async createRootSession(input: {
  commandId: string;
  actor: ActorContext;
  workflowId: string;
  agentBindingId: string;
  title: string;
}): Promise<{ sessionId: string; nodeId: string; status: 'active' }> {
  const prepared = await this.repository.createRootSession(input);
  if (prepared.phase === 'attached') {
    return {
      sessionId: prepared.sessionId,
      nodeId: prepared.nodeId,
      status: 'active',
    };
  }
  const dispatch = await this.repository.beginRuntimeDispatch({
    actor: input.actor,
    commandReceiptId: prepared.commandReceiptId,
  });
  if (!dispatch.dispatchAllowed) {
    throw new CommandRequiresReconciliationError(
      prepared.commandReceiptId,
      dispatch.phase,
    );
  }
  const context = await this.repository.getSessionRuntimeContext({
    actor: input.actor,
    sessionId: prepared.sessionId,
  });
  let runtimeSession: Awaited<ReturnType<RuntimeAdapter['createSession']>>;
  try {
    runtimeSession = await this.runtime.createSession({
      commandId: input.commandId,
      binding: toRuntimeBinding(context.binding),
      canvasSessionId: prepared.sessionId,
      model: {
        providerKey: context.config.model.providerKey,
        modelKey: context.config.model.modelKey,
      },
      toolPolicy: toRuntimeToolPolicy(context.config.toolPolicy),
      context: toRuntimeContext(context.context),
    });
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : 'runtime_session_create_failed';
    if (reason instanceof RuntimeAdapterError && reason.operationEffect === 'not-applied') {
      await this.repository.markRuntimeCommandFailure({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        retryable: reason.retryable,
        error,
      });
    } else {
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
      runtimeSession,
    });
  } catch (reason) {
    await this.repository.markRuntimeCommandReconciling({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: runtimeSession.externalSessionRef,
      lookupMetadata: {
        commandId: input.commandId,
        canvasSessionId: prepared.sessionId,
      },
      error: reason instanceof Error ? reason.message : 'runtime_session_attach_failed',
    });
    throw reason;
  }
  return {
    sessionId: prepared.sessionId,
    nodeId: prepared.nodeId,
    status: 'active',
  };
  }
}
```

增加一个单元断言，证明环境中的 `AI_DEFAULT_MODEL` 不会覆盖本测试纵切的 Fake 模型选择。

- [ ] **Step 6: 增加 attach 失败和 unknown outcome 测试**

测试必须证明：

```ts
repository.attachRuntimeSession.mockRejectedValueOnce(new Error('database response lost'));
await expect(service.createRootSession(request)).rejects.toThrow('database response lost');
expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith(
  expect.objectContaining({
    externalResourceKind: 'session',
    externalResourceRef: expect.stringMatching(/^fake-session-/),
  }),
);
```

另用一个抛出 `new RuntimeAdapterError('runtime_unavailable', 'timeout', true, 'unknown')` 的 Runtime mock，断言调用 `markRuntimeCommandReconciling` 而不是 `markRuntimeCommandFailure`。

- [ ] **Step 7: 导出包并跑绿**

`packages/control-plane/src/index.ts` 在本任务只导出已经存在的文件：

```ts
export * from './session-service';
```

Run:

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml build test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run packages/control-plane/src/session-service.test.ts
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/control-plane typecheck
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test install --frozen-lockfile
```

Expected: Session Service 测试通过，lockfile 不再变化。

- [ ] **Step 8: 提交 Control Plane Session 编排**

```bash
git add packages/control-plane Dockerfile pnpm-lock.yaml
git commit -m "feat(control-plane): attach runtime sessions"
```

### Task 4: 实现 RunEventPump、Run 启动与 Runtime 可用性探测

**Files:**
- Create: `packages/control-plane/src/run-event-pump.ts`
- Create: `packages/control-plane/src/run-event-pump.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/index.ts`

- [ ] **Step 1: 写失败测试证明一个 Run 只有一个事件消费者**

创建一个 deferred Runtime stream，并同时调用两次 `start`：

```ts
it('uses one Runtime stream and persists one terminal sequence', async () => {
  const events = [
    {
      eventId: 'fake-run-1:event:5',
      externalEventRef: 'fake-run-1:event:5',
      canvasSessionId: 'session-1',
      canvasRunId: 'run-1',
      occurredAt: new Date(0).toISOString(),
      type: 'message.completed' as const,
      role: 'assistant' as const,
      content: 'fake fake ',
      externalMessageRef: 'fake-run-1:message:1',
    },
    {
      eventId: 'fake-run-1:event:6',
      externalEventRef: 'fake-run-1:event:6',
      canvasSessionId: 'session-1',
      canvasRunId: 'run-1',
      occurredAt: new Date(0).toISOString(),
      type: 'run.completed' as const,
    },
  ];
  const runtime = {
    streamRunEvents: vi.fn().mockReturnValue((async function* () {
      for (const event of events) yield event;
    })()),
    loadSession: vi.fn().mockResolvedValue({ historyDigest: 'after-run-digest' }),
  };
  const repository = {
    getRunRuntimeContext: vi.fn().mockResolvedValue({
      actor,
      workflowId: 'workflow-1',
      sessionId: 'session-1',
      runId: 'run-1',
      status: 'running',
      binding: {
        canvasAgentBindingId: 'binding-1',
        agentId: 'agent-1',
        runtimeKind: 'fake',
        isolationKey: 'local-alpha',
      },
      externalSessionRef: 'fake-session-1',
      externalRunRef: 'fake-run-1',
    }),
    ingestRuntimeEvent: vi.fn().mockImplementation(async ({ event }) => ({
      runId: 'run-1',
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
  const pump = new RunEventPump(repository as never, runtime as never);

  pump.start({ actor, runId: 'run-1' });
  pump.start({ actor, runId: 'run-1' });
  await pump.waitForIdle('run-1');

  expect(runtime.streamRunEvents).toHaveBeenCalledTimes(1);
  expect(repository.ingestRuntimeEvent).toHaveBeenCalledTimes(2);
  expect(repository.syncRuntimeSessionHistory).toHaveBeenCalledWith({
    actor,
    sessionId: 'session-1',
    historyDigest: 'after-run-digest',
  });
});
```

- [ ] **Step 2: 运行测试并确认 Pump 不存在**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run packages/control-plane/src/run-event-pump.test.ts
```

Expected: FAIL，`run-event-pump.ts` 不存在。

- [ ] **Step 3: 实现 Runtime 事件到持久化 DTO 的穷尽映射**

在 `run-event-pump.ts` 中定义：

```ts
import type { RuntimeAdapter, RuntimeEvent } from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type {
  ControlPlaneRepository,
  PersistableRunEvent,
} from '@ai-super-canvas/db';

function toPersistableEvent(event: RuntimeEvent): PersistableRunEvent {
  const base: PersistableRunEvent = {
    runtimeEventKey: event.eventId,
    eventType: event.type,
    payload: event,
    ...(event.externalEventRef ? { externalEventRef: event.externalEventRef } : {}),
    occurredAt: event.occurredAt,
  };
  if (event.type === 'message.completed') {
    return {
      ...base,
      message: {
        role: event.role,
        content: event.content,
        ...(event.externalMessageRef
          ? { externalMessageRef: event.externalMessageRef }
          : {}),
      },
    };
  }
  if (event.type === 'run.completed') {
    return { ...base, terminal: { status: 'succeeded' } };
  }
  if (event.type === 'run.failed') {
    return {
      ...base,
      terminal: {
        status: 'failed',
        errorCode: event.code,
        errorMessage: event.message,
      },
    };
  }
  if (event.type === 'run.cancelled') {
    return { ...base, terminal: { status: 'cancelled' } };
  }
  return base;
}
```

- [ ] **Step 4: 实现单消费者事件泵**

```ts
export class RunEventPump {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly runtime: RuntimeAdapter,
  ) {}

  start(input: { actor: ActorContext; runId: string }): void {
    if (this.active.has(input.runId)) return;
    const runner = this.consume(input)
      .catch(async (reason) => {
        try {
          await this.repository.markRunReconciling({
            actor: input.actor,
            runId: input.runId,
            error: reason instanceof Error ? reason.message : 'runtime_event_stream_failed',
          });
        } catch (persistReason) {
          console.error('run_event_pump_reconciliation_failed', persistReason);
        }
      })
      .finally(() => {
        this.active.delete(input.runId);
      });
    this.active.set(input.runId, runner);
  }

  async waitForIdle(runId: string): Promise<void> {
    await this.active.get(runId);
  }

  async reconcileAfterRestart(): Promise<number> {
    return this.repository.reconcileOrphanedRuns();
  }

  private async consume(input: { actor: ActorContext; runId: string }): Promise<void> {
    const context = await this.repository.getRunRuntimeContext(input);
    let terminalSeen = false;
    let lastExternalEventRef: string | undefined;
    for await (const event of this.runtime.streamRunEvents({
      binding: {
        canvasAgentBindingId: context.binding.canvasAgentBindingId,
        isolationKey: context.binding.isolationKey,
        ...(context.binding.endpointRef
          ? { endpointRef: context.binding.endpointRef }
          : {}),
        ...(context.binding.secretRef
          ? { secretRef: context.binding.secretRef }
          : {}),
      },
      canvasRunId: context.runId,
      externalRunRef: context.externalRunRef,
    })) {
      const terminal = [
        'run.completed',
        'run.failed',
        'run.cancelled',
      ].includes(event.type);
      if (terminal) {
        const runtimeSession = await this.runtime.loadSession({
          commandId: `sync-history:${context.runId}`,
          binding: {
            canvasAgentBindingId: context.binding.canvasAgentBindingId,
            isolationKey: context.binding.isolationKey,
            ...(context.binding.endpointRef
              ? { endpointRef: context.binding.endpointRef }
              : {}),
            ...(context.binding.secretRef
              ? { secretRef: context.binding.secretRef }
              : {}),
          },
          canvasSessionId: context.sessionId,
          externalSessionRef: context.externalSessionRef,
        });
        if (!runtimeSession.historyDigest) {
          throw new Error('Runtime Session omitted the terminal history digest');
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
        event: toPersistableEvent(event),
      });
      lastExternalEventRef = event.externalEventRef ?? lastExternalEventRef;
      terminalSeen = terminalSeen || terminal;
    }
    if (!terminalSeen) {
      throw new Error(`Runtime event stream ended before terminal: ${lastExternalEventRef ?? 'none'}`);
    }
  }
}
```

- [ ] **Step 5: 增加流提前结束和内部拒绝测试**

使用空 async iterable，断言 `markRunReconciling` 被调用且没有 `unhandledRejection`。再让 `ingestRuntimeEvent` 抛错，断言同一个 Run 从 `active` Map 移除后可以被显式重新启动，但不会在同一时刻创建第二个消费者。

- [ ] **Step 6: 在 SessionService 中实现 `startRun`**

同时把 `StoredRunStatus` 和 `StoredSessionSnapshot` 加入 `@ai-super-canvas/db` 的 type import。

```ts
async startRun(input: {
  commandId: string;
  idempotencyKey: string;
  actor: ActorContext;
  sessionId: string;
  content: unknown;
}): Promise<{ runId: string; status: StoredRunStatus }> {
  if (!this.eventPump) throw new Error('RunEventPump is required to start Runs');
  const prepared = await this.repository.prepareRun(input);
  if (prepared.phase === 'attached') {
    if (prepared.status === 'reconciling') {
      throw new CommandRequiresReconciliationError(
        prepared.commandReceiptId,
        prepared.status,
      );
    }
    if (['queued', 'running', 'waiting_approval'].includes(prepared.status)) {
      this.eventPump.start({ actor: input.actor, runId: prepared.runId });
    }
    return { runId: prepared.runId, status: prepared.status };
  }
  const dispatch = await this.repository.beginRuntimeDispatch({
    actor: input.actor,
    commandReceiptId: prepared.commandReceiptId,
  });
  if (!dispatch.dispatchAllowed) {
    throw new CommandRequiresReconciliationError(
      prepared.commandReceiptId,
      dispatch.phase,
    );
  }
  let runtimeRun: Awaited<ReturnType<RuntimeAdapter['startRun']>>;
  try {
    runtimeRun = await this.runtime.startRun({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      binding: {
        canvasAgentBindingId: prepared.runtime.binding.canvasAgentBindingId,
        isolationKey: prepared.runtime.binding.isolationKey,
        ...(prepared.runtime.binding.endpointRef
          ? { endpointRef: prepared.runtime.binding.endpointRef }
          : {}),
        ...(prepared.runtime.binding.secretRef
          ? { secretRef: prepared.runtime.binding.secretRef }
          : {}),
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
    const error = reason instanceof Error ? reason.message : 'runtime_run_start_failed';
    if (reason instanceof RuntimeAdapterError && reason.operationEffect === 'not-applied') {
      const sessionUnavailable = reason.code === 'session_not_found';
      if (sessionUnavailable) {
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
      if (sessionUnavailable) {
        throw new RuntimeSessionUnavailableError(input.sessionId);
      }
    } else {
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
    }
    throw reason;
  }
  try {
    await this.repository.recordRuntimeResourceKnown({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      externalResourceRef: runtimeRun.externalRunRef,
    });
    await this.repository.attachRuntimeRun({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      runtimeRun,
    });
  } catch (reason) {
    await this.repository.markRuntimeCommandReconciling({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      externalResourceRef: runtimeRun.externalRunRef,
      lookupMetadata: {
        commandId: input.commandId,
        canvasRunId: prepared.runId,
      },
      error: reason instanceof Error ? reason.message : 'runtime_run_attach_failed',
    });
    throw reason;
  }
  this.eventPump.start({ actor: input.actor, runId: prepared.runId });
  return { runId: prepared.runId, status: 'running' };
}
```

- [ ] **Step 7: 实现 Session snapshot 与 Runtime 丢失探测**

先定义不会泄露 external ref 的公开视图和映射：

```ts
export interface SessionView {
  sessionId: string;
  status: string;
  messages: StoredSessionSnapshot['messages'];
  activeRun: StoredSessionSnapshot['activeRun'];
  runtimeRef: null | { status: 'active' | 'historical' | 'error' };
  runtimeAvailable: boolean;
}

function toSessionView(
  snapshot: StoredSessionSnapshot,
  runtimeAvailable: boolean,
): SessionView {
  return {
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    messages: snapshot.messages,
    activeRun: snapshot.activeRun,
    runtimeRef: snapshot.runtimeRef
      ? { status: snapshot.runtimeRef.status }
      : null,
    runtimeAvailable,
  };
}
```

`SessionService.getSessionSnapshot` 先读 PostgreSQL，再尝试 `runtime.loadSession`。仅当 Adapter 明确返回 `session_not_found` 且 `operationEffect = 'not-applied'` 时，把 ref 标为 error：

```ts
async getSessionSnapshot(input: {
  actor: ActorContext;
  sessionId: string;
}): Promise<SessionView> {
  const snapshot = await this.repository.loadSessionSnapshot(input);
  const context = await this.repository.getSessionRuntimeContext(input);
  if (!context.externalSessionRef || snapshot.runtimeRef?.status !== 'active') {
    return toSessionView(snapshot, false);
  }
  try {
    await this.runtime.loadSession({
      commandId: `probe-session:${input.sessionId}`,
      binding: toRuntimeBinding(context.binding),
      canvasSessionId: input.sessionId,
      externalSessionRef: context.externalSessionRef,
    });
    return toSessionView(snapshot, true);
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
      return toSessionView(refreshed, false);
    }
    throw reason;
  }
}
```

- [ ] **Step 8: 运行 Control Plane 测试并提交**

先在 `packages/control-plane/src/index.ts` 增加：

```ts
export * from './run-event-pump';
```

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run packages/control-plane/src/session-service.test.ts packages/control-plane/src/run-event-pump.test.ts
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/control-plane typecheck
git add packages/control-plane/src
git commit -m "feat(control-plane): run fake sessions through persisted events"
```

Expected: Pump 单消费者、Run attach、终态摄取、history digest 同步和 Runtime 丢失测试全部通过。

### Task 5: 组合服务端依赖并暴露 bootstrap、Session API

**Files:**
- Create: `apps/web/src/server/control-plane.ts`
- Create: `apps/web/src/app/api/control-plane/http.ts`
- Create: `apps/web/src/app/api/control-plane/bootstrap/route.ts`
- Create: `apps/web/src/app/api/control-plane/sessions/route.ts`
- Create: `apps/web/src/app/api/control-plane/route-contract.test.ts`
- Modify: `apps/web/package.json`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 给 web package 增加显式依赖并更新环境契约**

在 `apps/web/package.json` dependencies 中加入：

```json
"@ai-super-canvas/control-plane": "workspace:*",
"zod": "4.4.3"
```

在 `.env.example` 中把 `APP_OWNER_ID=local-owner` 替换为：

```dotenv
AUTH_MODE=local
APP_OWNER_SUBJECT=local:owner
```

在 `compose.yaml` 的 app environment 中只替换 owner 配置，保留原 ports 段不变：

```yaml
AUTH_MODE: ${AUTH_MODE:-local}
APP_OWNER_SUBJECT: ${APP_OWNER_SUBJECT:-local:owner}
```

更新 lockfile：

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$PWD:/workspace" -w /workspace node:24.18.0-bookworm-slim \
  npx --yes pnpm@11.12.0 install --lockfile-only
```

- [ ] **Step 2: 写失败的 bootstrap 与 Session Route 合约测试**

`route-contract.test.ts` 先覆盖服务端身份不能被 JSON 覆盖：

```ts
import { describe, expect, it, vi } from 'vitest';
import { makeBootstrapHandler } from './bootstrap/route';
import { makeCreateSessionHandler } from './sessions/route';

const actor = {
  accountId: '22222222-2222-4222-8222-222222222222',
  authSubject: 'local:test-owner',
};

describe('control-plane route contracts', () => {
  it('bootstraps with the server auth subject', async () => {
    const service = {
      bootstrapLocalAlpha: vi.fn().mockResolvedValue({ accountId: actor.accountId }),
    };
    const response = await makeBootstrapHandler({
      service: service as never,
      authSubject: actor.authSubject,
    })(new Request('http://localhost/api/control-plane/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: '23232323-2323-4323-8323-232323232323',
        displayName: '本地测试用户',
        authSubject: 'attacker',
      }),
    }));
    expect(response.status).toBe(200);
    expect(service.bootstrapLocalAlpha).toHaveBeenCalledWith({
      commandId: '23232323-2323-4323-8323-232323232323',
      authSubject: actor.authSubject,
      displayName: '本地测试用户',
    });
  });

  it('creates a Session using the injected ActorContext', async () => {
    const service = {
      createRootSession: vi.fn().mockResolvedValue({
        sessionId: '20202020-2020-4020-8020-202020202020',
        nodeId: '21212121-2121-4121-8121-212121212121',
        status: 'active',
      }),
    };
    const response = await makeCreateSessionHandler({
      service: service as never,
      actor,
    })(new Request('http://localhost/api/control-plane/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: '24242424-2424-4424-8424-242424242424',
        workflowId: '25252525-2525-4525-8525-252525252525',
        agentBindingId: '26262626-2626-4626-8626-262626262626',
        title: '真实后端测试',
        accountId: 'attacker-controlled-value',
      }),
    }));
    expect(response.status).toBe(201);
    expect(service.createRootSession).toHaveBeenCalledWith(
      expect.objectContaining({ actor }),
    );
  });
});
```

- [ ] **Step 3: 运行测试并确认 Route factories 不存在**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml build test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
```

Expected: FAIL，bootstrap/session route module 不存在。

- [ ] **Step 4: 创建稳定 HTTP helper**

`apps/web/src/app/api/control-plane/http.ts`：

```ts
import {
  CommandRequiresReconciliationError,
  RuntimeSessionUnavailableError,
} from '@ai-super-canvas/control-plane';
import {
  AuthorizationError,
  CommandPayloadConflictError,
} from '@ai-super-canvas/db';
import { ZodError, type ZodType } from 'zod';

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, 'malformed_json');
  }
  try {
    return schema.parse(value);
  } catch (reason) {
    if (reason instanceof ZodError) {
      throw new HttpError(400, 'invalid_request', { issues: reason.issues });
    }
    throw reason;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

export function errorResponse(reason: unknown): Response {
  if (reason instanceof ZodError) {
    return Response.json(
      { error: { code: 'invalid_request', issues: reason.issues } },
      { status: 400 },
    );
  }
  if (reason instanceof HttpError) {
    return Response.json(
      { error: { code: reason.code, ...reason.details } },
      { status: reason.status },
    );
  }
  if (reason instanceof CommandRequiresReconciliationError) {
    return Response.json({
      commandReceiptId: reason.commandReceiptId,
      state: 'reconciling',
    }, {
      status: 202,
      headers: { 'retry-after': '2' },
    });
  }
  if (reason instanceof RuntimeSessionUnavailableError) {
    return Response.json(
      { error: { code: 'runtime_session_unavailable' } },
      { status: 409 },
    );
  }
  if (reason instanceof CommandPayloadConflictError) {
    return Response.json(
      { error: { code: 'command_payload_conflict' } },
      { status: 409 },
    );
  }
  if (reason instanceof AuthorizationError) {
    return Response.json(
      { error: { code: 'not_found' } },
      { status: 404 },
    );
  }
  console.error('control_plane_request_failed', reason);
  return Response.json(
    { error: { code: 'internal_error' } },
    { status: 500 },
  );
}
```

- [ ] **Step 5: 组合只存在于服务端的 Control Plane singleton**

`apps/web/src/server/control-plane.ts`：

```ts
import { DeterministicFakeRuntime } from '@ai-super-canvas/ai';
import {
  RunEventPump,
  SessionService,
} from '@ai-super-canvas/control-plane';
import {
  createPostgresControlPlaneRepository,
} from '@ai-super-canvas/db';
import type { ActorContext } from '@ai-super-canvas/core';

export interface ControlPlaneContext {
  repository: ReturnType<typeof createPostgresControlPlaneRepository>;
  runtime: DeterministicFakeRuntime;
  eventPump: RunEventPump;
  service: SessionService;
}

let singleton: Promise<ControlPlaneContext> | undefined;

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required for Control Plane routes');
  return value;
}

export function localAuthSubject(): string {
  if ((process.env.AUTH_MODE ?? 'local') !== 'local') {
    throw new Error('Control Plane local-alpha routes require AUTH_MODE=local');
  }
  return process.env.APP_OWNER_SUBJECT?.trim() || 'local:owner';
}

export async function getControlPlane(): Promise<ControlPlaneContext> {
  singleton ??= (async () => {
    const repository = createPostgresControlPlaneRepository(requiredDatabaseUrl());
    const runtime = new DeterministicFakeRuntime();
    const eventPump = new RunEventPump(repository, runtime);
    const service = new SessionService(repository, runtime, eventPump);
    await eventPump.reconcileAfterRestart();
    return { repository, runtime, eventPump, service };
  })();
  return singleton;
}

export async function getLocalActorContext(): Promise<ActorContext> {
  const { repository } = await getControlPlane();
  const actor = await repository.resolveActorContext({
    authSubject: localAuthSubject(),
  });
  if (!actor) throw new Error('Local actor is not bootstrapped');
  return actor;
}
```

- [ ] **Step 6: 实现 bootstrap Route**

```ts
import type { SessionService } from '@ai-super-canvas/control-plane';
import { z } from 'zod';
import {
  getControlPlane,
  localAuthSubject,
} from '@/server/control-plane';
import { errorResponse, parseJson } from '../http';

const BootstrapSchema = z.object({
  commandId: z.uuid(),
  displayName: z.string().trim().min(1).max(120).default('本地测试用户'),
});

export function makeBootstrapHandler(input: {
  service: SessionService;
  authSubject: string;
}) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await parseJson(request, BootstrapSchema);
      return Response.json(await input.service.bootstrapLocalAlpha({
        commandId: body.commandId,
        authSubject: input.authSubject,
        displayName: body.displayName,
      }));
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const { service } = await getControlPlane();
  return makeBootstrapHandler({
    service,
    authSubject: localAuthSubject(),
  })(request);
}
```

- [ ] **Step 7: 实现 root Session Route**

```ts
import type { SessionService } from '@ai-super-canvas/control-plane';
import type { ActorContext } from '@ai-super-canvas/core';
import { z } from 'zod';
import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';
import { errorResponse, parseJson } from '../http';

const CreateSessionSchema = z.object({
  commandId: z.uuid(),
  workflowId: z.uuid(),
  agentBindingId: z.uuid(),
  title: z.string().trim().min(1).max(160),
});

export function makeCreateSessionHandler(input: {
  service: SessionService;
  actor: ActorContext;
}) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await parseJson(request, CreateSessionSchema);
      const result = await input.service.createRootSession({
        ...body,
        actor: input.actor,
      });
      return Response.json(result, { status: 201 });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const [{ service }, actor] = await Promise.all([
    getControlPlane(),
    getLocalActorContext(),
  ]);
  return makeCreateSessionHandler({ service, actor })(request);
}
```

- [ ] **Step 8: 补齐 malformed JSON、非法 UUID、payload conflict 和 local actor 缺失测试**

每个场景使用独立 Request，精确断言：

```ts
expect(response.status).toBe(400);
expect(await response.json()).toMatchObject({ error: { code: 'malformed_json' } });
```

对于 `CommandRequiresReconciliationError`，断言 `202`、`Retry-After: 2` 和 `commandReceiptId`；对于 `AuthorizationError`，断言 `404` 且响应不包含数据库 ID。

- [ ] **Step 9: 运行 Route 合约、typecheck 并提交**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml build test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/web typecheck
git diff -- compose.yaml .env.example
git add apps/web/src/server apps/web/src/app/api/control-plane apps/web/package.json .env.example compose.yaml pnpm-lock.yaml
git commit -m "feat(web): expose local control-plane sessions"
```

Expected: Route 合约通过；Compose 的 `ports` 段没有变化。

### Task 6: 暴露 Run、SSE 事件与 transcript API

**Files:**
- Create: `apps/web/src/app/api/control-plane/sessions/[sessionId]/runs/route.ts`
- Create: `apps/web/src/app/api/control-plane/sessions/[sessionId]/transcript/route.ts`
- Create: `apps/web/src/app/api/control-plane/runs/[runId]/events/route.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`

- [ ] **Step 1: 写失败的 Run path/body、transcript 和 SSE 测试**

增加三个 Route factory 测试：

```ts
it('starts a Run for the path Session and ignores forged identity', async () => {
  const service = {
    startRun: vi.fn().mockResolvedValue({
      runId: '30303030-3030-4030-8030-303030303030',
      status: 'running',
    }),
  };
  const handler = makeStartRunHandler({ service: service as never, actor });
  const response = await handler(
    new Request('http://localhost/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: '27272727-2727-4727-8727-272727272727',
        idempotencyKey: 'browser-run-1',
        content: '真实消息',
        accountId: 'attacker',
      }),
    }),
    { sessionId: '28282828-2828-4828-8828-282828282828' },
  );
  expect(response.status).toBe(202);
  expect(service.startRun).toHaveBeenCalledWith(expect.objectContaining({
    actor,
    sessionId: '28282828-2828-4828-8828-282828282828',
    content: '真实消息',
  }));
});

it('reads the authorized PostgreSQL transcript snapshot', async () => {
  const service = {
    getSessionSnapshot: vi.fn().mockResolvedValue({
      sessionId: '29292929-2929-4929-8929-292929292929',
      status: 'active',
      messages: [],
      activeRun: null,
      runtimeRef: null,
      runtimeAvailable: false,
    }),
  };
  const response = await makeTranscriptHandler({ service: service as never, actor })(
    { sessionId: '29292929-2929-4929-8929-292929292929' },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ runtimeAvailable: false });
});

it('replays persisted events as exact SSE frames', async () => {
  const repository = {
    listRunEvents: vi.fn().mockResolvedValue([{
      runId: '30303030-3030-4030-8030-303030303030',
      sequence: 2,
      eventType: 'run.completed',
      payload: { type: 'run.completed' },
      externalEventRef: 'fake-run:event:6',
      runtimeEventKey: 'fake-run:event:6',
      occurredAt: new Date(0).toISOString(),
    }]),
  };
  const response = await makeEventsHandler({ repository: repository as never, actor })(
    new Request('http://localhost/events?after=1'),
    { runId: '30303030-3030-4030-8030-303030303030' },
  );
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(await response.text()).toBe(
    'id: 2\nevent: run.completed\ndata: {"type":"run.completed"}\n\n',
  );
});
```

- [ ] **Step 2: 运行测试并确认三个 Route 不存在**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
```

Expected: FAIL，Route factory imports 无法解析。

- [ ] **Step 3: 实现 Run Route**

`runs/route.ts` 使用 `z.object` 只接受：

```ts
const StartRunSchema = z.object({
  commandId: z.uuid(),
  idempotencyKey: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(20_000),
});
```

factory 签名固定为：

```ts
export function makeStartRunHandler(input: {
  service: SessionService;
  actor: ActorContext;
}) {
  return async function POST(
    request: Request,
    params: { sessionId: string },
  ): Promise<Response> {
    try {
      const sessionId = z.uuid().parse(params.sessionId);
      const body = await parseJson(request, StartRunSchema);
      const result = await input.service.startRun({
        ...body,
        sessionId,
        actor: input.actor,
      });
      return Response.json(result, { status: 202 });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}
```

Next.js 导出处理器从 `context.params` Promise 取得 sessionId，再调用 factory。

- [ ] **Step 4: 实现 transcript Route**

factory 只接收 path 参数，不读取请求 body：

```ts
export function makeTranscriptHandler(input: {
  service: SessionService;
  actor: ActorContext;
}) {
  return async function GET(params: { sessionId: string }): Promise<Response> {
    try {
      const sessionId = z.uuid().parse(params.sessionId);
      return Response.json(await input.service.getSessionSnapshot({
        actor: input.actor,
        sessionId,
      }));
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}
```

- [ ] **Step 5: 实现只读 PostgreSQL 的 SSE replay Route**

```ts
export function makeEventsHandler(input: {
  repository: ControlPlaneRepository;
  actor: ActorContext;
}) {
  return async function GET(
    request: Request,
    params: { runId: string },
  ): Promise<Response> {
    try {
      const runId = z.uuid().parse(params.runId);
      const afterValue = new URL(request.url).searchParams.get('after') ?? '0';
      const after = z.coerce.number().int().min(0).parse(afterValue);
      const events = await input.repository.listRunEvents({
        actor: input.actor,
        runId,
        after,
      });
      const body = events.map((event) => (
        `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`
      )).join('');
      return new Response(body, {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/event-stream; charset=utf-8',
        },
      });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}
```

该 Route 不调用 `RuntimeAdapter.streamRunEvents`。

- [ ] **Step 6: 补齐 path UUID、after 参数、404 与 reconciliation 测试**

增加测试断言：非法 path/after 返回 `400`；未授权 Run 返回 `404`；Service 抛 reconciliation 错误时 Run Route 返回 `202` 与 `Retry-After`；响应不包含 `externalSessionRef`、`externalRunRef` 或 actor 身份。

- [ ] **Step 7: 运行 Route 合约与生产 typecheck 并提交**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/web typecheck
git add apps/web/src/app/api/control-plane
git commit -m "feat(web): expose persisted runtime runs"
```

Expected: Run、transcript、SSE API 合约全部通过。

### Task 7: 新增隔离的 `/control-plane-test` 浏览器入口

**Files:**
- Create: `apps/web/src/app/control-plane-test/page.tsx`
- Create: `apps/web/src/app/control-plane-test/control-plane-test-client.tsx`
- Create: `apps/web/src/app/control-plane-test/control-plane-test.module.css`
- Create: `tests/e2e/control-plane-test.spec.ts`

- [ ] **Step 1: 先写 Playwright 页面骨架失败测试**

创建 `tests/e2e/control-plane-test.spec.ts` 的第一个断言：

```ts
import { expect, test } from '@playwright/test';

test('shows the isolated PostgreSQL and Fake Runtime test surface', async ({ page }) => {
  await page.goto('/control-plane-test');
  await expect(page.getByRole('heading', { name: '真实后端闭环测试' })).toBeVisible();
  await expect(page.getByText('PostgreSQL')).toBeVisible();
  await expect(page.getByText('DeterministicFakeRuntime')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建测试 Session' })).toBeVisible();
});
```

- [ ] **Step 2: 运行测试并确认页面 404**

在当前应用服务可用时运行：

```bash
pnpm exec playwright test tests/e2e/control-plane-test.spec.ts --project=chromium
```

若宿主 Node 不满足仓库 engines，则在最终 Docker 应用启动后执行同一 Playwright 命令；本步骤的预期证据是 `/control-plane-test` 尚未渲染目标 heading。

- [ ] **Step 3: 创建 Server Component 外壳**

`page.tsx`：

```tsx
import { ControlPlaneTestClient } from './control-plane-test-client';

export default function ControlPlaneTestPage() {
  return <ControlPlaneTestClient />;
}
```

- [ ] **Step 4: 创建浏览器 DTO、持久指针与请求 helper**

`control-plane-test-client.tsx` 顶部：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './control-plane-test.module.css';

const bootstrapCommandKey = 'ai-super-canvas.control-plane-test.bootstrap-command';
const lastSessionKey = 'ai-super-canvas.control-plane-test.last-session';
const pendingSessionCommandKey = 'ai-super-canvas.control-plane-test.pending-session-command';
const pendingRunCommandKey = 'ai-super-canvas.control-plane-test.pending-run-command';

interface BootstrapResult {
  accountId: string;
  agentId: string;
  agentBindingId: string;
  workspaceId: string;
  workflowId: string;
  trunkRevisionId: string;
}

interface MessageDto {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  status: string;
  ordinal: number;
}

interface SessionSnapshot {
  sessionId: string;
  status: string;
  messages: MessageDto[];
  activeRun: null | { runId: string; status: string };
  runtimeRef: null | { status: string };
  runtimeAvailable: boolean;
}

interface PendingRun {
  commandId: string;
  idempotencyKey: string;
  sessionId: string;
  content: string;
}

function commandId(key: string): string {
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    cache: 'no-store',
  });
  const payload = await response.json() as T & {
    error?: { code?: string };
    state?: string;
  };
  if (payload.state === 'reconciling') {
    throw new Error('reconciling');
  }
  if (!response.ok) {
    throw new Error(payload.error?.code ?? payload.state ?? `http_${response.status}`);
  }
  return payload;
}

function displayContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
```

- [ ] **Step 5: 实现初始化、创建 Session、发送与轮询状态机**

组件使用以下核心逻辑；所有 transcript 都来自 `loadSnapshot`：

```tsx
export function ControlPlaneTestClient() {
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [content, setContent] = useState('请返回确定性测试回复');
  const [events, setEvents] = useState<string[]>([]);
  const [status, setStatus] = useState('正在连接真实后端');
  const [error, setError] = useState('');

  const loadSnapshot = useCallback(async (sessionId: string) => {
    const next = await jsonRequest<SessionSnapshot>(
      `/api/control-plane/sessions/${sessionId}/transcript`,
    );
    setSnapshot(next);
    return next;
  }, []);

  const initialize = useCallback(async () => {
    setError('');
    setStatus('正在初始化本地账号和工作区');
    const result = await jsonRequest<BootstrapResult>('/api/control-plane/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        commandId: commandId(bootstrapCommandKey),
        displayName: '本地测试用户',
      }),
    });
    setBootstrap(result);
    const lastSessionId = localStorage.getItem(lastSessionKey);
    if (lastSessionId) await loadSnapshot(lastSessionId);
    setStatus('后端已就绪');
  }, [loadSnapshot]);

  useEffect(() => {
    initialize().catch((reason) => {
      setError(reason instanceof Error ? reason.message : 'bootstrap_failed');
      setStatus('初始化失败');
    });
  }, [initialize]);

  async function createSession(): Promise<void> {
    if (!bootstrap) return;
    setError('');
    setStatus('正在创建 Canvas Session 和 Runtime Session');
    const command = commandId(pendingSessionCommandKey);
    const result = await jsonRequest<{ sessionId: string }>(
      '/api/control-plane/sessions',
      {
        method: 'POST',
        body: JSON.stringify({
          commandId: command,
          workflowId: bootstrap.workflowId,
          agentBindingId: bootstrap.agentBindingId,
          title: '真实后端测试 Session',
        }),
      },
    );
    localStorage.removeItem(pendingSessionCommandKey);
    localStorage.setItem(lastSessionKey, result.sessionId);
    setEvents([]);
    await loadSnapshot(result.sessionId);
    setStatus('Session 已连接 Fake Runtime');
  }

  async function pollRun(sessionId: string, runId: string): Promise<void> {
    let after = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await fetch(
        `/api/control-plane/runs/${runId}/events?after=${after}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error(`events_http_${response.status}`);
      const text = await response.text();
      const frames = text.split('\n\n').filter(Boolean);
      for (const frame of frames) {
        const id = Number(frame.match(/^id: (\d+)$/m)?.[1] ?? '0');
        const eventType = frame.match(/^event: (.+)$/m)?.[1];
        if (id > after) after = id;
        if (eventType) setEvents((current) => [...current, eventType]);
      }
      const next = await loadSnapshot(sessionId);
      if (next.activeRun?.status === 'reconciling') {
        throw new Error('reconciling');
      }
      if (!next.activeRun) return;
      await sleep(100);
    }
    throw new Error('run_poll_timeout');
  }

  async function sendMessage(): Promise<void> {
    if (!snapshot || !content.trim() || !snapshot.runtimeAvailable) return;
    setError('');
    setStatus('Runtime 正在生成回复');
    const stored = localStorage.getItem(pendingRunCommandKey);
    const parsed = stored ? JSON.parse(stored) as PendingRun : null;
    const pending: PendingRun = parsed?.sessionId === snapshot.sessionId
      ? parsed
      : {
          commandId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          sessionId: snapshot.sessionId,
          content: content.trim(),
        };
    localStorage.setItem(pendingRunCommandKey, JSON.stringify(pending));
    const result = await jsonRequest<{ runId: string }>(
      `/api/control-plane/sessions/${snapshot.sessionId}/runs`,
      {
        method: 'POST',
        body: JSON.stringify({
          commandId: pending.commandId,
          idempotencyKey: pending.idempotencyKey,
          content: pending.content,
        }),
      },
    );
    localStorage.removeItem(pendingRunCommandKey);
    await pollRun(snapshot.sessionId, result.runId);
    setContent('');
    setStatus('回复已写入 PostgreSQL');
  }
```

- [ ] **Step 6: 实现可直接人工测试的 JSX**

在组件末尾捕获按钮/表单错误并渲染：

```tsx
  const runAction = (action: () => Promise<void>) => {
    action().catch((reason) => {
      setError(reason instanceof Error ? reason.message : 'request_failed');
      setStatus('操作失败');
    });
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p>CONTROL PLANE · LOCAL ALPHA</p>
          <h1>真实后端闭环测试</h1>
          <span>Next.js API → PostgreSQL → DeterministicFakeRuntime</span>
        </div>
        <a href="/">返回现有画布</a>
      </header>

      <section className={styles.statusPanel} aria-label="后端状态">
        <strong>{status}</strong>
        <span>PostgreSQL</span>
        <span>DeterministicFakeRuntime</span>
        <button type="button" onClick={() => runAction(initialize)}>重新初始化</button>
      </section>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <section className={styles.actions}>
        <button
          type="button"
          disabled={!bootstrap}
          onClick={() => runAction(createSession)}
        >
          新建测试 Session
        </button>
        {snapshot && !snapshot.runtimeAvailable ? (
          <p role="status">历史已恢复，但旧 Fake Runtime Session 已不可用，请新建测试 Session。</p>
        ) : null}
      </section>

      <section className={styles.transcript} aria-label="PostgreSQL 会话记录">
        <h2>PostgreSQL transcript</h2>
        {snapshot?.messages.length ? snapshot.messages.map((message) => (
          <article key={message.id} data-role={message.role}>
            <strong>{message.role === 'user' ? '你' : 'Fake Runtime'}</strong>
            <p>{displayContent(message.content)}</p>
          </article>
        )) : <p>创建 Session 后发送第一条真实消息。</p>}
      </section>

      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          runAction(sendMessage);
        }}
      >
        <label htmlFor="control-plane-message">测试消息</label>
        <textarea
          id="control-plane-message"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          disabled={!snapshot?.runtimeAvailable}
        />
        <button
          type="submit"
          disabled={!snapshot?.runtimeAvailable || !content.trim()}
        >
          发送到真实后端
        </button>
      </form>

      <section className={styles.events} aria-label="Run 事件">
        <h2>已持久化 Run 事件</h2>
        {events.map((eventType, index) => (
          <span key={`${eventType}-${index}`}>{eventType}</span>
        ))}
      </section>
    </main>
  );
}
```

- [ ] **Step 7: 添加隔离 CSS，不改现有画布选择器**

`control-plane-test.module.css` 使用以下完整基础样式：

```css
.page { min-height: 100dvh; padding: 32px; color: #edf6f1; background: #07100c; }
.header { display: flex; justify-content: space-between; gap: 24px; max-width: 1100px; margin: 0 auto 24px; }
.header p { margin: 0; color: #76d99a; font-size: 12px; letter-spacing: .14em; }
.header h1 { margin: 8px 0; font-size: clamp(28px, 5vw, 48px); }
.header span, .header a { color: #98aaa1; }
.statusPanel, .actions, .transcript, .composer, .events { max-width: 1100px; margin: 0 auto 16px; padding: 18px; border: 1px solid #294438; border-radius: 14px; background: #101a15; }
.statusPanel { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.statusPanel strong { margin-right: auto; }
.statusPanel span, .events span { padding: 6px 9px; border-radius: 999px; color: #b8e9c9; background: #173424; font-size: 12px; }
.page button { padding: 10px 14px; border: 1px solid #62c987; border-radius: 9px; color: #07140c; background: #86e6a4; font-weight: 700; }
.page button:disabled { opacity: .45; }
.error { max-width: 1100px; margin: 0 auto 16px; padding: 12px; border: 1px solid #a65351; color: #ffd2d0; background: #3a1e22; }
.transcript { display: grid; gap: 10px; }
.transcript h2, .events h2 { margin: 0; font-size: 15px; }
.transcript article { padding: 12px; border-radius: 10px; background: #0a120e; }
.transcript article[data-role="assistant"] { border-left: 3px solid #86e6a4; }
.transcript article p { margin: 6px 0 0; white-space: pre-wrap; }
.composer { display: grid; gap: 10px; }
.composer textarea { min-height: 100px; padding: 12px; border: 1px solid #365447; border-radius: 9px; color: inherit; background: #08110d; }
.events { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
@media (max-width: 700px) { .page { padding: 16px; } .header { display: grid; } }
```

- [ ] **Step 8: 运行 lint、typecheck 和页面骨架测试并提交**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/web lint
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/web typecheck
git add apps/web/src/app/control-plane-test tests/e2e/control-plane-test.spec.ts
git commit -m "feat(web): add real backend test surface"
```

Expected: 新页面不改现有首页与画布 CSS，且能够在 API 可用后自动 bootstrap。

### Task 8: 证明数据库 Golden Path 与浏览器刷新恢复

**Files:**
- Create: `packages/control-plane/src/control-plane-test-golden-path.integration.test.ts`
- Modify: `tests/e2e/control-plane-test.spec.ts`

- [ ] **Step 1: 写数据库支持的完整服务 Golden Path**

创建 `packages/control-plane/src/control-plane-test-golden-path.integration.test.ts`：

```ts
import { DeterministicFakeRuntime } from '@ai-super-canvas/ai';
import { RunEventPump, SessionService } from '@ai-super-canvas/control-plane';
import { createPostgresControlPlaneRepository } from '@ai-super-canvas/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

describe('control-plane test Golden Path', () => {
  let repository = createPostgresControlPlaneRepository(databaseUrl);

  beforeEach(async () => repository.resetTestData());
  afterAll(async () => repository.close());

  it('persists Fake Runtime output and recovers it after fresh process objects', async () => {
    const runtime = new DeterministicFakeRuntime();
    const pump = new RunEventPump(repository, runtime);
    const service = new SessionService(repository, runtime, pump);
    const bootstrap = await service.bootstrapLocalAlpha({
      commandId: '30303030-3030-4030-8030-303030303030',
      authSubject: 'local:golden-path',
      displayName: 'Golden Path Owner',
    });
    const actor = await repository.resolveActorContext({
      authSubject: 'local:golden-path',
    });
    if (!actor) throw new Error('Bootstrap did not create ActorContext');

    const session = await service.createRootSession({
      commandId: '31313131-3131-4131-8131-313131313131',
      actor,
      workflowId: bootstrap.workflowId,
      agentBindingId: bootstrap.agentBindingId,
      title: 'Golden Path Session',
    });
    const run = await service.startRun({
      commandId: '32323232-3232-4232-8232-323232323232',
      idempotencyKey: 'golden-path-run-1',
      actor,
      sessionId: session.sessionId,
      content: '请返回确定性测试回复',
    });
    await pump.waitForIdle(run.runId);

    const events = await repository.listRunEvents({
      actor,
      runId: run.runId,
      after: 0,
    });
    const snapshot = await service.getSessionSnapshot({
      actor,
      sessionId: session.sessionId,
    });
    expect(events).toHaveLength(6);
    expect(events.filter((event) => event.eventType === 'model.output.delta'))
      .toHaveLength(2);
    expect(events.at(-1)?.eventType).toBe('run.completed');
    expect(snapshot.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', '请返回确定性测试回复'],
      ['assistant', 'fake fake '],
    ]);
    expect(snapshot.runtimeAvailable).toBe(true);

    await repository.close();
    repository = createPostgresControlPlaneRepository(databaseUrl);
    const freshRuntime = new DeterministicFakeRuntime();
    const freshPump = new RunEventPump(repository, freshRuntime);
    const freshService = new SessionService(repository, freshRuntime, freshPump);
    const freshActor = await repository.resolveActorContext({
      authSubject: 'local:golden-path',
    });
    if (!freshActor) throw new Error('Persisted ActorContext was not recovered');
    const recovered = await freshService.getSessionSnapshot({
      actor: freshActor,
      sessionId: session.sessionId,
    });
    expect(recovered.messages).toEqual(snapshot.messages);
    expect(recovered.runtimeAvailable).toBe(false);
    expect(recovered.runtimeRef?.status).toBe('error');
    const persistedAfterProbe = await repository.loadSessionSnapshot({
      actor: freshActor,
      sessionId: session.sessionId,
    });
    expect(persistedAfterProbe.runtimeRef?.status).toBe('error');
  });
});
```

- [ ] **Step 2: 运行 Golden Path 并修复所有真实契约差异**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml down -v --remove-orphans
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml up -d postgres-test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm --build test --filter @ai-super-canvas/db db:migrate
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test vitest run --config vitest.integration.config.ts packages/control-plane/src/control-plane-test-golden-path.integration.test.ts
```

Expected: PASS，六个 Runtime 事件、两个 Message、一个 succeeded Run 均来自 PostgreSQL。

- [ ] **Step 3: 扩展 Playwright 为真实浏览器 Golden Path**

把 `tests/e2e/control-plane-test.spec.ts` 扩展为：

```ts
test('creates, runs, and restores a PostgreSQL-backed Session', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto('/control-plane-test');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('ai-super-canvas.control-plane-test.')) {
        localStorage.removeItem(key);
      }
    }
  });
  await page.reload();

  await expect(page.getByText('后端已就绪')).toBeVisible();
  await page.getByRole('button', { name: '新建测试 Session' }).click();
  await expect(page.getByText('Session 已连接 Fake Runtime')).toBeVisible();
  await page.getByLabel('测试消息').fill('浏览器真实闭环');
  await page.getByRole('button', { name: '发送到真实后端' }).click();
  await expect(page.getByText('回复已写入 PostgreSQL')).toBeVisible();
  await expect(page.getByText('浏览器真实闭环', { exact: true })).toBeVisible();
  await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Run 事件')).toContainText('run.completed');

  const storedSessionId = await page.evaluate(() => (
    localStorage.getItem('ai-super-canvas.control-plane-test.last-session')
  ));
  expect(storedSessionId).toMatch(/^[0-9a-f-]{36}$/i);
  await page.reload();
  await expect(page.getByText('浏览器真实闭环', { exact: true })).toBeVisible();
  await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
```

- [ ] **Step 4: 构建并启动真实 Docker 应用**

本纵切复用已经存在的 `messages`、`runs` 与 `run_events` 表，不生成新迁移。重建应用并重启服务：

```bash
docker compose build app
systemctl --user restart ai-super-canvas.service
systemctl --user is-active ai-super-canvas.service
curl --fail --silent http://127.0.0.1:3000/api/health
```

Expected: systemd user service 为 `active`，health 返回成功；端口仍为现有 `3000`。

- [ ] **Step 5: 在真实浏览器中运行新旧两个 Golden Path**

```bash
pnpm exec playwright test tests/e2e/control-plane-test.spec.ts tests/e2e/golden-path.spec.ts --project=chromium
```

若宿主 Node engines 阻止 pnpm，则使用已具备 Playwright 浏览器的仓库验证环境执行相同两个 spec，并继续以 `http://127.0.0.1:3000` 为 baseURL。

Expected: 新真实后端闭环与原有画布闭环都 PASS。

- [ ] **Step 6: 手工执行一次刷新与应用重启语义检查**

1. 打开 `http://127.0.0.1:3000/control-plane-test`；
2. 新建 Session，发送消息，确认收到 `fake fake `；
3. 浏览器刷新，确认两条消息仍在；
4. `systemctl --user restart ai-super-canvas.service`；
5. 再刷新，确认历史仍在且页面提示旧 Fake Runtime Session 不可用；
6. 点击“新建测试 Session”，确认可以重新开始测试。

- [ ] **Step 7: 提交 Golden Path 证据测试**

```bash
git add packages/control-plane/src/control-plane-test-golden-path.integration.test.ts tests/e2e/control-plane-test.spec.ts
git commit -m "test: prove real control-plane browser loop"
```

### Task 9: 全量验证并更新执行证据

**Files:**
- Modify: `docs/architecture/development-roadmap.md`

- [ ] **Step 1: 从空测试数据库连续运行迁移两次**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml down -v --remove-orphans
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml up -d postgres-test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm --build test --filter @ai-super-canvas/db db:migrate
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test --filter @ai-super-canvas/db db:migrate
```

Expected: 第一次从空库应用迁移，第二次无 pending migration 且退出 0；测试项目不引用 `ai-super-canvas-postgres` volume。

- [ ] **Step 2: 运行 lint、typecheck、unit、integration 与生产 build**

```bash
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test lint
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test typecheck
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test test
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test test:integration
docker compose -p ai-super-canvas-s1-test -f compose.control-plane-test.yaml run --rm test build
```

Expected: 所有命令退出 0；记录每组实际通过数量，不根据旧数量推断。

- [ ] **Step 3: 运行全部 Playwright 与服务稳定性检查**

```bash
pnpm exec playwright test --project=chromium
systemctl --user is-active ai-super-canvas.service
systemctl --user show ai-super-canvas.service -p NRestarts -p ActiveState -p SubState
curl --fail --silent http://127.0.0.1:3000/api/health
curl --fail --silent http://127.0.0.1:3000/control-plane-test >/dev/null
```

Expected: Playwright 全绿；服务 `active/running`；测试期间 `NRestarts` 不增长；页面与 health 都返回成功。

- [ ] **Step 4: 更新 roadmap 的真实证据与限制**

在 `docs/architecture/development-roadmap.md` 的 S1 证据区记录：

- 本纵切最终 commit SHA；
- 数据库迁移名称；
- Repository、Control Plane、API、integration、Playwright 的实际通过数量；
- `/control-plane-test` 实际 URL；
- 浏览器刷新恢复已证明；
- 应用进程重启后 PostgreSQL transcript 可恢复，但内存 Fake Runtime ref 会被标记 unavailable；
- 现有画布 Golden Path 未回归；
- 未新增或修改端口。

- [ ] **Step 5: 执行最终差异与敏感信息检查**

```bash
git diff --check
git status --short
git diff -- .env.example compose.yaml Dockerfile
rg -n "(OPENAI_API_KEY=.{1,}|POSTGRES_PASSWORD=(?!replace-with))" . \
  --glob '!node_modules/**' --glob '!.git/**' --pcre2
```

Expected: 无 whitespace error；没有真实密钥；Compose 端口未变化；只包含本计划范围内文件。

- [ ] **Step 6: 提交执行证据**

```bash
git add docs/architecture/development-roadmap.md
git commit -m "docs: record real control-plane test evidence"
```

## 最终验收清单

- [ ] `/control-plane-test` 可以直接初始化、创建 Session、发送消息并看到 Fake Runtime 回复。
- [ ] PostgreSQL 中存在一条用户 Message、一条 assistant Message、一个 succeeded Run 和六个 RunEvent。
- [ ] 两条内容相同的 `model.output.delta` 因 eventId 不同而都被保留。
- [ ] 同一个 commandId 重试不会二次调用 Runtime。
- [ ] 相同 eventId 重放不会重复 Message 或 RunEvent。
- [ ] 浏览器刷新从 PostgreSQL 恢复相同 transcript。
- [ ] 服务重启后历史仍可见，旧 Fake Runtime ref 被如实标为不可用。
- [ ] ActorContext 始终由服务端注入，浏览器不能覆盖账号、模型或工具策略。
- [ ] Runtime outcome unknown 进入 `reconciling`，不盲目 redispatch。
- [ ] 现有结构化生长画布 Golden Path 仍通过。
- [ ] lint、typecheck、unit、integration、build 和全部 Playwright 均通过。
- [ ] 没有新增或修改主机端口。

## 执行顺序

Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9。Task 1–2 先证明数据库事务真相；Task 3–4 只依赖 Repository 合约；Task 5–6 只在服务层通过后开放 HTTP；Task 7 不直接访问 Repository 或 Runtime；Task 8–9 最后验证真实用户路径和现有功能不回归。

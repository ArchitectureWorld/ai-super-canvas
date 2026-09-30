# Real Agent Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用真实协议和可恢复边界替换生产中的单一 Fake Runtime，使 Canvas 能通过宿主 Unix Socket Worker 正确路由到 Jarvis Gateway、`zzh` ACP 和 `nsy` ACP。

**Architecture:** `RuntimeAdapterRegistry` 通过显式
`{ kind, adapter }` 条目注册多个单协议 `RuntimeAdapter`，Registry 自身没有单一
`kind`，但实现服务层依赖的同一组 Runtime 操作并按数据库 Binding 中的
`runtimeKind` 路由；Web 容器内 Adapter 只连接受权限保护的 Unix Socket；宿主
Python Worker 持有 Jarvis secret、Hermes home/profile 和 ACP 子进程；Worker
与 Hermes Gateway 都持久化幂等命令和可重放事件，未知结果进入
reconciliation，绝不自动回退 Fake。

**Tech Stack:** TypeScript 6.0.3、Node.js 24.18.0、Vitest 4.1.10、PostgreSQL 18、Drizzle、Python 3、aiohttp、SQLite WAL、Hermes ACP 0.9.0、systemd --user、Docker Compose。

---

## Global constraints

- 从总控计划创建的
  `codex/real-agent-product-experience` 工作树执行。
- 先完成 Runtime contract 和 migration，再并行实现 Worker/Jarvis/ACP。
- Worker 是唯一宿主桥；不得把 Jarvis 改绑 `0.0.0.0`，不得把 profile home 挂进 Web 容器。
- `RuntimeBindingContext` 必须包含 `runtimeKind`、Canvas Agent ID 和 external Agent ref；不得再在服务层丢失数据库 kind。
- `hermes-gateway` 和 `hermes-acp` 是不同协议，不通过 endpoint 字符串猜测。
- Worker 只接受精确逻辑 allowlist：
  `jarvis-local`、`zzh`、`nsy`；拒绝任意 URL、profile 名、文件路径和
  path traversal。profile 目录由受保护配置 root 加 allowlisted ID 推导并
  校验 realpath。
- `DeterministicFakeRuntime` 只在 `NODE_ENV=test` 或显式开发闸门下注册。
- 所有外部操作先写 durable command ledger；无法证明未执行时，返回 `operationEffect='unknown'`。
- v1 的真实 Jarvis/ACP Adapter 对 `toolApproval` 与 `cancellation` 诚实声明
  `unsupported`，对应方法在任何外部调用前返回 typed unsupported；产品工具策略
  不允许会触发审批的工具，也不展示停止/审批入口。后续只有在这些命令具备
  durable receipt 与 outcome lookup 后才能打开能力。
- Runtime 日志只记录安全 ID、kind、状态和错误码，不记录 prompt、secret、Cookie、raw ContextRef 内容或私人消息。
- 本计划先把记忆能力声明为 `unsupported`；第三个子计划完成请求级控制并通过隔离测试后才能改为可用。

## File map

### Canvas Runtime contract and registry

- Modify: `packages/ai/src/runtime/contract.ts`
- Modify: `packages/ai/src/runtime/contract-suite.ts`
- Modify: `packages/ai/src/runtime/deterministic-fake.ts`
- Create: `packages/ai/src/runtime/registry.ts`
- Create: `packages/ai/src/runtime/registry.test.ts`
- Modify: `packages/ai/src/runtime/index.ts`
- Modify: `packages/ai/src/runtime/deterministic-fake.test.ts`

### Runtime kind migration and persisted binding

- Modify: `packages/db/src/schema/enums.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Create: `packages/db/migrations/0009_real_agent_runtime.sql`
- Create: `packages/db/migrations/meta/0009_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

### Application routing and restart recovery

- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/run-event-pump.ts`
- Modify: `packages/control-plane/src/run-event-pump.test.ts`
- Modify: `packages/control-plane/src/dto.ts`
- Modify: `apps/web/src/server/control-plane.ts`
- Modify: `apps/web/src/server/control-plane.test.ts`

### Node Unix Socket adapters

- Create: `packages/ai/src/runtime/worker-protocol.ts`
- Create: `packages/ai/src/runtime/worker-client.ts`
- Create: `packages/ai/src/runtime/worker-client.test.ts`
- Create: `packages/ai/src/runtime/hermes-gateway.ts`
- Create: `packages/ai/src/runtime/hermes-gateway.test.ts`
- Create: `packages/ai/src/runtime/hermes-acp.ts`
- Create: `packages/ai/src/runtime/hermes-acp.test.ts`
- Modify: `packages/ai/src/runtime/index.ts`

### Host Runtime Worker

- Create: `services/hermes_runtime_worker/__init__.py`
- Create: `services/hermes_runtime_worker/protocol.py`
- Create: `services/hermes_runtime_worker/ledger.py`
- Create: `services/hermes_runtime_worker/jarvis.py`
- Create: `services/hermes_runtime_worker/acp_client.py`
- Create: `services/hermes_runtime_worker/server.py`
- Create: `services/hermes_runtime_worker/tests/test_protocol.py`
- Create: `services/hermes_runtime_worker/tests/test_ledger.py`
- Create: `services/hermes_runtime_worker/tests/test_jarvis.py`
- Create: `services/hermes_runtime_worker/tests/test_acp_client.py`
- Create: `services/hermes_runtime_worker/tests/fake_acp_server.py`
- Create:
  `services/hermes_runtime_worker/tests/fixtures/runtime-request-v1.json`

### Hermes protocol hardening in separate worktree

- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/gateway/api_run_store.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/gateway/platforms/api_server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/acp_adapter/server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/acp_adapter/session.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/gateway/test_api_server_canvas_runs.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/acp/test_server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/acp/test_session.py`
- Create: `deploy/systemd/hermes-gateway-canvas-runtime-policy.conf`
- Create:
  `/home/youran/.config/systemd/user/hermes-gateway.service.d/canvas-runtime-policy.conf`

### Deployment

- Create: `deploy/systemd/ai-super-canvas-runtime-worker.service`
- Create: `deploy/systemd/ai-super-canvas.service`
- Modify: `services/hermes_runtime_worker/server.py`
- Modify: `services/hermes_runtime_worker/tests/test_protocol.py`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Modify: `Dockerfile`
- Create: `scripts/check-runtime-worker.py`
- Create: `scripts/database-operator.ts`
- Create: `scripts/database-operator.test.ts`
- Create: `scripts/run-database-operation.sh`
- Create: `scripts/run-database-operation.test.sh`
- Create: `tsconfig.operator.json`
- Create: `scripts/install-runtime-release.sh`
- Create: `scripts/install-runtime-release.test.sh`
- Modify: `apps/web/src/app/api/health/route.ts`
- Create: `apps/web/src/app/api/health/route.test.ts`
- Modify: `apps/web/src/app/api/ready/handler.ts`
- Modify: `apps/web/src/app/api/ready/handler.test.ts`

---

### Task 1: Make Runtime kind impossible to lose

**Files:**

- Modify: `packages/ai/src/runtime/contract.ts`
- Modify: `packages/ai/src/runtime/contract-suite.ts`
- Modify: `packages/ai/src/runtime/deterministic-fake.ts`
- Modify: `packages/ai/src/runtime/deterministic-fake.test.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/run-event-pump.ts`
- Modify: `packages/control-plane/src/run-event-pump.test.ts`

- [ ] **Step 1: Write RED tests for the complete binding identity**

Add exact expectations in both application tests:

```ts
expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
  binding: {
    runtimeKind: 'hermes-acp',
    canvasAgentBindingId: bindingId,
    canvasAgentId: agentId,
    externalAgentRef: 'zzh',
    isolationKey: 'profile:zzh',
    endpointRef: 'worker:profile:zzh',
  },
}));
```

Add the equivalent `startRun` and `streamRunEvents` assertions. Add a contract
test that a Fake descriptor is rejected when the binding says
`hermes-gateway`.

Run:

```bash
docker run --rm ai-super-canvas:real-agent-baseline \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  packages/control-plane/src/run-event-pump.test.ts \
  packages/ai/src/runtime/deterministic-fake.test.ts
```

Expected: FAIL because `RuntimeBindingContext` does not contain the new fields
and `toSessionBinding`/`toRuntimeBinding` drop `runtime_kind` and
`external_agent_ref`.

- [ ] **Step 2: Extend the contract**

Use this exact shape:

```ts
export type RuntimeKind =
  | 'fake'
  | 'hermes-gateway'
  | 'hermes-acp'
  | 'letta'
  | 'langgraph'
  | 'canvas-native';

export interface RuntimeBindingContext {
  runtimeKind: RuntimeKind;
  canvasAgentBindingId: string;
  canvasAgentId: string;
  externalAgentRef?: string;
  isolationKey: string;
  endpointRef?: string;
  secretRef?: string;
}
```

Define one transport-neutral seed used for initial creation and later
memory-policy rotation:

```ts
export interface RuntimeTranscriptSeed {
  version: 1;
  transcriptVersion: number;
  transcriptDigest: string;
  messages: Array<{
    canvasMessageId: string;
    role: 'user' | 'assistant';
    content: string;
    contentDigest: string;
  }>;
}
```

`CreateRuntimeSessionInput.sessionGenerationKey` is also required as a
lowercase SHA-256. Initial creation derives it from Binding, Canvas Session and
initial config revision; the Memory plan extends the same formula with policy
and context digests. `transcriptSeed` is required, including an empty seed for
a new conversation. The digest uses the same canonical safe message schema as
`loadSession`/Jarvis history verification. Raw tool payloads, system prompts
and native memory are never seed messages. Reject a non-canonical digest,
messages above 64 KiB each or a total seed above 4 MiB with a safe
`context_rejected/not-applied` error whose safe reason is
`transcript_seed_too_large`; never truncate silently.

Add a protocol-neutral reconciliation operation:

```ts
export type RuntimeCommandOutcome =
  | {
      outcome: 'applied';
      resourceKind: 'session' | 'run';
      externalResourceRef: string;
      evidence: SafeRuntimeOutcomeEvidence;
    }
  | { outcome: 'not-applied'; evidence: SafeRuntimeOutcomeEvidence }
  | { outcome: 'indeterminate'; evidence: SafeRuntimeOutcomeEvidence };

export interface SafeRuntimeOutcomeEvidence {
  commandId: string;
  operation: 'create_session' | 'start_run';
  observedPhase:
    | 'prepared'
    | 'dispatching'
    | 'accepted'
    | 'not_applied'
    | 'indeterminate';
  checkedAt: string;
  requestFingerprint: string;
}
```

`RuntimeAdapter.inspectCommandOutcome()` receives Binding, command ID,
operation kind and Canvas Session/Run ID. Its evidence is allowlisted and
strict; it cannot contain arbitrary provider JSON, prompts, paths or secrets.
Add `commandOutcomeInspection: CapabilitySupport` to
`RuntimeCapabilities`; an Adapter that cannot distinguish absence from an
in-flight loss must return `indeterminate`, not fabricate `not-applied`.

Tighten the successful control-plane return types in the same contract change:

```ts
interface RuntimeSessionRef {
  externalSessionRef: string;
  historyDigest: string;
}

interface RuntimeRunRef {
  externalRunRef: string;
}
```

These fields are required for every successful Adapter result. A Runtime that
cannot provide them must return a typed unsupported/protocol error, not a
nominal success with optional fields that `SessionService` later rejects.
Update the shared contract suite, Fake and both real Adapter tests accordingly.

Update `SessionRuntimeContext.binding`, `RuntimeBindingSnapshot` and every
binding conversion. Parse stored kinds against the RuntimeKind allowlist;
unknown stored values throw before any Runtime call.

The Repository queries used by `authorizeWorkflow`, `authorizeSession`, and
`authorizeRun` must all select `external_agent_ref`. Add it to persisted
Binding snapshot parsing and to `toSessionBinding`, `dispatchPreparedRun`, and
`toRuntimeBinding`; a missing required external ref for a real Binding fails
before any Runtime call. Update `contract-suite.ts`, every Fake fixture and
`deterministic-fake.ts` for the new Adapter kind/Binding fields in the same
change.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test \
  --tag ai-super-canvas:runtime-binding .
docker run --rm ai-super-canvas:runtime-binding \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  packages/control-plane/src/run-event-pump.test.ts \
  packages/ai/src/runtime/deterministic-fake.test.ts
git diff --check
git add packages/ai packages/control-plane packages/db/src/repositories
git commit -m "refactor(runtime): preserve binding protocol identity"
```

Expected: focused tests pass and the commit contains no migration or Worker code.

---

### Task 2: Add `hermes-gateway` to PostgreSQL

**Files:**

- Modify: `packages/db/src/schema/enums.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Create: `packages/db/migrations/0009_real_agent_runtime.sql`
- Create: `packages/db/migrations/meta/0009_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Write RED schema and Repository tests**

Add assertions that:

```ts
expect(runtimeKind.enumValues).toEqual([
  'fake',
  'hermes-gateway',
  'hermes-acp',
  'letta',
  'langgraph',
  'canvas-native',
]);
```

The integration test inserts a ready primary `hermes-gateway` Binding and
asserts `getSessionRuntimeContext()` and `prepareRun()` both return exactly
`runtimeKind: 'hermes-gateway'`.

Run:

```bash
docker run --rm ai-super-canvas:runtime-binding \
  vitest run packages/db/src/schema/schema-contract.test.ts
```

Expected: FAIL because `hermes-gateway` is absent.

- [ ] **Step 2: Modify the enum and generate migration 0009**

Add `hermes-gateway` immediately after `fake` in `enums.ts`. Use a host shell
whose Node satisfies the repository engine; do not bind-mount the worktree
over a container's installed `/workspace/node_modules`.

```bash
node --version
DATABASE_URL=postgres://migration:unused@127.0.0.1:1/canvas_s1_test \
  corepack pnpm --filter @ai-super-canvas/db exec \
  drizzle-kit generate --name real_agent_runtime
```

Expected:

- Node reports `v24.18.0` or another allowed 24.x version;
- `0009_real_agent_runtime.sql` contains
  `ALTER TYPE "public"."runtime_kind" ADD VALUE 'hermes-gateway'`;
- Drizzle snapshot and journal are updated;
- no unrelated table is recreated or dropped.

- [ ] **Step 3: Run schema and real DB GREEN**

```bash
docker build --target test \
  --tag ai-super-canvas:runtime-schema .
docker run --rm ai-super-canvas:runtime-schema \
  vitest run packages/db/src/schema/schema-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-runtime-schema \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db
git commit -m "feat(db): add Hermes Gateway runtime kind"
```

Expected: schema contract and all disposable database integration tests pass.

---

### Task 3: Route every Runtime operation through a strict registry

**Files:**

- Create: `packages/ai/src/runtime/registry.ts`
- Create: `packages/ai/src/runtime/registry.test.ts`
- Modify: `packages/ai/src/runtime/contract-suite.ts`
- Modify: `packages/ai/src/runtime/deterministic-fake.ts`
- Modify: `packages/ai/src/runtime/deterministic-fake.test.ts`
- Modify: `packages/ai/src/runtime/index.ts`

- [ ] **Step 1: Write the table-driven RED suite**

Create one spy Adapter for each kind and test all contract methods:

```ts
const operations = [
  'describe',
  'health',
  'listModels',
  'createSession',
  'loadSession',
  'listSessions',
  'forkSession',
  'startRun',
  'inspectCommandOutcome',
  'streamRunEvents',
  'cancelRun',
  'respondToApproval',
  'setSessionModel',
  'setSessionToolPolicy',
  'exportSnapshot',
  'restoreSnapshot',
  'shutdown',
] as const;
```

For each operation assert:

- only the Adapter matching `binding.runtimeKind` is called;
- missing Adapter throws `RuntimeAdapterError('binding_not_found', ...,
  false, 'not-applied')`;
- duplicate registration throws synchronously;
- `describe().kind !== binding.runtimeKind` throws
  `RuntimeAdapterError('protocol_error', ..., false, 'not-applied')`;
- no branch falls back to Fake.

Run:

```bash
docker run --rm ai-super-canvas:runtime-schema \
  vitest run packages/ai/src/runtime/registry.test.ts
```

Expected: FAIL because `registry.ts` does not exist.

- [ ] **Step 2: Implement the strict resolver**

The core resolver must be:

```ts
export class RuntimeAdapterRegistry implements RuntimeAdapter {
  private readonly adapters: ReadonlyMap<RuntimeKind, RuntimeAdapter>;

  constructor(
    entries: readonly {
      kind: RuntimeKind;
      adapter: RuntimeAdapter;
    }[],
  ) {
    const resolved = new Map<RuntimeKind, RuntimeAdapter>();
    for (const { kind, adapter } of entries) {
      if (resolved.has(kind)) {
        throw new Error(`Duplicate Runtime adapter: ${kind}`);
      }
      resolved.set(kind, adapter);
    }
    this.adapters = resolved;
  }

  private resolveCandidate(binding: RuntimeBindingContext): RuntimeAdapter {
    const adapter = this.adapters.get(binding.runtimeKind);
    if (!adapter) {
      throw new RuntimeAdapterError(
        'binding_not_found',
        `No Runtime adapter is registered for ${binding.runtimeKind}`,
        false,
        'not-applied',
      );
    }
    return adapter;
  }
}
```

Do not add a single `kind` field to `RuntimeAdapter` or the Registry. The
registration key is authoritative only for candidate lookup. Before every
Binding-scoped operation, Registry first performs the read-only
`adapter.describe(binding)`, verifies its returned kind equals both the
registration key and Binding kind, and only then invokes the requested
operation. A mismatch calls no side-effecting Adapter method. `describe`
validates its own result; `shutdown` iterates each explicitly registered
Adapter once. Tests assert that a mismatched Adapter sees only `describe`, not
`createSession`, `startRun`, cancellation or any other operation.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test \
  --tag ai-super-canvas:runtime-registry .
docker run --rm ai-super-canvas:runtime-registry \
  vitest run packages/ai/src/runtime/registry.test.ts
git diff --check
git add packages/ai
git commit -m "feat(runtime): add strict adapter registry"
```

Expected: all registry methods route by explicit kind and no fallback test fails.

---

### Task 4: Make transcript reads offline-first and event replay cursor-aware

**Files:**

- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/dto.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/run-event-pump.ts`
- Modify: `packages/control-plane/src/run-event-pump.test.ts`

- [ ] **Step 1: Write RED for history without Runtime**

The test loads a persisted transcript while `runtime.loadSession` throws and
asserts:

```ts
expect(result.messages).toEqual(persistedMessages);
expect(runtime.loadSession).not.toHaveBeenCalled();
expect(result.runtimeAvailability).toBe('unknown');
```

Change `RuntimeAvailability` to:

```ts
export type RuntimeAvailability =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown';
```

Run:

```bash
docker run --rm ai-super-canvas:runtime-registry \
  vitest run packages/control-plane/src/session-service.test.ts
```

Expected: FAIL because `getSessionTranscript()` performs a live Runtime probe.

- [ ] **Step 2: Write RED for replay cursor**

Persist events with external refs `e-1`, `e-2`, then restart the pump. Assert:

```ts
expect(runtime.streamRunEvents).toHaveBeenCalledWith(expect.objectContaining({
  afterExternalEventRef: 'e-2',
}));
```

Also assert duplicate replayed `e-2` is idempotent and the next event becomes
sequence 3 exactly once.

Add restart reconciliation tests:

- Worker reports `applied` Session/Run: Canvas records the known external ref
  and uses the existing attach path;
- Worker reports `not-applied`: Canvas marks the command retryable but does not
  resend automatically;
- Worker reports `indeterminate`: Canvas remains reconciling and disables
  resend;
- inspection itself fails: state remains reconciling;
- no branch calls `createSession` or `startRun` a second time.

- [ ] **Step 3: Implement persisted-only reads and cursor loading**

- `getSessionTranscript()` only reads `loadSessionSnapshot()`.
- Agent health is fetched by the safe Agent catalog endpoint, not transcript reads.
- Add `lastExternalEventRef` to `RunRuntimeContext`.
- Query the last non-null `run_events.external_event_ref` by sequence.
- Pass it to `streamRunEvents`.
- On process start, list active/reconciling Runs with their persisted
  `ActorContext`; resume only adapters whose descriptor advertises event replay.
- Unsupported replay remains reconciling and never resends `startRun`.
- For reconciling Session/Run receipts, call
  `inspectCommandOutcome()` and feed only proven `applied` results through the
  existing `recordRuntimeResourceKnown`/attach path. `not-applied` merely
  enables an explicit user retry; `indeterminate` remains blocked.

- [ ] **Step 4: Run GREEN and commit**

```bash
docker build --target test \
  --tag ai-super-canvas:runtime-replay .
docker run --rm ai-super-canvas:runtime-replay \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  packages/control-plane/src/run-event-pump.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-runtime-replay \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/control-plane packages/db
git commit -m "fix(control-plane): read offline history and resume event cursors"
```

Expected: history stays readable with Runtime down; replay resumes after the last
persisted external event.

---

### Task 5: Define the versioned Unix Socket protocol

**Files:**

- Modify: `packages/ai/src/runtime/contract.ts`
- Create: `packages/ai/src/runtime/worker-protocol.ts`
- Create: `packages/ai/src/runtime/worker-client.ts`
- Create: `packages/ai/src/runtime/worker-client.test.ts`
- Create: `services/hermes_runtime_worker/protocol.py`
- Create: `services/hermes_runtime_worker/tests/test_protocol.py`
- Create:
  `services/hermes_runtime_worker/tests/fixtures/runtime-request-v1.json`

- [ ] **Step 1: Write RED protocol parity tests**

Use one shared JSON fixture under:

`services/hermes_runtime_worker/tests/fixtures/runtime-request-v1.json`

The request shape is fixed:

```json
{
  "protocolVersion": 1,
  "requestId": "11111111-1111-4111-8111-111111111111",
  "operation": "health",
  "binding": {
    "runtimeKind": "hermes-gateway",
    "canvasAgentBindingId": "22222222-2222-4222-8222-222222222222",
    "canvasAgentId": "33333333-3333-4333-8333-333333333333",
    "externalAgentRef": "jarvis-local",
    "isolationKey": "gateway:jarvis-local",
    "endpointRef": "worker:jarvis",
    "secretRef": "worker-secret:jarvis-api"
  },
  "input": {}
}
```

Responses are exactly one of:

```ts
interface WorkerSuccess<O extends WorkerOperation> {
  protocolVersion: 1;
  requestId: string;
  operation: O;
  ok: true;
  result: WorkerOperationMap[O]['result'];
}

interface WorkerFailure {
  protocolVersion: 1;
  requestId: string;
  operation: WorkerOperation;
  ok: false;
  error: {
    code: RuntimeErrorCode;
    retryable: boolean;
    operationEffect: RuntimeOperationEffect;
    safeReason?: WorkerSafeReason;
  };
}

type WorkerSafeReason =
  | 'capability_disabled'
  | 'history_digest_mismatch'
  | 'transcript_seed_too_large'
  | 'upstream_response_lost'
  | 'profile_unavailable';
```

Extend the shared `RuntimeErrorCode` union with
`'command_payload_conflict'`. It is the only code used when an existing
`bindingId + commandId` is presented with a different canonical payload
digest; it is non-retryable with `operationEffect='not-applied'`. TypeScript
and Python parity fixtures must prove the code is accepted, and must reject
any Worker error code that is absent from the shared union.

Define `WorkerOperationMap` as a closed discriminated map for every supported
operation (`describe`, `health`, `list_models`, `create_session`,
`load_session`, `list_sessions`, `fork_session`, `start_run`,
`inspect_command_outcome`, `open_event_stream`, model/tool/snapshot operations
and the explicitly unsupported cancellation/approval methods). The protocol
also reserves two non-Adapter operator operations:
`cleanup_acceptance_session`, whose exact input is
`{commandId, externalSessionRef, sessionGenerationKey,
receiptFingerprint}` and whose result is
`{status:'deleted'|'already_absent'}`, and `cleanup_acceptance_run`, whose
exact input is `{commandId, externalRunRef, receiptFingerprint}` with the same
result union. They are rejected unless the Worker is in
acceptance mode on an acceptance-scoped Socket/state directory, every field
plus the envelope's `binding.canvasAgentBindingId` matches one durable ledger
receipt, and that receipt was created by the current nonce manifest. It is
never exported by `RuntimeAdapter`, registered in Web, or callable from a
browser route. Run cleanup requires an already-terminal Run and deletes only
that Run's upstream/Worker event rows; Session cleanup refuses while any
manifest Run for that Session is active or not yet cleaned.

Each entry has an exact input/result schema built from the Runtime contract
types; no `unknown`, passthrough object or arbitrary provider payload is
allowed.
`inspect_command_outcome.result` is exactly `RuntimeCommandOutcome` with
`SafeRuntimeOutcomeEvidence`. Python defines the same enum/error/safe-reason
allowlists and parity fixtures exercise one success and failure per operation.

The Python and TypeScript tests must reject unknown keys, unknown versions,
kind mismatches, missing IDs and response bodies containing `secretRef`.
Include `inspect_command_outcome` in the closed operation allowlist and prove
its result matches `RuntimeCommandOutcome`. `requestId` 只关联一次 UDS
传输；任何产生副作用的请求必须另带 Canvas `input.commandId`。同一个
`commandId` 可因断线拥有不同 `requestId`，Worker ledger 永远按
`bindingId + commandId` 幂等，绝不能拿传输 ID 当业务幂等键。

Run:

```bash
docker run --rm ai-super-canvas:runtime-replay \
  vitest run packages/ai/src/runtime/worker-client.test.ts
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_protocol.py
```

Expected: both fail because the protocol modules do not exist.

- [ ] **Step 2: Implement strict schemas and UDS client**

The Node client uses `node:http.request` with:

```ts
{
  socketPath: environment.CANVAS_RUNTIME_SOCKET,
  path: '/v1/runtime',
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  },
}
```

Fixed limits:

- connect timeout: 2 seconds;
- ordinary request timeout: 15 seconds;
- max JSON response: 1 MiB;
- Worker sends an NDJSON heartbeat every 30 seconds while a Run is active;
- heartbeat is never persisted and the Node client never exposes it as a
  Runtime event;
- event-stream transport timeout is five minutes without heartbeat, while the
  Run lifetime remains governed by the configured Run timeout;
- no request/response body logging.

Validate `CANVAS_RUNTIME_SOCKET` is an absolute path and not `/`, `/tmp` or a
symlink outside the configured Runtime directory.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test \
  --tag ai-super-canvas:worker-protocol .
docker run --rm ai-super-canvas:worker-protocol \
  vitest run packages/ai/src/runtime/worker-client.test.ts
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_protocol.py
git diff --check
git add packages/ai services/hermes_runtime_worker
git commit -m "feat(runtime): define host worker socket protocol"
```

Expected: TypeScript and Python accept/reject the same fixtures.

---

### Task 6: Build a durable Worker command and event ledger

**Files:**

- Create: `services/hermes_runtime_worker/ledger.py`
- Create: `services/hermes_runtime_worker/tests/test_ledger.py`
- Create: `services/hermes_runtime_worker/server.py`

- [ ] **Step 1: Write RED ledger tests**

Use a temporary SQLite database and cover:

- same command ID + same canonical payload returns the original result;
- same command ID + different transport request IDs after the first response is
  dropped returns the original result and invokes upstream exactly once;
- same command ID + different digest returns `command_payload_conflict`;
- command transitions:
  `prepared -> dispatching -> accepted | not_applied | indeterminate`;
- crash after `dispatching` restores as `indeterminate`;
- the same command ID in different Bindings cannot collide;
- external event ref is unique per Binding and Run;
- event replay after cursor returns only later events;
- disconnecting the Web/UDS event client does not cancel upstream execution;
  Worker keeps consuming and persisting events, and a later client replays
  them;
- one terminal event per Run;
- WAL mode and `busy_timeout` allow `zzh`/`nsy` concurrent writers.
- state directory is `0700`, database and WAL files are not broader than
  `0600`, and terminal cleanup never deletes non-terminal work.
- both acceptance cleanup operations are rejected in normal mode, while the
  manifest is `open` or `sealed`, for a different
  Binding/generation/fingerprint, or for a command absent from the nonce
  manifest; Run cleanup is rejected before terminal,
  Session cleanup is rejected before its Runs, and an exact repeated cleanup
  returns `already_absent` without touching another Session/Run.

Run:

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_ledger.py
```

Expected: FAIL because `ledger.py` does not exist.

- [ ] **Step 2: Implement the SQLite schema**

Use these tables:

```sql
CREATE TABLE commands (
  command_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  phase TEXT NOT NULL,
  external_resource_ref TEXT,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (binding_id, command_id)
);

CREATE TABLE run_events (
  binding_id TEXT NOT NULL,
  run_ref TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  external_event_ref TEXT NOT NULL,
  event_json TEXT NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding_id, run_ref, sequence),
  UNIQUE (binding_id, run_ref, external_event_ref)
);
```

Initialize with `PRAGMA journal_mode=WAL`, `foreign_keys=ON`,
`busy_timeout=5000`. Canonical JSON uses sorted keys and compact separators;
digest uses SHA-256. The Worker owns a private `0700` state directory, sets
SQLite files to `0600`, retains terminal rows for 30 days, and never prunes
`prepared`, `dispatching`, or `indeterminate` rows.

- [ ] **Step 3: Implement `/v1/runtime` and event streaming**

`server.py`:

- binds only the configured Unix Socket;
- removes only its own stale socket after verifying it is a socket;
- creates parent directory mode `0750`;
- creates socket mode `0660`;
- dispatches a closed operation allowlist;
- keeps both cleanup operations outside the normal dispatch table and installs
  them only for an acceptance-scoped Worker whose environment contains an
  exact nonce manifest path owned by the current user and mode `0600`;
- answers `inspect_command_outcome` only from the durable ledger plus a
  transport-specific read-only probe; it never repeats the original command;
- returns only safe error codes;
- exposes `GET /health` over the same Socket;
- accepts the closed `open_event_stream` operation only for an existing
  `bindingId + runRef`, and returns a cryptographically random opaque
  128-bit token with a 60-second establishment deadline;
- streams NDJSON events only through
  `GET /v1/runtime/bindings/{binding_id}/runs/{run_ref}/events?after=<external-ref>`
  with `X-Canvas-Stream-Token`; the token is scoped to that exact Binding and
  Run, is single-subscriber, expires on disconnect, is kept only in Worker
  memory, and is never logged or persisted;
- emits non-persisted heartbeats while an upstream Run remains active.
- owns upstream Run-consumer tasks independently from any UDS response
  connection; client disconnect only detaches that subscriber.

The Node Adapter obtains a fresh token immediately before each stream
subscription and keeps it only in process memory. After either Web or Worker
restart it calls `open_event_stream` again, so recovery never depends on
persisting a bearer token in PostgreSQL or browser storage. Tests cover a
token replay, wrong Binding, wrong Run, expiry, reconnect after Worker restart,
and the same `runRef` value in two Bindings.

The shared acceptance-wrapper manifest contract is durable JSONL under a
wrapper-private `0700` state directory, owned by the current user and mode
`0600`. Its header fixes nonce, database instance ID, Canvas/Hermes revisions
and state `open|cleaning|sealed`; entries contain only safe command IDs,
receipt/resource IDs and exact synthetic native-marker locators. The browser
child cannot open the file. It may append a command ID or marker only through
the private operator channel before dispatch; the wrapper resolves external
refs from the nonce database receipts.

On `EXIT`, `INT`, `TERM` or `HUP`, the outer wrapper atomically changes
`open -> cleaning`, rejects new child appends, cleans terminal Runs first,
then Sessions, exact native markers and auth resources, verifies both
Run/Session manifests have no unresolved ref, marks `sealed`, stops the
acceptance Worker and finally runs the exact nonce `docker compose down -v`.
Cleanup operations accept only `cleaning`; they reject `open` and `sealed`.
On startup every wrapper resumes any owned unsealed manifest before it can
allocate another nonce, covering a prior host/process crash where a shell trap
could not finish.

- [ ] **Step 4: Run GREEN and commit**

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_protocol.py \
  services/hermes_runtime_worker/tests/test_ledger.py
git diff --check
git add services/hermes_runtime_worker
git commit -m "feat(runtime-worker): persist commands and replayable events"
```

Expected: duplicate commands are safe and restart leaves uncertain work in a
durable reconciling state.

---

### Task 7: Implement the Jarvis Gateway transport

**Files:**

- Create: `services/hermes_runtime_worker/jarvis.py`
- Create: `services/hermes_runtime_worker/tests/test_jarvis.py`
- Create: `packages/ai/src/runtime/hermes-gateway.ts`
- Create: `packages/ai/src/runtime/hermes-gateway.test.ts`

- [ ] **Step 1: Write RED against a fake loopback Hermes server**

The fake server must cover:

- Bearer auth is added by Worker and never returned;
- `GET /v1/capabilities` drives descriptor capabilities;
- `POST /api/sessions` uses:
  `canvas:<binding-id>:<canvas-session-id>:<session-generation-key>`;
- the external Session ID is deterministic for the Canvas Session;
- a lost create response or 409 causes `GET` of that exact ID and adoption only
  after ownership/session-key verification;
- `createSession` sends the required canonical `transcriptSeed`; Gateway
  imports all seed messages atomically before the Session receipt becomes
  applied, and `GET /api/sessions/:id/messages` immediately reproduces the same
  transcript digest;
- Session idempotency/request fingerprints include seed digest, version and
  message count plus `sessionGenerationKey`, so the same Canvas Session's new
  generation can never adopt the old external Session or divergent history;
- `X-Hermes-Session-Key` starts with `canvas:`;
- immediately before `POST /v1/runs`, Worker loads
  `/api/sessions/:id/messages`, computes the canonical digest, compares
  `expectedHistoryDigest`, and sends the same messages as
  `conversation_history`;
- digest mismatch returns `history_diverged/not-applied`;
- `/v1/runs` receives `client_run_id` and `idempotency_key`;
- SSE events map only through an allowlist;
- 401 maps to non-retryable `protocol_error`;
- connect refusal maps to retryable `runtime_unavailable` with
  `operationEffect='not-applied'` before dispatch;
- connection loss after dispatch maps to `operationEffect='unknown'`;
- a controlled fault after upstream acceptance but before the UDS response
  reaches Web leaves exactly one durable accepted/indeterminate command;
  `inspectCommandOutcome` converges without resending the external operation;
- that fault is available only when
  `CANVAS_ACCEPTANCE_TEST_MODE=1` and
  `CANVAS_ACCEPTANCE_FAULT_AFTER_ACCEPT_COMMAND_ID=<uuid>` are both set at
  Worker startup; it matches exactly one command ID, atomically records
  `fault_consumed=1` before dropping exactly one response, and is impossible
  to arm with a wildcard. Production startup rejects either setting unless
  the Worker uses an acceptance-scoped Socket and state directory. Health
  reports only safe `acceptanceTestMode`/`faultArmed` booleans, never the ID;
- inspection resolves a deterministic Session and a durable Gateway Run as
  `applied`, a proven absent pre-dispatch command as `not-applied`, and every
  unresolved post-dispatch gap as `indeterminate`;
- after Worker restart, a Jarvis Run still present in Gateway is polled to
  terminal; if intermediate SSE events were missed, Worker synthesizes one
  allowlisted `message.completed` plus terminal event from the durable final
  output and marks replay completeness in safe metadata;
- no error string contains the configured key.
- acceptance cleanup first revalidates the exact Session create receipt and
  generation, then calls authenticated
  `DELETE /api/sessions/{external_session_id}`; a mismatched or non-manifest
  Session is rejected before the Gateway call, and a repeated exact cleanup is
  idempotent.
- acceptance Run cleanup revalidates the terminal Run receipt and calls
  authenticated
  `DELETE /v1/canvas/runs/{client_run_id}/commands/{idempotency_key}` with the
  expected owner/request fingerprints; the Gateway removes only that Run's
  event/output rows and retains a non-content tombstone for idempotent cleanup.

Run:

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_jarvis.py
docker run --rm ai-super-canvas:worker-protocol \
  vitest run packages/ai/src/runtime/hermes-gateway.test.ts
```

Expected: FAIL because Jarvis transport/Adapter do not exist.

- [ ] **Step 2: Implement the exact mapping**

| Runtime operation | Hermes endpoint |
| --- | --- |
| `describe` | `GET /v1/capabilities` |
| `health` | `GET /health/detailed` |
| `listModels` | `GET /v1/models` |
| `createSession` | `POST /api/sessions` |
| `loadSession` | `GET /api/sessions/:id` + `/messages` |
| `listSessions` | `GET /api/sessions?source=api_server` |
| `forkSession` | `POST /api/sessions/:id/fork` |
| `startRun` | `POST /v1/runs` |
| `streamRunEvents` | `GET /v1/runs/:id/events` |
| `cancelRun` | v1 `unsupported`; do not call `/stop` |
| `respondToApproval` | v1 `unsupported`; do not call `/approval` |

`cleanup_acceptance_session` is not a Runtime operation in this table. The
acceptance-only Worker operator uses the existing authenticated Gateway
Session DELETE only after the durable receipt check described above.
`cleanup_acceptance_run` likewise uses only the Canvas-specific terminal Run
cleanup endpoint and is never advertised as a product capability.

The Adapter advertises `toolApproval=false` and `cancellation=false`. Calls to
those two contract methods return `unsupported/not-applied` before the Worker
or Gateway is contacted. The product tool policy excludes any Jarvis tool that
can require interactive approval.

Model switching remains `unsupported` until a real Jarvis endpoint proves it.
The current `/v1/models` result is one fixed `hermes-agent` entry and does not
control `_create_agent`; report it as non-switchable and keep product model
selection hidden. `historyDigest` is SHA-256 over one fixed canonical safe
message schema, never over raw HTTP. `startRun` must send the exact canonical
history it just verified; it may not continue with an empty or divergent
history.

- [ ] **Step 3: Run GREEN and commit**

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_jarvis.py
docker build --target test \
  --tag ai-super-canvas:jarvis-adapter .
docker run --rm ai-super-canvas:jarvis-adapter \
  vitest run packages/ai/src/runtime/hermes-gateway.test.ts
git diff --check
git add packages/ai services/hermes_runtime_worker
git commit -m "feat(runtime): connect Jarvis through the host worker"
```

Expected: normalized events contain no raw Hermes refs or secret.

---

### Task 8: Implement profile-scoped ACP transport

**Files:**

- Create: `services/hermes_runtime_worker/acp_client.py`
- Create: `services/hermes_runtime_worker/tests/fake_acp_server.py`
- Create: `services/hermes_runtime_worker/tests/test_acp_client.py`
- Create: `packages/ai/src/runtime/hermes-acp.ts`
- Create: `packages/ai/src/runtime/hermes-acp.test.ts`

- [ ] **Step 1: Write RED for process/profile isolation**

The fake ACP process records argv/env and emits newline-delimited JSON-RPC.
Assert:

- command is the absolute Hermes venv Python;
- module argv is exactly `-m hermes_cli.main acp`, the reviewed existing
  Hermes ACP entrypoint;
- `PYTHONPATH` is the reviewed Hermes policy worktree;
- `HERMES_HOME` is exactly the selected profile directory
  `/home/youran/hermes-personal-assistants/profiles/zzh` or
  `/home/youran/hermes-personal-assistants/profiles/nsy`;
- other inherited `HERMES_HOME` values are overwritten;
- `session/new`, `session/load`, `session/fork` and `session/prompt` map
  correctly;
- `cancelRun` returns typed `unsupported/not-applied` before any Worker/ACP
  call;
- `_meta.hermes.sessionKey` is exactly
  `canvas:<binding-id>:<canvas-session-id>:<session-generation-key>`;
- `_meta.hermes.transcriptSeed` is strict/canonical; `session/new` imports it
  atomically, and immediate `session/load` reports the same digest before a
  prompt is allowed;
- one long-lived process serves all Canvas Sessions for one profile;
- `zzh` and `nsy` never share process, Session ID, approval request or ledger row;
- process death after dispatch is unknown, not retryable automatic fallback;
- two generation keys for one Canvas Session produce distinct ACP Session IDs
  and neither load/adopt path can resolve the older generation;
- `inspect_command_outcome` returns `indeterminate` for an ACP prompt whose
  process died in flight; ACP does not claim in-flight recovery;
- stderr is bounded/redacted and stdout accepts JSON only.
- acceptance cleanup verifies the exact ledger receipt and loaded ACP
  generation metadata, terminates only that profile's idle ACP process,
  invokes Hermes `SessionManager.remove_session(externalSessionId)` under the
  same allowlisted `HERMES_HOME`, verifies absence, and restarts the profile
  process; it refuses cleanup while that Session has an active Run and never
  scans/deletes by prefix.

Run:

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_acp_client.py
docker run --rm ai-super-canvas:jarvis-adapter \
  vitest run packages/ai/src/runtime/hermes-acp.test.ts
```

Expected: FAIL because ACP transport/Adapter do not exist.

- [ ] **Step 2: Implement ACP JSON-RPC**

Fixed client flow:

```text
spawn
  -> initialize(protocolVersion=1)
  -> session/new(transcriptSeed) or session/load + digest verification
  -> session/prompt
  -> session/update notifications -> normalized Runtime events
  -> PromptResponse -> exactly one terminal event
```

Client requests use increasing integer IDs. It must answer:

- `session/request_permission` with a deny response in v1 and terminate the Run
  as a safe typed unsupported outcome; no approval UI is advertised;
- `fs/read_text_file` only inside the Canvas workspace;
- `fs/write_text_file` is denied in this product slice;
- unknown ACP client method with JSON-RPC `-32601`.

Keep one long-lived process per allowed profile, so the maximum is two
processes (`zzh`, `nsy`). The ACP server already provides multiple Sessions,
per-Session runtime locks and a bounded global executor; do not start one
process per Canvas Session. A profile process may close after 15 minutes only
when it has no active prompt or attached client Session; SessionDB remains
durable and the Worker can load it again.

The composition root registers this Adapter explicitly under
`kind: 'hermes-acp'`; the Adapter itself does not carry a second routing key.
It advertises `toolApproval=false` and `cancellation=false`; neither operation
is forwarded to ACP in v1.

- [ ] **Step 3: Run GREEN and commit**

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_acp_client.py
docker build --target test \
  --tag ai-super-canvas:acp-adapter .
docker run --rm ai-super-canvas:acp-adapter \
  vitest run packages/ai/src/runtime/hermes-acp.test.ts
git diff --check
git add packages/ai services/hermes_runtime_worker
git commit -m "feat(runtime): connect personal assistants through ACP"
```

Expected: the two personal profiles are isolated and no raw profile path crosses
the Node Adapter boundary.

---

### Task 9: Harden Jarvis durability and ACP Canvas Session namespacing

**Files:**

- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/gateway/api_run_store.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/gateway/platforms/api_server.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/gateway/test_api_server_canvas_runs.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/acp_adapter/server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/acp_adapter/session.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/acp/test_server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/acp/test_session.py`

- [ ] **Step 1: Protect the dirty Hermes checkout**

```bash
cd /home/youran/.hermes/hermes-agent
git status --short
git diff --name-only -- \
  gateway/api_run_store.py \
  gateway/platforms/api_server.py \
  tests/gateway/test_api_server_canvas_runs.py \
  acp_adapter/server.py \
  acp_adapter/session.py \
  tests/acp/test_server.py \
  tests/acp/test_session.py
```

Expected: the full checkout may have unrelated user changes, but the three
target paths are clean. If any target path is dirty, stop this task and report
the overlap instead of overwriting it.

Create the isolated worktree:

```bash
git worktree add \
  -b codex/canvas-runtime-policy \
  /home/youran/.hermes/.worktrees/canvas-runtime-policy \
  "$(git rev-parse HEAD)"
cd /home/youran/.hermes/.worktrees/canvas-runtime-policy
```

- [ ] **Step 2: Write RED API behavior tests**

Test:

- `POST /v1/runs` accepts `client_run_id` and `idempotency_key`;
- same pair + same request fingerprint returns the original Run;
- same pair + different request returns 409;
- status and events survive a new `ApiServerPlatform` instance;
- `after` replays only later events;
- startup changes incomplete `queued/running/waiting_for_approval` to
  `indeterminate`;
- `/v1/capabilities` advertises
  `client_idempotency=true` and `event_replay=true`;
- clients without the new fields retain current behavior.
- authenticated
  `DELETE /v1/canvas/runs/{client_run_id}/commands/{idempotency_key}` requires
  exact owner/request fingerprints, rejects active/nonmatching Runs, deletes
  only the terminal Run's persisted event/output rows, and leaves a
  non-content fingerprint tombstone so an exact repeat returns
  `already_absent`;
- Canvas `POST /api/sessions` accepts deterministic `client_session_id`,
  `idempotency_key`, safe `owner_fingerprint`, `session_key_hash` and the
  canonical `transcript_seed`; `client_session_id` and Session key both include
  the `sessionGenerationKey`;
- the Gateway durably stores the Session create receipt before replying;
  same key plus same fingerprint returns the original Session, while a changed
  request returns 409;
- a read-only outcome endpoint returns only Session ID, outcome,
  request/owner fingerprints and key hash, never the raw Canvas Session key;
- the authenticated endpoint is exactly
  `GET /v1/canvas/sessions/{client_session_id}/commands/{idempotency_key}/outcome`
  and returns one strict JSON union:

  ```text
  {outcome:'applied', client_session_id, idempotency_key,
   external_session_id, owner_fingerprint, request_fingerprint,
   session_key_hash, session_generation_key, transcript_digest,
   transcript_version, message_count}
  | {outcome:'not_applied', client_session_id, idempotency_key}
  | {outcome:'indeterminate', client_session_id, idempotency_key,
     owner_fingerprint, request_fingerprint, session_key_hash,
     session_generation_key, transcript_digest, transcript_version,
     message_count}
  ```

  Unknown exact tuples return the strict `not_applied` shape. Unknown fields,
  raw Session keys, prompts, profile paths and provider payloads are rejected
  by response-contract tests. The Worker performs the explicit snake_case
  wire-to-contract mapping; it accepts `applied` only when every
  expected fingerprint, generation and transcript field matches its prepared
  command; otherwise it returns a safe protocol/ownership failure and never
  adopts the Session;
- after a lost create response, the Worker adopts the deterministic Session
  only when this receipt proves the expected owner, request fingerprint and
  key hash plus generation; a bare 409, matching Canvas Session prefix or older
  generation is insufficient.
- seed import and Session receipt are atomic: a crash cannot leave an applied
  receipt with partial messages; immediate message load matches the requested
  transcript digest;
- ACP `new_session` accepts `_meta.hermes.sessionKey` and the strict canonical
  `_meta.hermes.transcriptSeed`, validates the `canvas:` namespace, imports the
  seed atomically, persists key plus seed digest in Session state, restores
  them on load, and passes the key to both `AIAgent` and `set_session_vars`;
- ACP load refuses prompt execution if the imported transcript digest differs
  from the seed receipt;
- loading an ACP Session under a different `sessionGenerationKey` returns
  ownership/generation mismatch and never adopts the older Session;
- two ACP Sessions use distinct Canvas keys even when they share one profile
  process;
- ACP requests without Canvas metadata retain current UUID/default behavior.

Run:

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  tests/gateway/test_api_server_canvas_runs.py
```

Expected: FAIL because the API run store, request fields and ACP Canvas key
state do not exist.

- [ ] **Step 3: Implement the edge-only durable store**

Use a separate SQLite database at:

```text
<HERMES_HOME>/api_runs.db
```

Do not change `run_agent.py` or the model tool schema. The API platform:

- stores `canvas_session_receipts` keyed by
  `(client_session_id, idempotency_key)` with canonical request fingerprint,
  owner fingerprint, session-generation key, session-key SHA-256, transcript
  digest/version/count, external Session ID and outcome;
- writes request fingerprint before scheduling the Agent;
- commits external Run ID before returning 202;
- persists every emitted event before pushing it to an SSE client;
- replays by external event ref;
- never reruns an existing client command;
- returns `indeterminate` after process loss;
- serves the exact authenticated Session-command outcome endpoint above from
  this store without scheduling an Agent or repeating a command;
- includes the reviewed 40-character Hermes worktree revision in the safe
  `/v1/capabilities` response so a live process can prove which source it
  loaded;
- prunes terminal records older than 30 days on bounded startup cleanup.
- performs the exact terminal Run cleanup above in one transaction and never
  accepts a prefix, Binding-wide or profile-wide delete.

For ACP, persist `gateway_session_key`, transcript seed digest/version/count
and the imported messages in the existing Session record/metadata, restore
them before creating the Agent, and verify the key/digest for every prompt.
Do not derive it from an ACP UUID and do not reuse a message-platform key.

- [ ] **Step 4: Run Hermes GREEN and commit**

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  tests/gateway/test_api_server_canvas_runs.py \
  tests/gateway/test_api_server.py \
  tests/gateway/test_api_server_bind_guard.py \
  tests/acp/test_server.py \
  tests/acp/test_session.py
git diff --check
git add \
  gateway/api_run_store.py \
  gateway/platforms/api_server.py \
  tests/gateway/test_api_server_canvas_runs.py \
  acp_adapter/server.py \
  acp_adapter/session.py \
  tests/acp/test_server.py \
  tests/acp/test_session.py
git commit -m "feat(runtime): persist Canvas run and session identity"
```

Expected: existing API/ACP clients stay compatible, new Canvas fields are
durable, and the worktree remains available for the Memory Policy subplan.

- [ ] **Step 5: Deploy the reviewed Hermes worktree into the running Jarvis**

The tracked drop-in template is:

```ini
[Service]
WorkingDirectory=/home/youran/.hermes/.worktrees/canvas-runtime-policy
Environment="PYTHONPATH=/home/youran/.hermes/.worktrees/canvas-runtime-policy"
```

Create this template in the Canvas implementation worktree at
`deploy/systemd/hermes-gateway-canvas-runtime-policy.conf` before copying it;
do not create it relative to the current Hermes worktree. Task 11 commits all
tracked deployment templates together.

Before installation, record the current Gateway unit, process command, health
and `MainPID` without printing any environment secret. Copy the template to:

`/home/youran/.config/systemd/user/hermes-gateway.service.d/canvas-runtime-policy.conf`

Then run:

```bash
OLD_MAIN_PID="$(systemctl --user show -p MainPID --value hermes-gateway.service)"
systemctl --user daemon-reload
systemctl --user restart hermes-gateway.service
systemctl --user is-active hermes-gateway.service
NEW_MAIN_PID="$(systemctl --user show -p MainPID --value hermes-gateway.service)"
test "$NEW_MAIN_PID" -gt 1
test "$NEW_MAIN_PID" != "$OLD_MAIN_PID"
test "$(
  readlink -f "/proc/$NEW_MAIN_PID/cwd"
)" = /home/youran/.hermes/.worktrees/canvas-runtime-policy
systemctl --user cat hermes-gateway.service
```

`systemctl cat` must show the installed drop-in, and
`systemctl show -p FragmentPath,DropInPaths,ExecMainStartTimestampMonotonic`
must prove that the new process started after installation. Probe `/health`
and authenticated `/v1/capabilities` through the live `NEW_MAIN_PID`; require
the new durable idempotency, event replay and Canvas Session receipt capability
markers plus the exact reviewed Hermes commit SHA. The capability revision,
MainPID cwd and installed drop-in checksum are the deployment evidence; an
unrelated `PYTHONPATH ... python -c 'import ...'` shell is explicitly not
evidence. Also verify the existing Discord/Gateway transport remains healthy.

- [ ] **Step 6: Prove rollback before continuing**

Rollback is: move the drop-in to a timestamped backup outside the active
`.service.d` directory, `daemon-reload`, restart the Gateway, verify its prior
module path and health, then restore the drop-in and repeat the capability
probe. Record both transitions. Do not merge into or modify the dirty Hermes
main checkout. Later deployment always names the reviewed Hermes commit and
drop-in checksum.

---

### Task 10: Wire the production Composition Root and fail-closed write gate

**Files:**

- Create: `packages/control-plane/src/runtime-write-gate.ts`
- Create: `packages/control-plane/src/runtime-write-gate.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `apps/web/src/server/control-plane.ts`
- Modify: `apps/web/src/server/control-plane.test.ts`
- Create: `scripts/set-deployment-gates.sh`
- Create: `scripts/set-deployment-gates.test.sh`
- Modify: `compose.yaml`
- Modify: `.env.example`

- [ ] **Step 1: Write RED flag, factory and side-effect tests**

Production parses all four flags as exactly `0|1`; a missing, duplicate or
invalid value fails startup. Tests pass an explicit typed config and never
inherit these values from the developer shell.
The only valid production tuples are `0,0,0,0` and
`1,{0|1},{0|1},0` in real-runtime, memory, Runs, Fake order. In particular,
memory or Runs cannot be enabled while the real registry is disabled.

Cover this matrix:

| Environment | Exact flags | Result |
| --- | --- | --- |
| test | injected test config | Fake only when the test injects it |
| development | explicit Fake `1` | Fake |
| production | real `1`, memory `0|1`, Runs `0|1`, Fake `0` | Hermes Gateway + Hermes ACP |
| production | real `0`, memory `0`, Runs `0`, Fake `0` | empty registry; reads work |
| production | Fake `1` or any missing/invalid flag | initialization error |

Also assert `SessionService` and `RunEventPump` receive the registry instance,
not an individual Adapter. With `CANVAS_REAL_RUNS_ENABLED=0`, prove
`SessionService` rejects root Session creation and Run/message creation with
safe `503 real_runs_disabled` before the first Repository write, receipt or
Runtime call. Persisted Session/transcript/event reads still work. The same
gate is a required constructor dependency for later Agent switch and
policy/context rotation orchestration; routes may not create their own
divergent gate.

Run:

```bash
docker run --rm ai-super-canvas:acp-adapter \
  vitest run \
  packages/control-plane/src/runtime-write-gate.test.ts \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/server/control-plane.test.ts
```

Expected: FAIL because the factory always returns `DeterministicFakeRuntime`
and no service-boundary write gate exists.

- [ ] **Step 2: Implement one strict parser, Runtime factory and write gate**

Use:

```ts
export interface RuntimeEnvironment {
  NODE_ENV?: string;
  CANVAS_REAL_RUNTIME_ENABLED?: string;
  CANVAS_MEMORY_POLICY_ENABLED?: string;
  CANVAS_REAL_RUNS_ENABLED?: string;
  CANVAS_FAKE_RUNTIME_ENABLED?: string;
  CANVAS_RUNTIME_SOCKET?: string;
}
```

Production behavior:

- real flag `1`: register `HermesGatewayRuntimeAdapter` and
  `HermesProfileAcpRuntimeAdapter`;
- explicit real flag `0`: registry is empty and all new Runtime calls fail
  `binding_not_found/not-applied`;
- Fake flag `1`: throw at startup.
- `RuntimeWriteGate.assertEnabled()` runs inside `SessionService` before every
  currently supported user-triggered Runtime mutation;
- memory flag `0` permits only the Foundation's `session_only` request shape;
  later memory-policy activation remains unsupported until its capability
  snapshot is atomically verified;
- all four parsed values appear only as safe booleans in health/readiness
  state; responses never expose environment names or raw values.

Do not catch a real Adapter error and retry Fake.
Remove legacy Web-side `OPENAI_API_KEY`, `OPENAI_MODEL`,
`AI_AVAILABLE_MODELS` and `AI_DEFAULT_MODEL` configuration. Production
composition/Compose tests prove none reaches the Web container; provider
credentials and model configuration remain only inside the existing Hermes
side.

- [ ] **Step 3: Add one atomic deployment-gate writer**

`scripts/set-deployment-gates.sh` takes all four values as required named
arguments and ignores same-named inherited environment variables. It validates
exactly `0|1`, takes an owner-only lock, and atomically replaces the single
shared file
`/home/youran/.config/ai-super-canvas/runtime-gates.env`. The file contains
exactly one line for each flag, is owned by the current user and mode `0600`;
duplicates, symlinks, wrong ownership/mode, partial input or extra keys fail
closed. It enforces the same valid-tuple rule as startup. Both Canvas and
Worker units read this same file last, so a caller never updates two
independent copies.

The helper and installer also require zero occurrences of the four gate keys
in `runtime-worker.env` and `ai-super-canvas.env`. A one-time explicit
`--migrate-legacy-env` mode may remove only those exact keys after proving
their values match the requested tuple; it atomically preserves all other
lines, owner and `0600` mode without printing them. Conflicting, duplicate or
unparseable legacy values fail closed instead of being silently overridden.

The helper does not restart a service. Every deployment phase must run it
before any restart, then verify the resolved environment and `/api/ready`
against the requested four-value tuple. Test first install, atomic replacement,
concurrent writers, invalid values, an interrupted temp write, wrong
owner/mode, illegal cross-flag tuples, legacy migration and preservation of the
last valid file.

- [ ] **Step 4: Run GREEN and commit**

```bash
docker build --target test \
  --tag ai-super-canvas:real-composition .
docker run --rm ai-super-canvas:real-composition \
  vitest run \
  packages/control-plane/src/runtime-write-gate.test.ts \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/server/control-plane.test.ts
docker run --rm ai-super-canvas:real-composition test
bash scripts/set-deployment-gates.test.sh
git diff --check
git add packages/control-plane apps/web/src/server scripts compose.yaml .env.example
git commit -m "feat(web): gate real Runtime without fallback"
```

Expected: production cannot construct Fake, the disabled gate produces no
Canvas or Runtime mutation, and a deployment has one auditable source of truth
for all four gates.

---

### Task 11: Install the Unix Socket Worker boundary

**Files:**

- Create: `deploy/systemd/ai-super-canvas-runtime-worker.service`
- Create: `deploy/systemd/ai-super-canvas.service`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Modify: `Dockerfile`
- Create: `scripts/check-runtime-worker.py`
- Modify: `apps/web/src/app/api/health/route.ts`
- Create: `apps/web/src/app/api/health/route.test.ts`
- Modify: `apps/web/src/app/api/ready/handler.ts`
- Modify: `apps/web/src/app/api/ready/handler.test.ts`

- [ ] **Step 1: Write the service template**

The tracked unit must contain:

```ini
[Unit]
Description=AI Super Canvas Hermes Runtime Worker
After=network-online.target hermes-gateway.service hermes-personal-assistants.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/youran/.local/share/ai-super-canvas/current
RuntimeDirectory=ai-super-canvas-runtime
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
StateDirectory=ai-super-canvas-runtime-worker
StateDirectoryMode=0700
EnvironmentFile=/home/youran/.config/ai-super-canvas/runtime-worker.env
EnvironmentFile=/home/youran/.config/ai-super-canvas/runtime-gates.env
ExecStart=/home/youran/.hermes/hermes-agent/venv/bin/python -m services.hermes_runtime_worker.server
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

Write shell-fixture tests for `install-runtime-release.sh`: first install,
idempotent same-SHA install, atomic switch to a second SHA, refusal of dirty or
mismatched release directories, and preservation of the prior release. Its
optional `--worker-env <path>` mode requires an existing user-owned `0600`
file, atomically replaces exactly one `CANVAS_WORKER_REVISION=` line without
printing other values, and refuses zero/multiple matches. Its paired
`--canvas-env <path> --canvas-image <immutable-tag> --canvas-image-id
<sha256:...> --operator-image <immutable-tag> --operator-image-id
<sha256:...>` mode verifies both tags currently resolve to those exact IDs,
applies the same owner/mode/single-line rules to `CANVAS_IMAGE=` and
`CANVAS_OPERATOR_IMAGE=`, and writes both expected IDs into the immutable
per-release manifest. A later verification compares the running container ID
and any one-shot operator container with the manifest/explicit expected IDs,
rather than treating current tag targets as truth, so systemd or migration
cannot revert to or self-certify a floating/older image.

An explicit
`--install-units-dir /home/youran/.config/systemd/user` mode validates both
templates from the pinned release, their absolute release paths,
non-gate-before-gate `EnvironmentFile` order and fixed Compose project, then
atomically installs owner-owned mode-`0644` units while preserving a
checksum-named prior copy. It does not call `daemon-reload` or restart
anything; callers do so only after backup/migration verification. Fixture
tests cover partial-install interruption and restoration of both prior units.

The protected environment file contains logical paths only; it is mode `0600`
and never committed. The Worker reads exactly `API_SERVER_KEY` from the
existing mode-`0600` `/home/youran/.hermes/.env`; it must not copy the key to
another env file. It also contains the non-secret
`CANVAS_WORKER_REVISION=<40-char pinned sha>`. At startup the Worker resolves
the `current` symlink, verifies that checkout is detached, clean and exactly at
that SHA, and exposes the SHA through its safe UDS health response; mismatch
fails startup.

The Worker independently parses the same four flags as exact `0|1`: real
Runtime `0` rejects dispatch, real Runs `0` rejects every mutating Runtime
operation, memory policy `0` rejects any non-`session_only` policy, and Fake
must always be `0`. Add protocol tests proving rejection happens before the
ledger records an attempted external side effect. Worker health returns only
the four safe booleans and revision.

- [ ] **Step 2: Mount only the Runtime directory into Web**

Add to the `app` service:

```yaml
    image: "${CANVAS_IMAGE:?CANVAS_IMAGE must be an immutable SHA tag}"
    group_add:
      - "${CANVAS_RUNTIME_GID:?set CANVAS_RUNTIME_GID}"
    volumes:
      - "${CANVAS_RUNTIME_DIR:?set CANVAS_RUNTIME_DIR}:/run/canvas-runtime"
    environment:
      CANVAS_RUNTIME_SOCKET: /run/canvas-runtime/runtime-worker.sock
      CANVAS_REAL_RUNTIME_ENABLED: "${CANVAS_REAL_RUNTIME_ENABLED:?set in runtime-gates.env}"
      CANVAS_MEMORY_POLICY_ENABLED: "${CANVAS_MEMORY_POLICY_ENABLED:?set in runtime-gates.env}"
      CANVAS_REAL_RUNS_ENABLED: "${CANVAS_REAL_RUNS_ENABLED:?set in runtime-gates.env}"
      CANVAS_FAKE_RUNTIME_ENABLED: "${CANVAS_FAKE_RUNTIME_ENABLED:?set in runtime-gates.env}"
```

Remove the production `build:` fallback. Local/test image builds remain
explicit commands, while every systemd-managed Compose start must receive an
immutable `CANVAS_IMAGE` through the protected env file. This boundary is
established here because the Memory subplan performs an intermediate pinned
deployment before the final Product subplan.

Add a separate immutable `operator` Docker target and a Compose
profile-only `operator` service using
`${CANVAS_OPERATOR_IMAGE:?set immutable operator image}`. It contains only the
database migration/verification CLI, migrations and their exact runtime
dependencies; it exposes no TCP port and is never part of normal `compose up`.
Copy the PostgreSQL 18 `pg_dump`/`pg_restore` binaries and required libraries
from a digest-pinned `postgres:18-bookworm` stage, then assert client and server
major are both 18 before backup or restore validation. The production Web
final stage explicitly excludes database operator, account-session admin and
acceptance-operator sources.

`scripts/run-database-operation.sh` requires the pinned Compose file,
project name, release SHA, operator tag and independently captured image ID. It
verifies the image label/ID, exact Compose project/network/database container
labels, then runs the operator container on that private Compose network.
PostgreSQL is never published to the host. For
acceptance overlays, an owner-only host directory may be bind-mounted solely
for a `0600` Unix Socket or backup file.

Use an explicit database bootstrap state machine:

1. a fresh nonce database must match the exact project/container labels and
   nonce database name and have no application migration journal or seed
   receipt; only `migrate` is allowed;
2. after migration, `seed` atomically creates the random
   `databaseInstanceId` receipt; the runner may atomically record this
   non-secret UUID in an explicitly named owner-only `0600` state file, and
   later phases must pass that independent value back;
3. from that point, every pair/record/cleanup/backup/migrate/verify operation
   requires the caller's exact receipt and rechecks it in the same operation;
4. an existing persistent database requires its current receipt before
   backup/migration. A one-time legacy bootstrap is a separate explicit,
   audited operation performed only after backup and exact database-name/
   schema-owner validation; it cannot accept a caller-selected instance ID.

Every persistent upgrade uses an owner-only `0600` durable migration manifest
containing project/database container identity, database name/instance ID when
available, from/to heads, release/operator image IDs, backup path/checksum and
phase (`planned|backed_up|migrated|seeded|verified|sealed`). The runner resumes
only the next legal phase: for the legacy `0008 -> 0011` path, an already
migrated `0011` database without a receipt may continue to seed only when the
same unsealed manifest and validated backup remain; an existing receipt moves
to verify. Unknown head/phase/resource combinations fail closed. The
`0011 -> 0012` path uses the same mechanism. Never repeat a legacy-only backup
command blindly after a partial migration.

The operator supports:

- `ensure-database-only`: during an explicit maintenance window, prove the Web
  container/listener is absent and start/health-check only PostgreSQL on the
  exact private Compose project/network;
- `backup`: write a custom-format `pg_dump` to an owner-only `0700` backup
  directory, chmod it `0600`, and validate it with `pg_restore --list`;
- `migrate --expected-head <id>`: apply only the pinned release's migrations
  with the repository journal/transaction rules;
- `verify --expected-head <id>`: assert migration head, journal integrity,
  safe database instance ID/name and seed receipt without printing data or
  credentials;
- `seal-migration`: only after the new pinned Web/Worker deployment and
  readiness/provenance checks pass, atomically mark the matching durable
  manifest `sealed`; it never deletes the validated backup.

Tests prove no host DB listener, wrong project/container/image/revision
rejection, backup validation, migration idempotency and failure preservation.

Do not mount `/home/youran/.hermes`,
`/home/youran/hermes-personal-assistants` or any `.env`.
Also remove the four legacy OpenAI/model keys from `compose.yaml`,
`.env.example` and the protected Canvas env. The installer fails if they remain
in that file, and deployment checks inspect only these forbidden names to
prove they are absent without printing unrelated environment values.

The tracked Canvas unit is complete and release-pinned:

```ini
[Unit]
Description=AI Super Canvas
After=ai-super-canvas-runtime-worker.service
Wants=ai-super-canvas-runtime-worker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/youran/.local/share/ai-super-canvas/current
EnvironmentFile=/home/youran/.config/ai-super-canvas/ai-super-canvas.env
EnvironmentFile=/home/youran/.config/ai-super-canvas/runtime-gates.env
ExecStart=/usr/bin/docker compose --project-name ai-super-canvas -f /home/youran/.local/share/ai-super-canvas/current/compose.yaml up -d --no-build
ExecStop=/usr/bin/docker compose --project-name ai-super-canvas -f /home/youran/.local/share/ai-super-canvas/current/compose.yaml down

[Install]
WantedBy=default.target
```

No command may resolve `compose.yaml` from the mutable development checkout.
The verifier checks the unit's `WorkingDirectory`, `ExecStart`, `ExecStop`,
fixed project name and absolute Compose path, resolves `current` to the exact
release SHA, and proves the running container was created from that file's
resolved config and immutable image ID.

The preserved Runtime directory is created with the intended owner before
Docker bind-mounts it; Docker must never create the host directory itself.
`Wants=` deliberately avoids stopping Canvas when the Worker stops: `/` and
persisted history must remain readable while Runtime actions report offline.
Add an integration check that stops only the Worker, proves Canvas stays
active and `/` returns 200, then restarts the Worker and proves the same Web
process reconnects to the recreated Socket.

- [ ] **Step 3: Add revision proof**

`Dockerfile` sets build arg `APP_REVISION`; only the production final stage
requires and validates exact 40-character lowercase hex, while the reusable
test target remains buildable without it and route tests inject the value.
`/api/health` returns the production value. Add a health route test. Extend
`/api/ready` and its tests to report both
PostgreSQL and the Worker Socket; a missing Worker returns 503 without exposing
the socket path.
The local deploy later must first lock a clean, fully tested `RELEASE_SHA`, and
then prove:

```text
RELEASE_SHA == image label org.opencontainers.image.revision == /api/health revision
```

An evidence-only documentation commit may be a descendant of `RELEASE_SHA`.
Before acceptance, `git diff --quiet "$RELEASE_SHA"..HEAD -- apps packages
services deploy Dockerfile compose.yaml package.json pnpm-lock.yaml` must pass;
otherwise rebuild and redeploy from a new `RELEASE_SHA`.

- [ ] **Step 4: Run packaging tests and commit**

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests
bash scripts/install-runtime-release.test.sh
bash scripts/run-database-operation.test.sh
POSTGRES_PASSWORD=config-test-only \
CANVAS_RUNTIME_GID=1000 \
CANVAS_RUNTIME_DIR=/run/user/1000/ai-super-canvas-runtime \
CANVAS_IMAGE=ai-super-canvas:config-test-0000000000000000000000000000000000000000 \
CANVAS_OPERATOR_IMAGE=ai-super-canvas:operator-config-test-0000000000000000000000000000000000000000 \
CANVAS_REAL_RUNTIME_ENABLED=1 \
CANVAS_MEMORY_POLICY_ENABLED=0 \
CANVAS_REAL_RUNS_ENABLED=0 \
CANVAS_FAKE_RUNTIME_ENABLED=0 \
  docker compose config --quiet
docker build --target test \
  --tag ai-super-canvas:runtime-worker-final .
docker run --rm ai-super-canvas:runtime-worker-final test
docker build --target operator \
  --build-arg APP_REVISION=0000000000000000000000000000000000000000 \
  --tag ai-super-canvas:runtime-operator-final .
docker run --rm ai-super-canvas:runtime-operator-final \
  node --experimental-strip-types scripts/database-operator.ts --help
git diff --check
git add deploy Dockerfile compose.yaml .env.example scripts \
  services packages apps/web/src/server apps/web/src/app/api/health \
  apps/web/src/app/api/ready
git commit -m "build: add the host Hermes Runtime worker"
```

Expected: Compose validates, Web image contains no Hermes home/key, and Worker
adds no TCP port. Inspect the resolved Compose output and assert the four gate
values are exactly `1,0,0,0`, rather than accepting values inherited from a
developer shell.

---

### Task 12: Live preflight without product enablement

- [ ] **Step 1: Install the unit and protected config**

From the Canvas implementation worktree require a clean committed state, then
install a detached, immutable runtime release:

```bash
test -z "$(git status --short)"
RUNTIME_WORKER_SHA="$(git rev-parse HEAD)"
bash scripts/install-runtime-release.sh \
  --sha "$RUNTIME_WORKER_SHA" \
  --release-root /home/youran/.local/share/ai-super-canvas
test "$(git -C /home/youran/.local/share/ai-super-canvas/current rev-parse HEAD)" \
  = "$RUNTIME_WORKER_SHA"
```

The script creates or verifies
`/home/youran/.local/share/ai-super-canvas/releases/$RUNTIME_WORKER_SHA` as a
detached Git worktree, then atomically repoints only the `current` symlink. It
refuses a dirty/mismatched existing release and never deletes another release.

Copy the tracked unit to:

`/home/youran/.config/systemd/user/ai-super-canvas-runtime-worker.service`

Do not overwrite or restart the currently active Canvas unit during this
preflight. Run `systemd-analyze --user verify` against both pinned tracked
templates and inspect the Canvas template's absolute release paths
statically; the Memory phase installs that unit only after its persistent
backup and migration succeed.

Create `/home/youran/.config/ai-super-canvas/runtime-worker.env` mode `0600`
with:

```text
CANVAS_RUNTIME_SOCKET=/run/user/1000/ai-super-canvas-runtime/runtime-worker.sock
CANVAS_RUNTIME_STATE_DIR=/home/youran/.local/state/ai-super-canvas-runtime-worker
CANVAS_JARVIS_ENDPOINT=http://127.0.0.1:8642
CANVAS_JARVIS_SECRET_FILE=/home/youran/.hermes/.env
CANVAS_JARVIS_SECRET_KEY=API_SERVER_KEY
CANVAS_HERMES_PYTHON=/home/youran/.hermes/hermes-agent/venv/bin/python
CANVAS_HERMES_SOURCE=/home/youran/.hermes/.worktrees/canvas-runtime-policy
CANVAS_PERSONAL_HERMES_ROOT=/home/youran/hermes-personal-assistants
CANVAS_ALLOWED_PROFILES=zzh,nsy
CANVAS_ALLOWED_EXTERNAL_AGENTS=jarvis-local,zzh,nsy
CANVAS_WORKER_REVISION=<RUNTIME_WORKER_SHA>
```

Do not copy or print the key. Before start, verify the source file is owned by
the user, has no group/other read bit, contains exactly one
`API_SERVER_KEY=...` entry, and that the Worker parser reads only that key.

Create the shared gate file only through:

```bash
bash scripts/set-deployment-gates.sh \
  --real-runtime 1 \
  --memory-policy 0 \
  --real-runs 0 \
  --fake-runtime 0
```

Verify the installed Worker unit and both pinned templates reference the same
owner-only `0600` file, with their non-gate environment file first and the gate
file last. Only the Worker is started in this phase.

- [ ] **Step 2: Start Worker and verify no TCP listener**

```bash
systemctl --user daemon-reload
systemctl --user enable --now ai-super-canvas-runtime-worker.service
systemctl --user is-active ai-super-canvas-runtime-worker.service
systemctl --user show ai-super-canvas-runtime-worker.service \
  -p EnvironmentFiles --value | \
  rg '/home/youran/.config/ai-super-canvas/runtime-gates.env'
WORKER_MAIN_PID="$(
  systemctl --user show ai-super-canvas-runtime-worker.service \
    -p MainPID --value
)"
tr '\0' '\n' <"/proc/$WORKER_MAIN_PID/environ" | \
  rg '^(CANVAS_REAL_RUNTIME_ENABLED|CANVAS_MEMORY_POLICY_ENABLED|CANVAS_REAL_RUNS_ENABLED|CANVAS_FAKE_RUNTIME_ENABLED)=' | \
  sort | diff - <(printf '%s\n' \
    CANVAS_FAKE_RUNTIME_ENABLED=0 \
    CANVAS_MEMORY_POLICY_ENABLED=0 \
    CANVAS_REAL_RUNS_ENABLED=0 \
    CANVAS_REAL_RUNTIME_ENABLED=1)
test -S /run/user/1000/ai-super-canvas-runtime/runtime-worker.sock
/home/youran/.hermes/hermes-agent/venv/bin/python \
  scripts/check-runtime-worker.py \
  --socket /run/user/1000/ai-super-canvas-runtime/runtime-worker.sock \
  --health \
  --expect-revision "$RUNTIME_WORKER_SHA"
stat -c '%a %u %g %n' \
  /run/user/1000/ai-super-canvas-runtime \
  /run/user/1000/ai-super-canvas-runtime/runtime-worker.sock \
  /home/youran/.local/state/ai-super-canvas-runtime-worker
ss -ltnp
```

Expected: service active, Socket exists, TCP listener list gains no Worker port.
Only the four safe names are read from `/proc`; no other environment value is
printed. Once Web is deployed, the deployment verifier performs the analogous
four-name-only `docker inspect` check and cross-checks both processes against
`/api/ready`.

- [ ] **Step 3: Probe all three Runtime targets through the Socket**

```bash
/home/youran/.hermes/hermes-agent/venv/bin/python \
  scripts/check-runtime-worker.py \
  --socket /run/user/1000/ai-super-canvas-runtime/runtime-worker.sock \
  --binding jarvis
/home/youran/.hermes/hermes-agent/venv/bin/python \
  scripts/check-runtime-worker.py \
  --socket /run/user/1000/ai-super-canvas-runtime/runtime-worker.sock \
  --binding yutu
/home/youran/.hermes/hermes-agent/venv/bin/python \
  scripts/check-runtime-worker.py \
  --socket /run/user/1000/ai-super-canvas-runtime/runtime-worker.sock \
  --binding jingjing
```

Expected: safe descriptor/health only; no key, profile path or external Session
ref in stdout.

- [ ] **Step 4: Prove coexistence with the existing multiplex service**

Keep `hermes-personal-assistants.service` running. Record its MainPID and safe
profile DB/file hashes, then issue only Worker descriptor/health/ACP initialize
and read-only Session-list probes for zzh and nsy while the multiplex service
performs its normal health probe. Assert no profile row/file/hash changes, no
SQLite lock error, no profile crossover and no service/PID replacement.

Do not create a synthetic Session or Run in this preflight:
`CANVAS_REAL_RUNS_ENABLED=0` must reject those mutations, and there is no
acceptance cleanup manifest here. Real Session coexistence is proved later by
the Identity and Memory disposable wrappers, where every external ref is
pre-registered and cleaned exactly.

- [ ] **Step 5: Record the stage gate**

Real routing is enabled only inside the Worker for the read-only probes above;
memory and Run writes remain closed, and this phase does not install or switch
the active Canvas unit. Record:

- Worker service status;
- Socket owner/mode;
- Jarvis/zzh/nsy health;
- no new TCP listener;
- Hermes patch commit;
- untested memory capability remains unsupported.

This stage is infrastructure-ready, not product-ready.

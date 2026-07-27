# Agent Memory Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每次 Run 的记忆读取和写入范围由用户明确选择、服务端严格授权，并证明 Jarvis、于途、乔晶晶之间以及不同项目之间不会串记忆或 Session。

**Architecture:** `SessionConfigRevision.contextPolicy` 保存用户意图；`ContextPolicyService` 在 Run 准备事务内从可信 Session/Binding 推导 Agent，授权并解析 Agent × Workflow ContextRef 和获选历史 Session，生成规范化 digest 与不可变 Run 快照；Runtime 请求携带只读 policy 和上下文 bundle；Hermes 用请求级 policy 控制原生记忆读取并把写入拦截为 Canvas proposal，批准后只生成 Canvas ContextRef，不直接改写 profile memory 文件。

**Tech Stack:** TypeScript 6.0.3、Node.js 24.18.0、PostgreSQL 18、Drizzle ORM 0.45.2、Zod、Vitest 4.1.10、Python 3、Hermes `agent`/Gateway/ACP、pytest。

---

## Global constraints

- 在 Device Identity and Agent Access 的 migration `0010` 和全部门禁通过后执行。
- 本计划使用 migration `0011_agent_memory_policy`。
- 隔离主键来自服务端已授权的 Session → AgentBinding → Agent，浏览器不能提交或覆盖 Agent ID、Binding、Runtime ref、ContextRef ID 或 digest。
- 三种模式的稳定 API 值是：
  `session_only`、`agent_project`、`agent_global`。
- 新 Session 默认 `agent_project`；写入策略首版固定为 `confirm_each`。
- `agent_global` 只允许 Agent owner、该 Agent 的有效 `admin` grant，不能仅凭平台管理员角色越权。
- `session_only` 和 `agent_project` 禁止 Hermes 原生长期记忆、用户画像、外部 memory provider 和任意 `session_search`。
- `agent_global` 可读当前 profile 的原生长期记忆，但仍不能静默写入原生 memory；所有新写入都先进入 Canvas proposal。
- Canvas 不复制 `.env`、SOUL、`MEMORY.md`、`USER.md` 或原生 memory provider 数据。
- 不支持请求级控制时 Adapter 必须声明 `perRunMemoryPolicy='unsupported'`，产品界面不得启用该模式。
- `perRunMemoryPolicy='adapter'` 时 Binding capability snapshot 必须同时
  保存完整版本化验证对象；任一版本/SHA 缺失或不匹配都等同 unsupported，
  不能只存布尔值或字符串就宣称可用。
- 每个 Run 的 policy、选中 Session、ContextRef 和 digest 一旦落库不得变化。
- 策略收窄不会篡改当前 Canvas Session 已可见的历史消息；如果旧回复已经
  明文包含某个 marker，它仍属于 `session_only` 的当前对话内容。负向隔离
  验收必须使用从未进入当前 transcript 的隐藏 marker。

## Canonical policy and Runtime contract

```ts
export const ContextPolicySchema = z.object({
  version: z.literal(1),
  mode: z.enum(['session_only', 'agent_project', 'agent_global']),
  selectedSessionIds: z.array(z.uuid()).max(20),
  writePolicy: z.literal('confirm_each'),
}).strict();

export interface RuntimeMemoryPolicy {
  version: 1;
  mode: 'session_only' | 'agent_project' | 'agent_global';
  readNativeMemory: boolean;
  readUserProfile: boolean;
  readExternalMemory: boolean;
  allowSessionSearch: false;
  writeMode: 'disabled' | 'proposal_only';
  policyDigest: string;
  contextDigest: string;
}

export interface VerifiedMemoryPolicyCapability {
  policyVersion: 1;
  hermesSourceRevision: string;
  verifiedCanvasRelease: string;
  modes: Array<'session_only' | 'agent_project' | 'agent_global'>;
  verifiedAt: string;
}
```

`RuntimeTranscriptSeed` is the bounded canonical sequence of persisted Canvas
user/assistant text plus safe tool-result summaries already visible in the
product; it contains no Runtime ref, raw tool payload or hidden native memory.

Canonicalization rules:

- `selectedSessionIds` 去重后按 UUID 字典序排序；
- `session_only` 强制为空；
- policy JSON 使用已有 canonical JSON helper；
- context bundle 按 `scope → createdAt → ContextRef ID` 排序；
- 总序列化内容上限 64 KiB，单个历史 Session 上限 16 KiB；
- 超限返回 `context_too_large` 并要求用户减少选择，不静默遗漏；
- `policyDigest = SHA-256(canonicalJson({version, agentId, workflowId, mode,
  selectedSessionIds, writePolicy, derivedReadWriteFlags}))`；
- `contextDigest = SHA-256(canonicalJson({policyDigest,
  contextRefs:[{id,scope,contentDigest}], selectedSessions:
  [{sessionId,transcriptVersion,transcriptDigest}]}))`；
- 两个 digest 都是小写 64 字符 hex，不能把 `contextDigest` 反向包含进
  `policyDigest` 或形成循环。

## File map

### Database and immutable snapshot

- Modify: `packages/db/src/schema/enums.ts`
- Modify: `packages/db/src/schema/authorization.ts`
- Modify: `packages/db/src/schema/workflows.ts`
- Create: `packages/db/src/schema/memory.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/schema/schema-constraints.integration.test.ts`
- Create: `packages/db/src/migrations/migration-upgrade.integration.test.ts`
- Modify: `packages/db/src/testing/disposable-test-database.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Create: `packages/db/migrations/0011_agent_memory_policy.sql`
- Create: `packages/db/migrations/meta/0011_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

### Policy service and runtime projection

- Create: `packages/control-plane/src/context-policy-types.ts`
- Create: `packages/control-plane/src/context-policy-service.ts`
- Create: `packages/control-plane/src/context-policy-service.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/run-event-pump.ts`
- Modify: `packages/control-plane/src/run-event-pump.test.ts`
- Modify: `packages/control-plane/src/runtime-event-mapper.ts`
- Modify: `packages/control-plane/src/runtime-event-mapper.test.ts`
- Modify: `packages/control-plane/src/dto.ts`
- Modify: `packages/control-plane/src/index.ts`
- Modify: `packages/ai/src/runtime/contract.ts`
- Modify: `packages/ai/src/runtime/contract-suite.ts`
- Modify: `packages/ai/src/runtime/deterministic-fake.ts`
- Modify: `packages/ai/src/runtime/hermes-gateway.ts`
- Modify: `packages/ai/src/runtime/hermes-gateway.test.ts`
- Modify: `packages/ai/src/runtime/hermes-acp.ts`
- Modify: `packages/ai/src/runtime/hermes-acp.test.ts`
- Modify: `packages/ai/src/runtime/worker-protocol.ts`

### Product APIs

- Create:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/context-policy/route.ts`
- Create:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/context-policy/route-contract.test.ts`
- Create:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/context-options/route.ts`
- Create:
  `apps/web/src/app/api/control-plane/memory-proposals/[proposalId]/decision/route.ts`
- Create:
  `apps/web/src/app/api/control-plane/memory-proposals/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`

### Hermes request policy in isolated worktree

- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/request_memory_policy.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/agent_init.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/turn_context.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/turn_finalizer.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/tool_executor.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/agent_runtime_helpers.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tools/memory_tool.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tools/write_approval.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/gateway/platforms/api_server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/acp_adapter/server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/acp_adapter/session.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/agent/test_request_memory_policy.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/gateway/test_api_server_canvas_memory.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/acp/test_canvas_session_policy.py`
- Create: `packages/control-plane/src/runtime-capability-activator.ts`
- Create: `packages/control-plane/src/runtime-capability-activator.test.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `services/hermes_runtime_worker/server.py`
- Modify: `services/hermes_runtime_worker/tests/test_protocol.py`
- Modify: `apps/web/src/server/control-plane.ts`
- Modify: `apps/web/src/server/control-plane.test.ts`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Create: `scripts/activate-agent-memory-policy.ts`
- Modify: `package.json`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/tools/test_write_approval.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/tools/test_memory_policy_boundary.py`

---

### Task 1: Add the explicit Agent × Workflow scope and memory proposal table

**Files:**

- Modify: `packages/db/src/schema/enums.ts`
- Modify: `packages/db/src/schema/authorization.ts`
- Modify: `packages/db/src/schema/workflows.ts`
- Create: `packages/db/src/schema/memory.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/schema/schema-constraints.integration.test.ts`
- Create: `packages/db/src/migrations/migration-upgrade.integration.test.ts`
- Modify: `packages/db/src/testing/disposable-test-database.ts`
- Create: `packages/db/migrations/0011_agent_memory_policy.sql`
- Create: `packages/db/migrations/meta/0011_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Write RED schema tests**

Add `agent_workflow` to `context_scope`. For that scope require:

```text
agent_id IS NOT NULL
workflow_id IS NOT NULL
session_id IS NULL
run_id IS NULL
```

Add an authorized loading index whose leading columns are
`agent_id, workflow_id, visibility, account_id, expires_at`.
Update `context_refs_workspace_visibility_scope_check` so workspace visibility
is allowed for `agent_workflow`, while `agent` remains private. Add
`agent_workflow` to every TypeScript scope allowlist/parser; no string cast may
bypass the enum.

Define `memory_write_proposals`:

```ts
{
  id,
  accountId,
  agentId,
  workflowId,
  sourceSessionId,
  sourceRunId,
  externalProposalRef,
  targetScope,       // agent_workflow | agent
  summary,
  content,
  contentHash,
  status,            // pending | approved | rejected
  decidedByAccountId,
  decidedAt,
  createdContextRefId,
  createdAt,
}
```

Constraints must prove:

- target scope is only `agent_workflow|agent`;
- pending has no decision fields or ContextRef;
- rejected has decision fields but no ContextRef;
- approved has decision fields and exactly one ContextRef;
- `(source_run_id, external_proposal_ref)` is unique;
- source Session/Run belong to the declared Workflow;
- content hash is lower 64-character SHA-256.

Extend `session_runtime_refs` with non-secret generation identity:

```ts
{
  configRevisionId,
  policyDigest,
  contextDigest,
  generationKey,
  isPrimary,
  supersededAt,
}
```

For new Canvas refs all digests are lowercase SHA-256, generation key is unique
per Binding, a primary ref cannot be superseded, and a partial unique index
allows only one primary ref per Canvas Session. Existing pre-migration refs are
historical/legacy and cannot be used for a memory-aware Run until rotated.

Run:

```bash
docker run --rm ai-super-canvas:identity-final \
  vitest run packages/db/src/schema/schema-contract.test.ts
```

Expected: FAIL because the scope/table are absent.

- [ ] **Step 2: Implement schema and generate migration**

```bash
corepack pnpm --filter @ai-super-canvas/db exec \
  drizzle-kit generate --name agent_memory_policy
```

Run this only under repository Node `>=24.18.0 <25`. Expected migration number
is `0011`; inspect SQL to ensure it adds the enum value, table, constraints and
index without dropping data.

Because the real migrator can apply every pending file in one PostgreSQL
transaction, no statement in `0011` may use the newly added enum value as an
enum literal before commit. Every CHECK, partial index or predicate introduced
in the same migration compares text, for example
`scope::text = 'agent_workflow'` and
`target_scope::text = 'agent_workflow'`. Add a SQL guard test that rejects an
uncast new enum literal.

Build the schema tag before any later command first references it:

```bash
docker build --target test --tag ai-super-canvas:memory-schema .
docker image inspect ai-super-canvas:memory-schema >/dev/null
```

- [ ] **Step 3: Run real constraints and commit**

`migration-upgrade.integration.test.ts` first applies exactly through `0008`
to a disposable database with representative Session/Context rows, then calls
the repository's real migrator once to reach `0011`. It must pass inside the
same transaction behavior used in production and preserve the existing rows;
an empty database final-schema test is not sufficient.

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-memory-schema \
  bash ./scripts/test-integration.sh
git diff --check
git add \
  packages/db/src/schema packages/db/src/testing packages/db/src/migrations \
  packages/db/migrations
git commit -m "feat(db): isolate memory by agent and workflow"
```

Expected: schema and disposable database tests pass.

---

### Task 2: Parse and canonicalize the three memory modes

**Files:**

- Create: `packages/control-plane/src/context-policy-types.ts`
- Create: `packages/control-plane/src/context-policy-service.ts`
- Create: `packages/control-plane/src/context-policy-service.test.ts`
- Modify: `packages/control-plane/src/index.ts`

- [ ] **Step 1: Write table-driven RED tests**

Test:

- missing policy normalizes to `agent_project`, empty selection,
  `confirm_each`;
- unknown version/mode/key is rejected;
- duplicate/out-of-order IDs become sorted unique IDs;
- `session_only` with any selected Session is rejected;
- more than 20 selected Sessions is rejected;
- canonical JSON and digest are identical for semantically identical inputs;
- `policyDigest` changes for mode, selection, derived flags or Agent/Workflow;
- `contextDigest` changes when `policyDigest`, transcript version/digest or
  ContextRef identity/content changes.

Run:

```bash
docker run --rm ai-super-canvas:memory-schema \
  vitest run packages/control-plane/src/context-policy-service.test.ts
```

Expected: FAIL because the service is absent.

- [ ] **Step 2: Implement pure policy primitives**

Keep Zod parsing, canonical ordering, hashing and 64 KiB size checks pure.
Return typed safe errors:

`invalid_context_policy`, `context_not_authorized`, `context_too_large`,
`memory_mode_not_allowed`.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:context-policy .
docker run --rm ai-super-canvas:context-policy \
  vitest run packages/control-plane/src/context-policy-service.test.ts
git diff --check
git add packages/control-plane
git commit -m "feat(memory): define canonical context policies"
```

Expected: focused tests pass.

---

### Task 3: Authorize context and selected Sessions from trusted server state

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/context-policy-service.ts`
- Modify: `packages/control-plane/src/context-policy-service.test.ts`

- [ ] **Step 1: Write RED authorization matrix**

For a current Session, derive Agent and Workflow from its locked database rows.
Test:

| Mode | Automatic ContextRefs | Allowed selected Sessions |
| --- | --- | --- |
| session_only | none | none |
| agent_project | same Agent + current Workflow | same Agent + current Workflow |
| agent_global | same Agent global + same Agent/current Workflow | same Agent, any authorized Workflow |

Also prove:

- another Agent in the same Workflow is rejected;
- same Agent in another Workflow is rejected by `agent_project`;
- Session from a Workspace the Account cannot access is rejected;
- a Session created by another Account is rejected even when both Accounts
  share the Workspace, Agent grant and Jarvis Binding; platform admin does not
  bypass this v1 creator-ownership rule;
- archived/deleted/disabled/revoked Session is not selectable;
- the current Session itself and any Session with an active/indeterminate Run
  are not selectable as historical context;
- grant revoked between config update and Run preparation causes the Run to
  fail before persistence/Runtime dispatch;
- ContextRef with mismatched scope columns or expired timestamp is excluded;
- owner/admin rule for `agent_global` is evaluated against the Agent, not just
  platform role.

Run:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-context-auth \
  bash ./scripts/test-integration.sh
```

Expected: FAIL because no authorized context loader exists.

- [ ] **Step 2: Implement locked, bounded context resolution**

Return only:

```ts
{
  canonicalPolicy;
  agentId;
  workflowId;
  contextRefs;
  selectedSessions: Array<{
    sessionId;
    transcriptVersion;
    transcriptDigest;
    messages;
  }>;
  contextDigest;
  runtimeMemoryPolicy;
}
```

Do not return Runtime refs. Enforce the 16 KiB/session, 64 KiB total limit
before `prepareRun()` writes anything. Every selected Session query includes
`created_by_account_id=actor.accountId`; authorization by Agent or Workspace
alone is insufficient.

- [ ] **Step 3: Run GREEN and commit**

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-context-auth \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db/src/repositories packages/control-plane
git commit -m "feat(memory): authorize agent scoped context"
```

Expected: the full authorization matrix passes.

---

### Task 4: Make policy changes new SessionConfigRevisions

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Create:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/context-policy/route.ts`
- Create:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/context-policy/route-contract.test.ts`
- Create:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/context-options/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`

- [ ] **Step 1: Write RED service and route tests**

Contract:

```text
GET /api/control-plane/sessions/:id/context-options
  -> current policy + authorized, same-Agent Session summaries

PUT /api/control-plane/sessions/:id/context-policy
  body {commandId, expectedVersion, mode, selectedSessionIds}
  -> new safe SessionConfigRevision summary
```

Tests prove:

- response options include title/project/update time but no Runtime ref;
- strict body rejects Agent ID, Binding, ContextRef, digest and write policy;
- stale `expectedVersion` conflicts without inserting a revision;
- policy update preserves model/tool config and increments version exactly once;
- idempotent command replay returns the original revision;
- switching to `session_only` clears selections;
- switching Agent is not an update-policy operation and is rejected here.

- [ ] **Step 2: Implement Repository revision compare-and-swap**

Parse and authorize policy before inserting. Persist canonical policy:

```json
{
  "version": 1,
  "mode": "agent_project",
  "selectedSessionIds": [],
  "writePolicy": "confirm_each"
}
```

The browser never supplies `writePolicy` in v1.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:memory-config .
docker run --rm ai-super-canvas:memory-config \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/app/api/control-plane/sessions/[sessionId]/context-policy/route-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-memory-config \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db packages/control-plane apps/web/src/app/api/control-plane
git commit -m "feat(api): configure session memory scope"
```

Expected: unit, route and integration tests pass.

---

### Task 5: Rotate Runtime Sessions on policy changes and freeze every Run

**Files:**

- Modify: `packages/ai/src/runtime/contract.ts`
- Modify: `packages/ai/src/runtime/contract-suite.ts`
- Modify: `packages/ai/src/runtime/deterministic-fake.ts`
- Modify: `packages/db/src/schema/workflows.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`

- [ ] **Step 1: Write RED immutable snapshot tests**

Add `perRunMemoryPolicy` to `RuntimeCapabilities` and add
`memoryPolicy: RuntimeMemoryPolicy` to `StartRuntimeRunInput`.
Extend `RuntimeContextItem.scope` with `agent_workflow`.
Extend `CreateRuntimeSessionInput` with:

```ts
{
  sessionGenerationKey: string;
  transcriptSeed: RuntimeTranscriptSeed;
  configRevisionId: string;
  policyDigest: string;
  contextDigest: string;
}
```

For `prepareRun()`, assert `context_policy_snapshot` contains:

```ts
{
  version: 1;
  mode;
  writePolicy: 'confirm_each';
  selectedSessionIds;
  contextRefIds;
  selectedSessionSnapshots: Array<{
    sessionId;
    transcriptVersion;
    transcriptDigest;
  }>;
  policyDigest;
  contextDigest;
  runtimeMemoryPolicy;
}
```

Tests update/revoke/delete source policy/context after Run preparation and prove
the stored Run snapshot does not change. A new Run must use the new revision.

Add Runtime Session generation tests:

- the active `session_runtime_refs` row records config revision, policy digest,
  context digest and generation key;
- if all four still match, the existing external Session is reused;
- any mode, selection, ContextRef content/digest or config revision change
  creates one deterministic generation key from
  `bindingId + canvasSessionId + configRevisionId + policyDigest +
  contextDigest`;
- Jarvis and ACP both use the resulting lower SHA-256 in the exact external
  key `canvas:<binding-id>:<canvas-session-id>:<session-generation-key>`;
  create/adopt receipts include it and reject every older generation;
- `agent_global -> session_only` and selected -> unselected each create a new
  external Runtime Session before the next Run;
- only the Canvas-persisted transcript is replayed into the new Session; no
  hidden native Runtime history, cached system prompt or old context bundle is
  restored;
- the old Runtime ref is marked historical, and exactly one active primary ref
  remains under a database lock;
- creation/attach uses a durable command receipt; response loss leaves
  confirming/reconciling rather than reusing the old ref;
- restart under the narrower generation still cannot retrieve a hidden
  global/unselected marker that never appeared in the persisted Canvas
  transcript.

- [ ] **Step 2: Resolve, rotate, and then prepare against one generation**

The browser still submits only Session ID, content and idempotency keys.
Repository first locks Session/config/grant and resolves the candidate context
without inserting the user Message. The service computes the generation key.
When it differs from the active Runtime ref, it creates a deterministic
`canvas:` external Session through the durable receipt path, seeds only the
persisted Canvas transcript, and atomically archives/attaches refs.

Repository then re-locks and re-resolves inside `prepareRun()`. If any revision
or digest changed during rotation it aborts before Message/Run persistence and
repeats with a new generation; otherwise it inserts the user Message, Run,
receipt and immutable snapshots atomically. `startRun` receives only that
matching active ref. It is forbidden to mutate an existing Runtime Session's
memory policy in place.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:memory-snapshot .
docker run --rm ai-super-canvas:memory-snapshot \
  vitest run \
  packages/ai/src/runtime/deterministic-fake.test.ts \
  packages/control-plane/src/session-service.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-memory-snapshot \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/ai packages/db packages/control-plane
git commit -m "feat(run): rotate and freeze authorized memory context"
```

Expected: snapshots remain byte-for-byte stable and narrower policy
generations cannot inherit hidden Runtime context.

---

### Task 6: Carry policy and bounded context through both real Adapters

**Files:**

- Modify: `packages/ai/src/runtime/worker-protocol.ts`
- Modify: `packages/ai/src/runtime/hermes-gateway.ts`
- Modify: `packages/ai/src/runtime/hermes-gateway.test.ts`
- Modify: `packages/ai/src/runtime/hermes-acp.ts`
- Modify: `packages/ai/src/runtime/hermes-acp.test.ts`
- Modify: `services/hermes_runtime_worker/protocol.py`
- Modify: `services/hermes_runtime_worker/jarvis.py`
- Modify: `services/hermes_runtime_worker/acp_client.py`
- Modify: `services/hermes_runtime_worker/tests/test_jarvis.py`
- Modify: `services/hermes_runtime_worker/tests/test_acp_client.py`

- [ ] **Step 1: Write protocol RED tests**

Assert Worker accepts only the canonical policy fields above and rejects extra
keys. Test exact mapping:

- Gateway `/v1/runs` receives `memory_policy` and `canvas_context`;
- a rotated Gateway `createSession` receives the canonical
  `RuntimeTranscriptSeed`, includes its digest/version/count in the durable
  Session receipt fingerprint, and loads back the same history digest before
  `startRun`;
- ACP `session/prompt` receives
  `_meta.hermes.memoryPolicy` and `_meta.hermes.canvasContext`;
- a rotated ACP `session/new` receives `_meta.hermes.transcriptSeed`, persists
  it before prompt, and `session/load` proves the same digest;
- `session_only` carries no ContextRef or selected transcript;
- context content is sent only to the Binding selected by Registry;
- logs include digest/byte count, never content;
- protocol plumbing exists while the Adapter still reports
  `perRunMemoryPolicy='unsupported'`; only Task 8 Step 5 can activate
  `'adapter'` after versioned live enforcement probes.

- [ ] **Step 2: Add an untrusted-data context envelope**

Render Canvas context as a structured, length-bounded block with an instruction
that it is reference data, not system authority. Include each item’s safe
Canvas ID, scope and provenance digest; never include filesystem paths or
Runtime refs.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:memory-adapters .
docker run --rm ai-super-canvas:memory-adapters \
  vitest run \
  packages/ai/src/runtime/hermes-gateway.test.ts \
  packages/ai/src/runtime/hermes-acp.test.ts
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  services/hermes_runtime_worker/tests/test_jarvis.py \
  services/hermes_runtime_worker/tests/test_acp_client.py
git diff --check
git add packages/ai services/hermes_runtime_worker
git commit -m "feat(runtime): carry per-run memory policy"
```

Expected: Node and Worker protocol tests pass.

---

### Task 7: Enforce request-scoped memory policy inside Hermes

**Files:**

- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/request_memory_policy.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/agent_init.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/turn_context.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/turn_finalizer.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/tool_executor.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/agent/agent_runtime_helpers.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tools/memory_tool.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tools/write_approval.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/agent/test_request_memory_policy.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/tools/test_write_approval.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/tools/test_memory_policy_boundary.py`

- [ ] **Step 1: Reuse and verify the isolated Hermes worktree**

Runtime Foundation Task 9 already created and committed the isolated worktree.
Do not edit the dirty main checkout and do not create a second branch:

```bash
git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy \
  status --short --branch
git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy \
  log -1 --oneline
```

Expected: branch is `codex/canvas-runtime-policy`, worktree is clean, the
Runtime Foundation ACP/session identity commit is present, and existing
uncommitted Hermes main-checkout files remain untouched.

- [ ] **Step 2: Write RED policy isolation tests**

Create an immutable `RequestMemoryPolicy` in a `contextvars.ContextVar`.
Test two concurrent turns with opposite policies and unique markers:

- `session_only`: no MEMORY/USER/provider prefetch, no memory nudge/review,
  `session_search` unavailable, memory write disabled;
- `agent_project`: same native-read restrictions, Canvas context visible,
  memory tool returns a structured proposal without touching disk;
- `agent_global`: native MEMORY/USER/provider read enabled, Canvas context
  visible, memory tool still proposal-only;
- Agent configuration flags are never mutated; call sites consult effective
  contextvar-driven predicates;
- tool schema filtering and execution guards both consult the same policy;
- an exception or cancellation also restores them;
- concurrent sessions cannot observe each other’s policy or Canvas context.
- `_cached_system_prompt` is never reused across different policy/context
  generation digests; restoring a persisted prompt with a mismatched digest
  fails closed and rebuilds from the narrower request policy;
- direct invocation of the final `tools/memory_tool.py` mutation handler under
  `disabled` or `proposal_only` never writes disk and never calls an external
  provider, even when higher-level executor guards are bypassed in the test;
- `agent_project` rejects a proposal whose requested target is `agent`;
  only an authorized `agent_global` request can propose that target.

Snapshot before/after hashes of profile `MEMORY.md` and `USER.md`.

- [ ] **Step 3: Implement one request-scoped context manager**

The context manager establishes immutable request state. Add helpers such as
`effective_memory_enabled(agent)` and
`effective_user_profile_enabled(agent)`, then make every relevant read/write
call site consult those helpers. Do not temporarily mutate a shared Agent
object. The policy must control:

- effective `_memory_enabled`;
- effective `_user_profile_enabled`;
- `_memory_manager` prefetch/sync;
- memory nudge/background review;
- `memory` write behavior;
- `session_search` in both advertised tools and execution guard;
- Canvas context injection.
- system-prompt cache identity and any persisted prompt restore.

Do not edit `config.yaml`. Do not mutate process environment per request.
`proposal_only` returns a structured proposal record and never calls
`MemoryStore` or external provider write hooks. Enforce this again inside
`tools/memory_tool.py`, the final mutation boundary, so registry/direct handler
calls cannot bypass the policy.

- [ ] **Step 4: Run GREEN and commit in Hermes**

```bash
cd /home/youran/.hermes/.worktrees/canvas-runtime-policy
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  tests/agent/test_request_memory_policy.py \
  tests/tools/test_write_approval.py \
  tests/tools/test_memory_policy_boundary.py
git diff --check
git add agent tools tests/agent tests/tools
git commit -m "feat(memory): enforce request scoped policy"
```

Expected: focused Hermes tests pass and the original profile files are
byte-for-byte unchanged.

---

### Task 8: Wire the Hermes policy through Gateway and ACP

**Files:**

- Create: `packages/control-plane/src/runtime-capability-activator.ts`
- Create: `packages/control-plane/src/runtime-capability-activator.test.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `services/hermes_runtime_worker/server.py`
- Modify: `services/hermes_runtime_worker/tests/test_protocol.py`
- Modify: `apps/web/src/server/control-plane.ts`
- Modify: `apps/web/src/server/control-plane.test.ts`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Create: `scripts/activate-agent-memory-policy.ts`
- Modify: `package.json`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/gateway/platforms/api_server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/acp_adapter/server.py`
- Modify:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/acp_adapter/session.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/gateway/test_api_server_canvas_memory.py`
- Create:
  `/home/youran/.hermes/.worktrees/canvas-runtime-policy/tests/acp/test_canvas_session_policy.py`

- [ ] **Step 1: Write RED transport tests**

Gateway:

- strict-parse `memory_policy` and `canvas_context`;
- reject unknown fields and context-digest mismatch before Agent creation;
- enter request policy for exactly one Run;
- emit a structured `memory.write.proposed` event;
- advertise versioned
  `canvas_memory_policy_v1={enabled:true, policyVersion:1, sourceRevision}`;
- legacy requests without policy retain existing behavior.

ACP:

- read policy/context from `kwargs['hermes']` supplied by `_meta.hermes`;
- bind it only around that prompt;
- preserve the `canvas:` gateway session key established by Runtime Foundation;
- emit proposal metadata without writing profile memory;
- two ACP Sessions under one profile can run opposite policies concurrently
  without leakage.
- advertise the same policy version/source revision in `initialize` metadata.

- [ ] **Step 2: Implement transport adapters without changing defaults**

The Runtime Worker launches the worktree code directly:

```text
/home/youran/.hermes/hermes-agent/venv/bin/python
  -m hermes_cli.main acp
```

with `PYTHONPATH=/home/youran/.hermes/.worktrees/canvas-runtime-policy` and the
explicit profile `HERMES_HOME`. Existing Discord/微信/CLI behavior must remain
unchanged when no Canvas policy is supplied.

- [ ] **Step 3: Run Hermes regression and commit**

```bash
cd /home/youran/.hermes/.worktrees/canvas-runtime-policy
/home/youran/.hermes/hermes-agent/venv/bin/python -m pytest -q \
  tests/gateway/test_api_server_canvas_memory.py \
  tests/gateway/test_api_server_canvas_runs.py \
  tests/acp/test_canvas_session_policy.py \
  tests/acp/test_server.py \
  tests/acp/test_session.py
git diff --check
git add gateway acp_adapter tests/gateway tests/acp
git commit -m "feat(api): carry Canvas memory policy"
```

Expected: Canvas policy tests and existing Gateway/ACP regressions pass.

- [ ] **Step 4: Implement activation control**

`CANVAS_MEMORY_POLICY_ENABLED` is parsed as exact `0|1` and defaults to
fail-closed `0`. Write RED tests and implement `RuntimeCapabilityActivator`
plus the operator CLI. Tests cover exact version/revision matching,
all-three-or-none database updates, a degraded/offline Binding, no secret/path
output, and rollback to unsupported. Composition and Worker tests prove the
flag accepts only `0|1`, stays disabled on `0`, and never advertises memory
support merely because Hermes reports a capability.

The stored value is exactly
`perRunMemoryPolicy='adapter' + VerifiedMemoryPolicyCapability`; rollback
stores `unsupported` and clears the verification object. Agent DTO tests reject
stale `verifiedCanvasRelease`, stale `hermesSourceRevision`, unknown policy
version or an empty/unknown modes array.

```bash
docker build --target test --tag ai-super-canvas:memory-capability-activator .
docker run --rm ai-super-canvas:memory-capability-activator \
  vitest run packages/control-plane/src/runtime-capability-activator.test.ts
git diff --check
git add \
  packages/control-plane packages/db/src/repositories \
  services/hermes_runtime_worker apps/web/src/server \
  scripts/activate-agent-memory-policy.ts package.json compose.yaml .env.example
git commit -m "feat(memory): activate verified runtime capabilities"
```

Do not deploy or activate yet: Task 9 still changes runtime-affecting Canvas
code. The release is locked only after that commit.

---

### Task 9: Persist memory proposals and approve them atomically

**Files:**

- Modify: `packages/ai/src/runtime/contract.ts`
- Modify: `packages/ai/src/runtime/contract-suite.ts`
- Modify: `packages/control-plane/src/runtime-event-mapper.ts`
- Modify: `packages/control-plane/src/runtime-event-mapper.test.ts`
- Modify: `packages/control-plane/src/run-event-pump.ts`
- Modify: `packages/control-plane/src/run-event-pump.test.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Create:
  `apps/web/src/app/api/control-plane/memory-proposals/[proposalId]/decision/route.ts`
- Create:
  `apps/web/src/app/api/control-plane/memory-proposals/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`

- [ ] **Step 1: Write RED proposal lifecycle tests**

Add normalized Runtime event:

```ts
{
  type: 'memory.write.proposed';
  eventId;
  canvasSessionId;
  canvasRunId;
  externalProposalRef;
  target: 'project' | 'agent';
  summary;
  content;
  occurredAt;
}
```

Test:

- event ingestion and proposal insertion are one transaction and idempotent;
- `session_only` proposal is rejected as protocol error;
- project proposal derives `agentId/workflowId` from the Run;
- global proposal requires the immutable Run mode to be `agent_global` and
  additionally rechecks Agent owner/admin; an `agent_project` Run cannot
  escalate `target='agent'`;
- approve creates exactly one `context_refs` row and links it;
- reject creates no ContextRef;
- repeated same decision returns original result;
- conflicting second decision returns 409;
- grant revoked before decision denies approval;
- API body accepts only `{commandId, decision:'approve'|'reject'}`;
- listing returns safe summary and never raw Runtime refs.

- [ ] **Step 2: Implement approval as a single transaction**

For approved project writes create `scope='agent_workflow'`; for approved
global writes create `scope='agent'`. Use:

```text
source_kind = canvas_memory_proposal
source_ref  = proposal UUID
```

and preserve provenance with safe Canvas IDs/digests. Do not call Hermes memory
write APIs in v1.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:memory-proposals .
docker run --rm ai-super-canvas:memory-proposals \
  vitest run \
  packages/control-plane/src/runtime-event-mapper.test.ts \
  packages/control-plane/src/run-event-pump.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-memory-proposals \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/ai packages/control-plane packages/db apps/web/src/app/api/control-plane
git commit -m "feat(memory): review agent memory proposals"
```

Expected: proposal lifecycle, idempotency and authorization tests pass.

- [ ] **Step 4: Lock the final memory release after all runtime changes**

```bash
git status --short
MEMORY_RELEASE_SHA="$(git rev-parse HEAD)"
HERMES_RELEASE_SHA="$(
  git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy rev-parse HEAD
)"
test "${#MEMORY_RELEASE_SHA}" -eq 40
test "${#HERMES_RELEASE_SHA}" -eq 40
test -z "$(git status --short)"
test -z "$(
  git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy \
    status --short
)"
git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy \
  diff --quiet
docker build \
  --build-arg APP_REVISION="$MEMORY_RELEASE_SHA" \
  --label "org.opencontainers.image.revision=$MEMORY_RELEASE_SHA" \
  --tag "ai-super-canvas:memory-policy-$MEMORY_RELEASE_SHA" .
MEMORY_IMAGE_ID="$(
  docker image inspect --format '{{.Id}}' \
    "ai-super-canvas:memory-policy-$MEMORY_RELEASE_SHA"
)"
test -n "$MEMORY_IMAGE_ID"
docker build \
  --target operator \
  --build-arg APP_REVISION="$MEMORY_RELEASE_SHA" \
  --label "org.opencontainers.image.revision=$MEMORY_RELEASE_SHA" \
  --tag "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" .
MEMORY_OPERATOR_IMAGE_ID="$(
  docker image inspect --format '{{.Id}}' \
    "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA"
)"
test -n "$MEMORY_OPERATOR_IMAGE_ID"
```

Both worktrees must be clean. This lock occurs after proposal/event/API code,
so the real isolation suite cannot accidentally run against an older image.

- [ ] **Step 5: Deploy exact revisions with memory and Run writes closed**

Use the Foundation's single gate writer to set real Runtime on, memory and Run
writes off, and Fake off. Mark all three persisted capabilities unsupported,
pin Worker and Web to `MEMORY_RELEASE_SHA`, then restart Gateway, Worker and
Canvas:

```bash
systemctl --user stop ai-super-canvas.service
test -z "$(ss -ltnH 'sport = :3000')"
bash scripts/set-deployment-gates.sh \
  --real-runtime 1 \
  --memory-policy 0 \
  --real-runs 0 \
  --fake-runtime 0
bash scripts/install-runtime-release.sh \
  --sha "$MEMORY_RELEASE_SHA" \
  --release-root /home/youran/.local/share/ai-super-canvas
MIGRATION_MANIFEST="/home/youran/.local/state/ai-super-canvas/migrations/0008-to-0011-$MEMORY_RELEASE_SHA.json"
install -d -m 0700 \
  /home/youran/.local/state/ai-super-canvas/backups \
  /home/youran/.local/state/ai-super-canvas/migrations
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$MEMORY_RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$MEMORY_RELEASE_SHA" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation ensure-database-only
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$MEMORY_RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$MEMORY_RELEASE_SHA" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation backup \
  --allow-legacy-pre-0010 \
  --expected-current-head 0008 \
  --output "/home/youran/.local/state/ai-super-canvas/backups/pre-0011-$MEMORY_RELEASE_SHA.dump"
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$MEMORY_RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$MEMORY_RELEASE_SHA" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation migrate \
  --expected-head 0011
DATABASE_INSTANCE_ID="$(
  bash scripts/run-database-operation.sh \
    --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$MEMORY_RELEASE_SHA/compose.yaml" \
    --project ai-super-canvas \
    --release-sha "$MEMORY_RELEASE_SHA" \
    --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
    --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
    --migration-manifest "$MIGRATION_MANIFEST" \
    --operation seed \
    --record-instance-id /home/youran/.local/state/ai-super-canvas/database-instance-id \
    --print-safe-instance-id
)"
printf '%s\n' "$DATABASE_INSTANCE_ID" | \
  rg -q '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$MEMORY_RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$MEMORY_RELEASE_SHA" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation verify \
  --expected-head 0011
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$MEMORY_RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$MEMORY_RELEASE_SHA" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --operation activate-memory-policy \
  --disable \
  --expected-canvas-revision "$MEMORY_RELEASE_SHA"
bash scripts/install-runtime-release.sh \
  --sha "$MEMORY_RELEASE_SHA" \
  --release-root /home/youran/.local/share/ai-super-canvas \
  --worker-env /home/youran/.config/ai-super-canvas/runtime-worker.env \
  --canvas-env /home/youran/.config/ai-super-canvas/ai-super-canvas.env \
  --canvas-image "ai-super-canvas:memory-policy-$MEMORY_RELEASE_SHA" \
  --canvas-image-id "$MEMORY_IMAGE_ID" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --install-units-dir /home/youran/.config/systemd/user
systemctl --user daemon-reload
systemctl --user cat ai-super-canvas.service | \
  rg "/home/youran/.local/share/ai-super-canvas/current/compose.yaml"
systemctl --user cat ai-super-canvas.service | \
  rg "WorkingDirectory=/home/youran/.local/share/ai-super-canvas/current"
systemctl --user cat ai-super-canvas-runtime-worker.service | \
  rg "WorkingDirectory=/home/youran/.local/share/ai-super-canvas/current"
OLD_MAIN_PID="$(systemctl --user show -p MainPID --value hermes-gateway.service)"
systemctl --user restart hermes-gateway.service
NEW_MAIN_PID="$(systemctl --user show -p MainPID --value hermes-gateway.service)"
test "$NEW_MAIN_PID" -gt 1
test "$NEW_MAIN_PID" != "$OLD_MAIN_PID"
systemctl --user restart ai-super-canvas-runtime-worker.service
systemctl --user restart ai-super-canvas.service
```

The pre-0010 exception is permitted only for the independently validated
legacy database and only for backup-before-migrate. This is an explicit
maintenance window: stop the old Web and prove port 3000/app container absent,
while the runner keeps only PostgreSQL on the private network. The operator
must prove PostgreSQL client/server major 18, validate the dump, then migrate
to `0011` and create the non-caller-selected seed receipt. Its durable
migration manifest resumes safely after a crash at backup/migrate/seed/verify.
Any failure keeps Canvas stopped, memory/Runs closed and the backup/manifest;
do not claim the old image is safe to restart until the tested schema
compatibility or an explicit restore has been proven. Only after
`verify --expected-head 0011` succeeds may the installer atomically install
the pinned Canvas unit, switch both images and start port 3000.

`compose.yaml` uses explicit `CANVAS_IMAGE` and never silently builds/reuses a
floating image. Require the installer manifest and running Canvas/operator
container IDs to equal the two independently captured IDs; do not recompute
expected truth from either tag.
Capture old/new Gateway `MainPID`; require a new PID,
`readlink -f /proc/$NEW_MAIN_PID/cwd` equal to the reviewed Hermes worktree, the
installed drop-in present, and authenticated capabilities equal policy version
1 plus `HERMES_RELEASE_SHA`. Worker UDS and Web health both equal
`MEMORY_RELEASE_SHA`; zzh/nsy ACP initialize metadata equal the Hermes SHA.
An unrelated shell import probe is not deployment evidence. Verify the
resolved environment and readiness tuple is exactly `1,0,0,0`; on persistent
port 3000 perform only non-mutating `/`, Agent catalog and
capability/version checks. No marker, Session or Run probe is permitted here.
Only after all of those checks pass, seal the matching migration manifest:

```bash
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$MEMORY_RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$MEMORY_RELEASE_SHA" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation seal-migration \
  --expected-head 0011
```

- [ ] **Step 6: Activate only after the live isolation gate**

Atomically set memory enabled while Runs remain closed, restart Worker and
Canvas, verify the resolved tuple is `1,1,0,0`, then:

```bash
bash scripts/set-deployment-gates.sh \
  --real-runtime 1 \
  --memory-policy 1 \
  --real-runs 0 \
  --fake-runtime 0
systemctl --user restart ai-super-canvas-runtime-worker.service
systemctl --user restart ai-super-canvas.service
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$MEMORY_RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$MEMORY_RELEASE_SHA" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --operation activate-memory-policy \
  --expected-canvas-revision "$MEMORY_RELEASE_SHA" \
  --expected-policy-version 1 \
  --expected-hermes-revision "$HERMES_RELEASE_SHA"
```

The activator re-probes all three Bindings and atomically persists
`perRunMemoryPolicy='adapter' + VerifiedMemoryPolicyCapability`; a mismatch
updates none. The Agent DTO intersects engine modes with current owner/grant
rights. Rollback sets the flag to `0`, restarts Worker/Canvas, atomically clears
all three verification objects and leaves persisted history readable.

On the persistent `127.0.0.1:3000` deployment, stop here after a
non-mutating `/` load, safe Agent catalog and capability/version handshake.
The marker/proposal/rotation matrix below must not write test data into the
persistent Canvas database.

---

### Task 10: Prove real memory and Session isolation

**Files:**

- Create: `tests/e2e/agent-memory-isolation.real.spec.ts`
- Create: `playwright.memory.config.ts`
- Create: `compose.memory-acceptance.yaml`
- Create: `scripts/start-memory-isolation-stack.sh`
- Create: `scripts/test-agent-memory-isolation.sh`
- Modify: `/home/youran/data/agent-architecture.md`
- Modify: `/home/youran/data/service-ports.md`
- Modify: `/home/youran/data/service-ports.json`

- [ ] **Step 1: Seed only synthetic markers**

`scripts/start-memory-isolation-stack.sh` is the only entrypoint for this
matrix. It validates `MEMORY_RELEASE_SHA`, `MEMORY_IMAGE_ID`,
`MEMORY_OPERATOR_IMAGE_ID` and `HERMES_RELEASE_SHA`, then starts a nonce
Compose project on temporary
loopback `127.0.0.1:3100` with fresh PostgreSQL plus an
acceptance-scoped Worker/private UDS/ledger from the exact pinned Canvas
release. It seeds/activates the three Bindings in that disposable database and
proves zero SessionNodes before yielding to Playwright. The persistent Canvas
database and persistent Runtime Worker Socket are never mounted.
The wrapper rejects inherited gate values, supplies exactly real Runtime `1`,
memory `1`, Runs `1`, Fake `0` to disposable Web and Worker, and asserts that
same tuple through health/readiness before seeding markers.
PostgreSQL has no host port. The independently ID-verified memory operator
image joins only the nonce private network with `--log-driver=none`, performs fresh
migrate-to-`0011`/seed, owns the nonce `DATABASE_URL` inside that container,
verifies the receipt's `databaseInstanceId` and nonce database name, and starts
the private acceptance operator channel defined by the Identity plan.
Before that verification, only PostgreSQL and the one-shot operator run;
acceptance Worker and Web start afterward.
Playwright receives only its `0600` Socket path plus safe instance ID, and uses
the channel for
pairing, `record_command` before every mutation, exact
`record_native_marker`, and revocation; it cannot inherit or choose a database
URL.
Before start, update both port inventories together to identify 3100 as the
temporary non-boot memory-isolation listener and include its exact cleanup
command; after the trap, record that the listener is closed. Read/update
`agent-architecture.md` with the acceptance Worker and direct
Jarvis/profile-ACP boundary, without any profile content or secret.

Create distinct, non-private markers:

```text
jarvis/global/JV-GLOBAL-<nonce>
jarvis/project-A/JV-A-<nonce>
jarvis/project-B/JV-B-<nonce>
zzh/global/ZZH-GLOBAL-<nonce>
zzh/project-A/ZZH-A-<nonce>
nsy/global/NSY-GLOBAL-<nonce>
nsy/project-A/NSY-A-<nonce>
zzh/selected-session/ZZH-SELECTED-<nonce>
```

Insert Canvas markers through the same proposal/approval APIs used by the
product. Native global markers may be temporarily staged through existing
Hermes approved test fixtures. The parent records every mutating `commandId`,
proposal, ContextRef and native marker in the wrapper-owned durable `0600`
manifest through that channel. The outer trap changes it to `cleaning`,
resolves exact terminal Run and Session refs/fingerprints from disposable
receipts, invokes `cleanup_acceptance_run` for every terminal Run first, then
`cleanup_acceptance_session` for every Session, removes only exact native
markers, revokes the run's device Sessions/codes, verifies profile file hashes
and proves both Run/Session manifests have no unresolved ref. It then seals the
manifest, stops Worker and runs the validated nonce `down -v`. It never uses
prefix/profile-wide deletion; a later wrapper invocation resumes any unsealed
owned manifest before starting. The fresh Canvas data disappears only with
this nonce volume.

- [ ] **Step 2: Run the mode matrix through real Adapters**

For each Agent prove:

- `session_only` cannot retrieve any global/project/history marker;
- `agent_project` retrieves only same Agent/current Workflow project marker;
- `agent_global` retrieves same Agent global plus current project;
- selected history marker is readable when checked;
- after unchecking and creating a new Run, it is not readable;
- narrowing `agent_global -> session_only` rotates the external Runtime Session,
  changes the generation digest and cannot retrieve a global marker that was
  available to the old hidden prompt but never echoed into Canvas transcript;
- no mode retrieves another Agent/profile or another project marker;
- no Account can select or read another Account's same-Jarvis Session;
- concurrent zzh/nsy Runs do not cross;
- rejected memory write is never readable;
- approved write becomes readable in its target scope;
- profile `MEMORY.md`/`USER.md` hashes remain unchanged by Canvas proposal flow.

Do not accept Agent self-identification as proof. Correlate safe Binding ID,
Worker profile slot, Canvas Run/event rows and marker result.

- [ ] **Step 3: Restart both sides and repeat the critical cases**

```bash
bash scripts/test-agent-memory-isolation.sh \
  --acceptance-project "$CANVAS_ACCEPTANCE_PROJECT" \
  --acceptance-worker-unit "$CANVAS_ACCEPTANCE_WORKER_UNIT"
```

The still-running Playwright parent retains all browser Contexts and invokes
this helper; the helper never holds or serializes Cookie/storage state. It:

1. records current service state and safe IDs;
2. runs the matrix;
3. restarts only the acceptance-scoped Worker;
4. reruns selected/unselected and cross-profile cases;
5. restarts only `hermes-gateway.service`, verifies the reviewed module
   revision/capability, and reruns global -> session-only narrowing;
6. restarts only the disposable production Web container;
7. reruns them again;
8. returns control to the parent cleanup trap;
9. scans disposable logs/database artifacts for the other profile’s markers
   and secrets.

Expected: all positive and negative assertions pass after both restarts.

- [ ] **Step 4: Run full gates and commit**

```bash
docker build --target test --tag ai-super-canvas:memory-final .
docker run --rm ai-super-canvas:memory-final lint
docker run --rm ai-super-canvas:memory-final typecheck
docker run --rm ai-super-canvas:memory-final test
COMPOSE_PROJECT_NAME=ai-super-canvas-memory-final \
  bash ./scripts/test-integration.sh
bash scripts/start-memory-isolation-stack.sh \
  --release-sha "$MEMORY_RELEASE_SHA" \
  --image "ai-super-canvas:memory-policy-$MEMORY_RELEASE_SHA" \
  --expected-image-id "$MEMORY_IMAGE_ID" \
  --operator-image "ai-super-canvas:memory-operator-$MEMORY_RELEASE_SHA" \
  --expected-operator-image-id "$MEMORY_OPERATOR_IMAGE_ID" \
  --expected-hermes-revision "$HERMES_RELEASE_SHA" \
  --port 3100 \
  -- corepack pnpm exec playwright test \
  --config=playwright.memory.config.ts \
  tests/e2e/agent-memory-isolation.real.spec.ts \
  --project=chromium \
  --workers=1
git diff --check
git add \
  tests/e2e/agent-memory-isolation.real.spec.ts \
  playwright.memory.config.ts \
  compose.memory-acceptance.yaml \
  scripts/start-memory-isolation-stack.sh \
  scripts/test-agent-memory-isolation.sh
git commit -m "test(e2e): prove real agent memory isolation"
```

Expected: every gate exits 0. If any forbidden marker is retrievable, stop
deployment immediately and retain evidence; do not weaken the assertion.

`playwright.memory.config.ts` targets only the wrapper-provided disposable
production image at `127.0.0.1:3100`, starts no `pnpm dev` server, rejects the
persistent port 3000, verifies the health/Worker/Hermes revisions and zero-node
gate first, and disables trace/video/network-body/storage-state retention.

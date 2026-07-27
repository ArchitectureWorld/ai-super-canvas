# Real Canvas Product Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 PostgreSQL 和真实 Runtime 驱动首页 `/` 的画板产品，让 ZZH、NSY 和管理员能在桌面与窄屏完成 Agent 选择、记忆选择、真实对话、Agent 切换、故障恢复和重启恢复。

**Architecture:** 首页只渲染真实画板壳，`RealWorkspaceCanvas` 随即从受设备会话保护的 `/api/control-plane/canvas` 加载安全 snapshot，把数据库 SessionNode/Edge 投影为可拖拽缩放的二维画板，并复用抽出的控制面客户端、幂等命令和 Run 恢复逻辑；节点 Inspector 负责 Agent、记忆、历史 Session、对话和 proposal；移动端使用底部抽屉；所有内部 Binding/Runtime ref 在服务端 DTO 边界删除。

**Tech Stack:** Next.js 16.2.11、React 19.2.7、TypeScript 6.0.3、PostgreSQL 18、Drizzle ORM 0.45.2、Vitest 4.1.10、Playwright 1.61.1、CSS Pointer Events、Docker Compose、systemd --user。

---

## Global constraints

- 在 Agent Memory Policy 的 migration `0011`、Hermes policy 提交和全部隔离门禁通过后执行。
- 本计划使用 migration `0012_real_canvas_view_state`。
- 产品入口永远是 `/`；`/control-plane-test` 只保留为管理员诊断页，不能包装成产品或计入产品验收。
- `/` 不再加载 `WorkspacePrototype`、Demo `WorkspaceState`、Fake 回复、固定“提炼成果”或本地模型选择。
- 画板是主界面：节点有空间位置和连线，可平移、缩放、拖拽；不能退化成纵向卡片列表。
- PostgreSQL 是 SessionNode、Edge、配置、消息和 Run 的事实源；localStorage 只允许保存尚未获得服务端 receipt 的短命令恢复指针，不得保存 transcript、Agent 权限、记忆内容或 Canvas 结构。
- 浏览器只能看到安全产品 DTO；禁止 `agentBindingId`、Runtime kind、endpoint、secret、profile、外部 Session/Run ref 和原始工具 payload。
- Agent attach 后切换必须创建新 SessionNode；旧节点、消息和 Run 保留。
- v1 Session history is private to its creator even when two Accounts share
  Jarvis or the same Workspace. Agent grants authorize creation/use of an
  Account's own Sessions; they never grant access to another Account's
  transcript. Admin does not bypass this rule without a future explicit
  Session-sharing model.
- Jarvis、于途或乔晶晶失败时不切换 Agent、不回退 Fake。
- 模型选择首版隐藏：当前 Jarvis 只报告不可切换的 `hermes-agent`，个人 ACP 也未通过真实模型切换验收。
- 首版不展示 Runtime 工具审批/停止控件；“记忆提案批准”只是 Canvas
  PostgreSQL 内的受权 ContextRef 决策，不会触发原生工具继续执行。
- `CANVAS_REAL_RUNS_ENABLED=0` 时真实画板仍可读，只禁用新 Run；绝不恢复旧 Demo 页面。

## Safe Product Canvas DTO

```ts
interface ProductCanvasSnapshot {
  runtimeWritesEnabled: boolean;
  account: {
    displayName: string;
    platformRole: 'member' | 'admin';
  };
  workflow: {
    workflowId: string;
    title: string;
    revision: string;
  };
  agents: AuthorizedAgentListDto;
  nodes: Array<{
    nodeId: string;
    sessionId: string;
    title: string;
    agent: {
      agentId: string;
      name: string;
      type: 'family' | 'personal';
      availability: 'available' | 'degraded' | 'offline' | 'confirming';
    };
    sessionStatus: string;
    transcriptVersion: number;
    config: {
      version: number;
      memoryMode: 'session_only' | 'agent_project' | 'agent_global';
      selectedSessionIds: string[];
      writePolicy: 'confirm_each';
    };
    messages: ProductMessageDto[];
    activeRun: null | {
      runId: string;
      status: string;
      after: number;
    };
    pendingMemoryProposals: ProductMemoryProposalDto[];
  }>;
  edges: Array<{
    edgeId: string;
    sourceNodeId: string | null;
    targetNodeId: string;
    kind: 'derives' | 'references' | 'supports' | 'contradicts'
      | 'depends_on' | 'agent_switch';
  }>;
  view: {
    version: number;
    selectedNodeId: string | null;
    viewport: { x: number; y: number; zoom: number };
    positions: Record<string, { x: number; y: number }>;
  };
}
```

The snapshot must pass a serializer test that recursively rejects keys matching:

```text
secret|token|cookie|endpoint|external.*ref|binding|isolation|profile|stack
```

## File map

### Product projection and persisted view

- Modify: `packages/db/src/schema/enums.ts`
- Create: `packages/db/src/schema/canvas-view.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/schema/schema-constraints.integration.test.ts`
- Modify: `packages/db/src/migrations/migration-upgrade.integration.test.ts`
- Modify: `packages/db/src/testing/disposable-test-database.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Create: `packages/db/migrations/0012_real_canvas_view_state.sql`
- Create: `packages/db/migrations/meta/0012_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/control-plane/src/product-canvas-service.ts`
- Create: `packages/control-plane/src/product-canvas-service.test.ts`
- Create: `packages/control-plane/src/product-canvas-dto.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/index.ts`

### Product APIs

- Create: `apps/web/src/app/api/control-plane/canvas/route.ts`
- Create:
  `apps/web/src/app/api/control-plane/canvas/view-state/route.ts`
- Create:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/switch-agent/route.ts`
- Create:
  `apps/web/src/app/api/control-plane/commands/[commandId]/outcome/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`
- Modify: `apps/web/src/server/authenticated-account.ts`

### Shared browser reliability layer

- Create: `apps/web/src/client/control-plane-api.ts`
- Create: `apps/web/src/client/control-plane-api.test.ts`
- Create: `apps/web/src/client/run-recovery.ts`
- Create: `apps/web/src/client/run-recovery.test.ts`
- Modify:
  `apps/web/src/app/control-plane-test/control-plane-test-client.tsx`

### Real canvas UI

- Create: `apps/web/src/components/session-canvas-projection.ts`
- Create: `apps/web/src/components/session-canvas-projection.test.ts`
- Create: `apps/web/src/components/real-canvas-state.ts`
- Create: `apps/web/src/components/real-canvas-state.test.ts`
- Create: `apps/web/src/components/real-workspace-canvas.tsx`
- Create: `apps/web/src/components/session-node.tsx`
- Create: `apps/web/src/components/session-node-inspector.tsx`
- Create: `apps/web/src/components/memory-policy-controls.tsx`
- Create: `apps/web/src/components/memory-proposal-review.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/components/canvas-state.ts`
- Modify: `apps/web/src/components/canvas-state.test.ts`

### Verification, deployment and documentation

- Create: `tests/e2e/real-canvas.spec.ts`
- Create: `tests/e2e/real-canvas.real.spec.ts`
- Create: `tests/e2e/real-canvas.visual.spec.ts`
- Create: `playwright.product.config.ts`
- Create: `scripts/test-real-canvas-restart.sh`
- Create: `scripts/verify-real-agent-deployment.sh`
- Modify: `apps/web/src/app/api/health/route.ts`
- Create: `apps/web/src/app/api/health/route.test.ts`
- Modify: `apps/web/src/app/api/ready/handler.ts`
- Modify: `apps/web/src/app/api/ready/handler.test.ts`
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/deployment/linux-nas-docker.md`
- Create:
  `docs/acceptance/2026-07-27-real-canvas-product-acceptance.md`
- Create:
  `artifacts/acceptance/real-canvas/release-manifest.json`
- Create:
  `artifacts/acceptance/real-canvas/result-index.json`
- Create:
  `artifacts/acceptance/real-canvas/zzh-desktop.png`
- Create:
  `artifacts/acceptance/real-canvas/nsy-desktop.png`
- Create:
  `artifacts/acceptance/real-canvas/admin-desktop.png`
- Create:
  `artifacts/acceptance/real-canvas/mobile-normal.png`
- Create:
  `artifacts/acceptance/real-canvas/mobile-recovery.png`
- Create:
  `artifacts/acceptance/real-canvas/release-manifest.json`
- Create: `artifacts/acceptance/real-canvas/.gitkeep`
- Modify:
  `/home/youran/.config/systemd/user/ai-super-canvas.service`
- Modify:
  `/home/youran/.config/systemd/user/ai-super-canvas-runtime-worker.service`
- Modify: `/home/youran/data/agent-architecture.md`
- Modify: `/home/youran/data/service-ports.md`
- Modify: `/home/youran/data/service-ports.json`

---

### Task 1: Persist a personal Canvas view and an explicit Agent-switch edge

**Files:**

- Modify: `packages/db/src/schema/enums.ts`
- Create: `packages/db/src/schema/canvas-view.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/schema/schema-constraints.integration.test.ts`
- Modify: `packages/db/src/migrations/migration-upgrade.integration.test.ts`
- Modify: `packages/db/src/testing/disposable-test-database.ts`
- Create: `packages/db/migrations/0012_real_canvas_view_state.sql`
- Create: `packages/db/migrations/meta/0012_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Write RED schema tests**

Add `agent_switch` to `session_edge_kind`. It requires a non-null source,
non-null target and null anchor.

Create `canvas_view_states`:

```ts
{
  accountId,
  workflowId,
  version,
  selectedNodeId,
  viewport,    // {x,y,zoom}
  positions,   // nodeId -> {x,y}
  updatedAt,
}
```

Constraints:

- primary key `(account_id, workflow_id)`;
- Account must be a member of the Workspace at Repository authorization time;
- version is positive;
- add `UNIQUE (id, workflow_id)` on `session_nodes` and a composite foreign key
  `(selected_node_id, workflow_id) -> session_nodes(id, workflow_id)` with
  `ON DELETE NO ACTION`, so a non-null selection belongs to the same Workflow;
  node deletion must clear affected selections in the same transaction first;
- JSON structure is validated by service before insertion;
- deleting Account or Workflow cascades the view only, never Session data.

Run:

```bash
docker run --rm ai-super-canvas:memory-final \
  vitest run packages/db/src/schema/schema-contract.test.ts
```

Expected: FAIL because the enum/table are absent.

- [ ] **Step 2: Add schema and migration**

```bash
corepack pnpm --filter @ai-super-canvas/db exec \
  drizzle-kit generate --name real_canvas_view_state
```

Use repository Node 24. Expected number is `0012`; inspect the SQL for no
unrelated destructive statements.

The real migrator may apply all pending files in one PostgreSQL transaction.
Every CHECK, partial index or predicate in `0012` that refers to the new enum
value therefore uses text comparison such as
`kind::text = 'agent_switch'`; it must not use
`kind = 'agent_switch'` before the enum addition commits. Extend the SQL guard
test for this unsafe-literal pattern.

Build the schema tag before any test first references it:

```bash
docker build --target test --tag ai-super-canvas:view-schema .
docker image inspect ai-super-canvas:view-schema >/dev/null
```

- [ ] **Step 3: Run constraints and commit**

Extend `migration-upgrade.integration.test.ts` to create representative data at
exactly migration `0008`, invoke the real migrator once through `0012`, and
prove existing Session/edge/context rows survive. This covers both the
`0011 agent_workflow` and `0012 agent_switch` same-transaction enum cases.
Add a second fixture already at `0011` and make one real migrator call to
`0012`, so the `agent_switch` failure is isolated rather than masked by an
earlier migration.

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-view-schema \
  bash ./scripts/test-integration.sh
git diff --check
git add \
  packages/db/src/schema packages/db/src/testing packages/db/src/migrations \
  packages/db/migrations
git commit -m "feat(db): persist real canvas views"
```

Expected: schema and database constraints pass.

---

### Task 2: Build a safe server-side Product Canvas projection

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Create: `packages/control-plane/src/product-canvas-dto.ts`
- Create: `packages/control-plane/src/product-canvas-service.ts`
- Create: `packages/control-plane/src/product-canvas-service.test.ts`
- Modify: `packages/control-plane/src/index.ts`
- Create: `apps/web/src/app/api/control-plane/canvas/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`

- [ ] **Step 1: Write RED projection and leakage tests**

Repository locates the seeded product Workflow from
`system_seed_receipts.seed_key='local-real-agent-product-v1'`, then performs one
repeatable-read hydration for the current Account.

Tests prove:

- only Sessions created by the current Account are returned; a shared
  Workspace, shared Jarvis grant or admin role never exposes another
  Account's Session;
- each node contains safe Agent identity and current config, transcript,
  active Run cursor and pending proposal;
- view state is Account-specific;
- revoked Agent disappears from the selector and cannot start new work, while
  a Session originally created by this Account remains as a read-only
  historical node; an Account that never had that Session cannot gain access;
- historical messages remain readable when Runtime is offline;
- serialized DTO recursively contains no forbidden internal key;
- internal `hydrateWorkflow().agentBindingId` never crosses the service DTO.

Split authorization explicitly:

- historical read is allowed only to the Session creator, including after a
  later Agent-grant revocation;
- config changes, new Runs, context-option loading and memory decisions always
  require a current grant;
- platform/admin role and a current Agent grant still do not reveal another
  Account's historical Session;
- after the Session visibility set is finalized, edges require both endpoints
  visible, positions contain only visible node IDs, and a hidden
  `selectedNodeId` becomes null;
- an Agent with a valid grant remains in the selector when its Binding is
  missing, disabled or unhealthy, with `availability='offline'`; only grant
  revocation removes it.

Run:

```bash
docker run --rm ai-super-canvas:view-schema \
  vitest run packages/control-plane/src/product-canvas-service.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-product-projection \
  bash ./scripts/test-integration.sh
```

Expected: FAIL because projection methods are absent.

- [ ] **Step 2: Implement `GET /api/control-plane/canvas`**

Return the DTO defined above with `Cache-Control: no-store`. No query/body
parameter may select Account, Binding, endpoint, Agent profile or arbitrary
Workflow in v1.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:product-projection .
docker run --rm ai-super-canvas:product-projection \
  vitest run \
  packages/control-plane/src/product-canvas-service.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-product-projection \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db/src/repositories packages/control-plane apps/web/src/app/api/control-plane
git commit -m "feat(api): project the real product canvas"
```

Expected: unit, route and integration tests pass.

---

### Task 3: Persist pan, zoom, positions, and selection with compare-and-swap

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/product-canvas-service.ts`
- Modify: `packages/control-plane/src/product-canvas-service.test.ts`
- Create:
  `apps/web/src/app/api/control-plane/canvas/view-state/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`

- [ ] **Step 1: Write RED validation and conflict tests**

`PUT /api/control-plane/canvas/view-state` accepts exactly:

```ts
{
  commandId: UUID;
  expectedVersion: number;
  selectedNodeId: UUID | null;
  viewport: { x: finite; y: finite; zoom: 0.55..1.45 };
  positions: Record<UUID, { x: finite; y: finite }>;
}
```

Reject unknown node IDs, more than 250 positions, non-finite values and extra
keys. Prove idempotent replay, stale version 409, per-account isolation and
that view updates never mutate Session/config revisions.

- [ ] **Step 2: Implement 500 ms client debounce and server CAS**

The server derives Account/Workflow and records the command receipt. Client
flushes after drag/pan/zoom settles and on `pagehide`. A failed view save
displays a non-blocking message; it never blocks transcript or Run recovery.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:canvas-view .
docker run --rm ai-super-canvas:canvas-view \
  vitest run \
  packages/control-plane/src/product-canvas-service.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-canvas-view \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db packages/control-plane apps/web/src/app/api/control-plane
git commit -m "feat(canvas): persist personal view state"
```

Expected: view persistence and conflicts pass.

---

### Task 4: Create a new SessionNode when an attached Agent changes

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Create:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/switch-agent/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`

- [ ] **Step 1: Write RED service invariants**

Contract:

```text
POST /api/control-plane/sessions/:sourceSessionId/switch-agent
body {commandId, targetAgentId, title}
```

In one transaction:

- authorize and lock source Session;
- require the source Canvas Session and its attached ref to be durably
  traceable, but do not live-probe or require the old Runtime/Agent to be
  healthy;
- authorize target Agent and select its primary Binding;
- create a new provisioning Session and node in the same Workflow;
- create one `agent_switch` edge from old node to new node;
- create config version 1 with target Agent defaults,
  `mode='agent_project'`, empty selected Sessions and `confirm_each`;
- do not copy ContextRef, model override, tool state or external Session ref;
- save an idempotent receipt.

Then use the normal create/attach dispatch. Tests prove:

- old Session and transcript are unchanged;
- same Agent selection is rejected as a no-op;
- forged personal Agent is 404;
- uncertain attach leaves the new node `confirming` and does not mutate old;
- proven pre-dispatch `not_applied` compensates only the new provisional
  node/Session/edge and leaves a safe resource-null command outcome;
- retry with the same command returns the same node;
- Runtime failure never falls back to another Agent or Fake.
- an offline source Agent can switch to an authorized, ready/degraded target;
  the old history stays readable and no call is made to the offline source
  Runtime.

- [ ] **Step 2: Implement API and refactor shared attach dispatch**

Extract only the common create-runtime-session dispatch from
`createRootSession()` so root and switch use identical durable receipt rules.
Do not duplicate the orchestration state machine.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:agent-switch .
docker run --rm ai-super-canvas:agent-switch \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-agent-switch \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db packages/control-plane apps/web/src/app/api/control-plane
git commit -m "feat(canvas): switch agents with a new session node"
```

Expected: all switch invariants pass.

---

### Task 5: Extend the Foundation write gate across the product journey

**Files:**

- Modify: `packages/control-plane/src/runtime-write-gate.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/product-canvas-dto.ts`
- Modify: `packages/control-plane/src/product-canvas-service.ts`
- Modify: `apps/web/src/server/control-plane.ts`
- Modify: `apps/web/src/server/control-plane.test.ts`
- Modify: `compose.yaml`
- Modify: `.env.example`

- [ ] **Step 1: Extend the fail-closed RED matrix**

The Runtime Foundation already parses all four startup flags exactly, injects
`RuntimeWriteGate` into `SessionService`, and protects root Session/Run
creation. Do not reimplement or move that safety boundary here. Extend its
tests so `CANVAS_REAL_RUNS_ENABLED=0` also rejects every newly added product
orchestration with safe `503 real_runs_disabled` before any Repository write,
receipt or Runtime call:

- switch Agent;
- apply any config/context change that requires Runtime Session rotation.

Keep the Foundation assertions for root Session, Message and Run creation in
this regression suite. Persisted Canvas snapshot, transcript, Run events and
view-state reads still work. The product DTO exposes only
`runtimeWritesEnabled=false`; it does not expose environment names or raw
Runtime details.

- [ ] **Step 2: Reuse the one service-boundary gate**

The existing `RuntimeWriteGate.assertEnabled()` remains the required
constructor dependency and is called before the first mutation in each new
orchestration. Route handlers do not implement their own divergent checks.
`CANVAS_REAL_RUNTIME_ENABLED` controls Adapter registration;
`CANVAS_REAL_RUNS_ENABLED` controls all user-triggered Runtime mutations.
There is no `CANVAS_REAL_PRODUCT_ENABLED` flag.

- [ ] **Step 3: Render the closed-gate state and run GREEN**

The home page remains the real Canvas. Disable “新建对话”, send, Agent switch
and policy changes that would rotate a Runtime Session, with the product text
“真实助理暂未开放，新消息已停用；历史仍可查看”.

```bash
docker build --target test --tag ai-super-canvas:run-gate .
docker run --rm ai-super-canvas:run-gate \
  vitest run \
  packages/control-plane/src/runtime-write-gate.test.ts \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/server/control-plane.test.ts
git diff --check
git add packages/control-plane apps/web/src/server compose.yaml .env.example
git commit -m "feat(control-plane): surface the runtime write gate"
```

Expected: gate-off produces no Message, Run, Session, receipt or external
side effect; all read paths remain available.

---

### Task 6: Extract the proven browser control-plane and recovery client

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Create:
  `apps/web/src/app/api/control-plane/commands/[commandId]/outcome/route.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`
- Create: `apps/web/src/client/control-plane-api.ts`
- Create: `apps/web/src/client/control-plane-api.test.ts`
- Create: `apps/web/src/client/run-recovery.ts`
- Create: `apps/web/src/client/run-recovery.test.ts`
- Modify:
  `apps/web/src/app/control-plane-test/control-plane-test-client.tsx`

- [ ] **Step 1: Characterize the current diagnostic client**

Write tests around extracted functions for:

- strict no-store JSON requests and safe error parsing;
- create Session, start Run, transcript and event cursors;
- pending command persistence containing only command/session/run IDs;
- active Run refresh recovery;
- `reconciling`/unknown disables resend;
- explicit not-applied allows manual resend with a new command;
- terminal `message.completed` triggers transcript refresh;
- Runtime unavailable still returns persisted history.

Add the protected command outcome contract:

```text
GET /api/control-plane/commands/:commandId/outcome?operation=<operation>
  -> one strict union:
     {commandId, operation:'create_session'|'switch_agent',
      status:'not_applied', resource:null}
   | {commandId, operation:'create_session'|'switch_agent',
      status:'pending'|'applied'|'indeterminate',
      resource:{sessionId,nodeId,sessionStatus}}
   | {commandId, operation:'start_run',
      status:'not_applied', resource:null}
   | {commandId, operation:'start_run',
      status:'pending'|'applied'|'indeterminate',
      resource:{sessionId,runId,runStatus}}
```

`operation` is required and allowlisted. Every mutating route and this lookup
serialize on the same transaction-scoped PostgreSQL advisory lock derived
from `commandId`; the mutating route creates the receipt as its first durable
record before any Runtime side effect, while lookup waits for that lock before
deciding absence. If the current Account has no matching receipt after the
lock is acquired—including a random ID, an ID owned by another Account, or an
operation mismatch—the endpoint returns HTTP 200 with the same strict
`not_applied, resource:null` shape using the caller-supplied operation. It
never reveals whether another Account owns the ID. This makes
crash-before-request and crash-before-receipt recoverable without guessing or
resending an uncertain command.

The DTO contains no
Binding/external ref, payload hash or raw error. `applied` and
`indeterminate` Session creation outcomes include the persisted node mapping;
the receipt is written before external dispatch, and reconciliation updates
the same row.
For a proven pre-dispatch `not_applied`, the existing compensation transaction
removes only the unmessaged provisional Session/node/edge (or unaccepted
Message/Run) before exposing `resource:null`; unknown/accepted outcomes retain
the persisted resource. This keeps draft retry from orphaning hidden nodes.

Run before extraction:

```bash
docker run --rm ai-super-canvas:agent-switch \
  vitest run \
  apps/web/src/client/control-plane-api.test.ts \
  apps/web/src/client/run-recovery.test.ts
```

Expected: FAIL because modules are absent.

- [ ] **Step 2: Move logic without changing diagnostic behavior**

Make `control-plane-test-client.tsx` consume the shared modules. Remove its
hard-coded `DeterministicFakeRuntime` wording in favor of generic safe status,
but keep the route clearly labeled “诊断工具”.

Pending local storage contains only `{commandId, operation}`. On reload or a
lost create response, the client polls the safe outcome endpoint and then
reloads the Canvas snapshot. It never automatically repeats a mutating POST:
`applied` selects the mapped node, `indeterminate|pending` stays confirming,
and only explicit `not_applied` permits a new command ID. A malformed/5xx
lookup remains confirming; a normal 404 is not part of this endpoint's
contract.

Add explicit recovery tests for: browser crash before the POST is issued,
server crash before receipt commit, another Account querying the same
`commandId` and receiving the indistinguishable resource-null shape, and a
response lost only after upstream dispatch. Only the last case may remain
`pending|indeterminate`; none may trigger an automatic mutating retry.

- [ ] **Step 3: Run existing diagnostic regression and commit**

```bash
docker build --target test --tag ai-super-canvas:shared-client .
docker run --rm ai-super-canvas:shared-client \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts \
  apps/web/src/client/control-plane-api.test.ts \
  apps/web/src/client/run-recovery.test.ts
corepack pnpm exec playwright test \
  tests/e2e/control-plane-test.spec.ts \
  --project=chromium
git diff --check
git add \
  packages/db/src/repositories packages/control-plane \
  apps/web/src/app/api/control-plane apps/web/src/client \
  apps/web/src/app/control-plane-test
git commit -m "refactor(web): share durable run recovery"
```

Expected: new unit tests and existing diagnostic E2E pass.

---

### Task 7: Project database Sessions and edges onto a real 2D canvas

**Files:**

- Create: `apps/web/src/components/session-canvas-projection.ts`
- Create: `apps/web/src/components/session-canvas-projection.test.ts`
- Create: `apps/web/src/components/real-canvas-state.ts`
- Create: `apps/web/src/components/real-canvas-state.test.ts`
- Create: `apps/web/src/components/real-workspace-canvas.tsx`
- Create: `apps/web/src/components/session-node.tsx`
- Modify: `apps/web/src/components/canvas-state.ts`
- Modify: `apps/web/src/components/canvas-state.test.ts`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Write RED projection/reducer tests**

Test deterministic projection:

- database `session_nodes` become positioned canvas nodes;
- persisted positions win; missing positions use a stable tree layout;
- `agent_switch` is visibly labeled “切换助理”;
- adding/switching a node preserves all existing coordinates;
- active/reconciling/offline status maps to node badges;
- persisted transcript replaces optimistic/streamed text;
- no list/card-only rendering path exists for desktop;
- selection and viewport restore from server view state.
- a snapshot with zero Sessions renders one client-only draft node and a
  “新建对话” CTA; draft IDs are temporary and never sent as Session IDs;
- the draft state is a discriminated union
  `{ kind:'draft', draftId, agentId, title, pendingCommandId? }`, while every
  persisted node is `{ kind:'session', nodeId, sessionId, ... }`;
- selecting an Agent changes only the local draft; default is Jarvis when
  authorized;
- if `effectiveDefaultAgentId` is null, the draft requires an explicit
  authorized Agent selection; zero grants show a safe “暂无可用助理” empty state
  and never submit Session creation;
- first submit calls the normal `POST /api/control-plane/sessions` with
  `{ commandId, workflowId, agentId, title }`, waits for the durable attach
  result, then atomically replaces the draft with the returned persisted node;
- `not-applied` keeps the draft and offers explicit retry with a new command;
  `unknown` keeps one confirming draft, polls the caller-owned command outcome,
  then reloads the product snapshot; when the receipt maps to a persisted node,
  it replaces the draft even if Runtime attach is still confirming, and never
  submits the intent twice;
- refresh before receipt restores only the safe pending command pointer, then
  reconciles it through the outcome endpoint against server receipts; it never
  treats local draft content as persisted history or guesses a Session by
  title/Agent.

- [ ] **Step 2: Replace the home page**

`page.tsx` renders only `RealWorkspaceCanvas`; on mount it calls the protected
Canvas endpoint. A 401 redirects to `/pair`; authenticated loading shows a
stable canvas skeleton, then applies the snapshot atomically. No unverified
Cookie value is trusted in the page component.

Delete `getModelCatalog()` and `WorkspacePrototype` from `/`. The old prototype
may remain as a Story/test fixture temporarily, but it must not be reachable
from product navigation.

Render an actual canvas surface with SVG/DOM edges behind freely positioned
nodes, right/middle-drag and background pointer pan, wheel zoom and node drag
handles.

The first-conversation flow uses the existing root Session API and the same
durable receipt/orchestration as diagnostic creation; it must not introduce a
second Session creation endpoint. Add reducer and browser-component tests for
fresh ZZH, NSY and admin accounts, including create failure, unknown delivery,
refresh reconciliation and successful draft replacement.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:real-canvas .
docker run --rm ai-super-canvas:real-canvas \
  vitest run \
  apps/web/src/components/session-canvas-projection.test.ts \
  apps/web/src/components/real-canvas-state.test.ts \
  apps/web/src/components/canvas-state.test.ts
git diff --check
git add apps/web/src/app/page.tsx apps/web/src/app/globals.css apps/web/src/components
git commit -m "feat(canvas): render persisted session graph"
```

Expected: projection and interaction reducers pass; `/` no longer imports the
prototype.

---

### Task 8: Build the Agent, memory, Session, chat, and proposal Inspector

**Files:**

- Create: `apps/web/src/components/session-node-inspector.tsx`
- Create: `apps/web/src/components/memory-policy-controls.tsx`
- Create: `apps/web/src/components/memory-proposal-review.tsx`
- Modify: `apps/web/src/components/real-workspace-canvas.tsx`
- Modify: `apps/web/src/components/real-canvas-state.ts`
- Modify: `apps/web/src/components/real-canvas-state.test.ts`

- [ ] **Step 1: Write RED interaction tests**

For a selected draft/current node prove:

- Agent selector contains only authorized names and defaults to Jarvis;
- before a Session exists, changing Agent updates only the draft;
- after attach, changing Agent calls switch API and selects the returned new
  node;
- old node stays visible/readable;
- all historical Session selections clear on switch;
- memory mode helper text uses “仅当前对话 / 当前项目 / Agent 全部记忆”;
- advanced list contains only current Agent Sessions;
- unchecking a Session updates config and the next Run;
- proposal shows summary/target/source and approve/reject buttons;
- Composer is disabled for offline/confirming/reconciling;
- model selector is absent when capability is false;
- raw tool payload, profile and Runtime terms are never rendered.

- [ ] **Step 2: Implement product wording and async states**

Status text:

| Internal state | Product text |
| --- | --- |
| available | 可用 |
| degraded | 部分功能暂不可用，历史仍可查看 |
| offline | 助理暂时离线，历史仍可查看 |
| reconciling | 正在确认是否已收到，请不要重复发送 |
| not-applied | 未送达，可以重新发送 |

Run deltas appear inside the active node, then `message.completed` reloads the
persisted transcript. Memory decisions reload the snapshot.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:node-inspector .
docker run --rm ai-super-canvas:node-inspector \
  vitest run apps/web/src/components/real-canvas-state.test.ts
git diff --check
git add apps/web/src/components
git commit -m "feat(canvas): operate agents from node inspector"
```

Expected: all product state tests pass.

---

### Task 9: Make the canvas genuinely usable at 390 × 844

**Files:**

- Modify: `apps/web/src/components/real-workspace-canvas.tsx`
- Modify: `apps/web/src/components/session-node.tsx`
- Modify: `apps/web/src/components/session-node-inspector.tsx`
- Modify: `apps/web/src/app/globals.css`
- Create: `tests/e2e/real-canvas.visual.spec.ts`

- [ ] **Step 1: Write the narrow-screen RED journey**

At `390×844`, test:

- background single-finger drag pans;
- node drag handle moves a node without panning the background;
- Inspector is a fixed bottom drawer and cannot leave the viewport;
- drawer content scrolls while Composer remains reachable;
- Agent, memory mode, historical Session, send, retry and proposal decision
  controls are each at least 44 px high;
- opening/closing drawer preserves selected node;
- no horizontal document overflow;
- a long Chinese error message wraps and leaves recovery button visible.

At `1440×1000`, assert the Inspector is side-anchored and edges remain visible.

- [ ] **Step 2: Implement pointer ownership and responsive CSS**

Use Pointer Events and pointer capture. `touch-action:none` is allowed only on
the canvas surface; drawer contents retain vertical scrolling. Do not emulate
mobile with a vertical node list.

- [ ] **Step 3: Run visual E2E and commit**

```bash
corepack pnpm exec playwright test \
  tests/e2e/real-canvas.visual.spec.ts \
  --project=chromium
git diff --check
git add apps/web/src tests/e2e/real-canvas.visual.spec.ts
git commit -m "feat(canvas): support touch and bottom drawer"
```

Expected: desktop and narrow-screen tests pass.

---

### Task 10: Cover the complete product behavior with deterministic API mocks

**Files:**

- Create: `tests/e2e/real-canvas.spec.ts`
- Create: `playwright.product.config.ts`
- Create: `scripts/test-product-mock-e2e.sh`

- [ ] **Step 1: Implement the mock scenarios**

Use route interception only for this file. Cover:

1. unauthenticated `/` redirects to `/pair`;
2. an empty Account sees “新建对话”, default Jarvis and authorized Agent list;
3. draft Agent selection, successful root Session attach and draft replacement;
4. root Session `not-applied`/unknown recovery without duplicate creation;
5. attached Agent switch creates/links/selects a new node;
6. run gate closed disables every mutating control but leaves history readable;
7. policy update and selected Session;
8. accepted → delta → completed → persisted transcript;
9. unknown result blocks resend;
10. explicit not-applied exposes manual resend;
11. offline authorized Agent stays selectable as offline and history is readable;
12. memory proposal approval/rejection;
13. refresh restores nodes, edges, config, selection and view from snapshot;
14. DTO containing a forbidden internal key is rejected by the client parser;
15. hidden nodes are absent from edges, positions and selected node state.

Before navigation, register one strict dispatcher keyed by HTTP method and
pathname. It fulfills only the declared mock API table and aborts/fails every
unmatched `/api/**` request, so route-registration precedence cannot let a
request escape to the local server. If separate Playwright routes are used
instead, register the catch-all first and exact allowlisted handlers afterward,
because matching routes execute in reverse registration order.

- [ ] **Step 2: Run against the production build**

Create `playwright.product.config.ts` with a production `next start` webServer
on loopback port `3100` and `reuseExistingServer=false`. The test intercepts
only browser API calls; the product page itself contains no server-side
database shortcut. Because Playwright merges the parent environment into
`webServer.env`, `scripts/test-product-mock-e2e.sh` runs both `pnpm build` and
the Playwright parent under `env -i` with an explicit non-secret allowlist
needed by Node/Corepack only. It must not carry `DATABASE_URL`, Runtime Socket,
acceptance/operator variables, Hermes variables, API keys, cookies, tokens or
any `*_SECRET*` variable into either build-time module evaluation or
`next start`.
This is the only mock-browser entrypoint and it runs both
`real-canvas.spec.ts` and `real-canvas.visual.spec.ts`; no final gate may call
`playwright.product.config.ts` directly.

The clean parent and `webServer.env` both supply these closed strict gates:

```text
CANVAS_REAL_RUNTIME_ENABLED=0
CANVAS_MEMORY_POLICY_ENABLED=0
CANVAS_REAL_RUNS_ENABLED=0
CANVAS_FAKE_RUNTIME_ENABLED=0
```

UI open/closed states in this suite come only from the declared mock DTOs.
Before navigation, assert the server process has no DB/Socket/operator/secret
variable and the resolved gates are exactly `0,0,0,0`.

```bash
bash scripts/test-product-mock-e2e.sh
```

Expected: all mock product journeys pass.

- [ ] **Step 3: Commit**

```bash
git diff --check
git add tests/e2e/real-canvas.spec.ts playwright.product.config.ts \
  scripts/test-product-mock-e2e.sh
git commit -m "test(e2e): cover the real canvas product"
```

---

### Task 11: Make the deployed revision and Runtime readiness provable

**Files:**

- Modify: `apps/web/src/app/api/health/route.ts`
- Create: `apps/web/src/app/api/health/route.test.ts`
- Modify: `apps/web/src/app/api/ready/handler.ts`
- Modify: `apps/web/src/app/api/ready/handler.test.ts`
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Modify:
  `/home/youran/.config/systemd/user/ai-super-canvas.service`
- Modify:
  `/home/youran/.config/systemd/user/ai-super-canvas-runtime-worker.service`

- [ ] **Step 1: Write RED health/readiness tests**

`/api/health` returns:

```json
{
  "status": "ok",
  "service": "ai-super-canvas-web",
  "revision": "<40-char git sha>"
}
```

`/api/ready` checks PostgreSQL and the Runtime Worker Socket independently:

```json
{
  "status": "ready",
  "database": "ready",
  "runtimeWorker": "ready",
  "gates": {
    "realRuntime": "enabled",
    "memoryPolicy": "disabled",
    "realRuns": "disabled",
    "fakeRuntime": "disabled"
  }
}
```

Every flag is parsed at startup as exact `0|1`; an absent/illegal value aborts
startup. Readiness exposes only these safe enums, never environment values or
secrets. A deliberately closed write gate can still be `status:"ready"`;
an unavailable dependency returns 503 with only safe component state. Tests
cover the initial gate-closed deployment, final all-real gate-open deployment,
Fake enabled startup rejection and every illegal flag value.

- [ ] **Step 2: Stamp and wire the production image**

Add `ARG APP_REVISION`; the production final stage validates exact
40-character lowercase hex before setting `ENV APP_REVISION`. The reusable
test target does not require the argument—route tests inject a revision—so
focused `--target test` builds in earlier tasks remain valid. Compose must:

- mount only the Runtime Socket directory;
- add only the socket group GID;
- not mount Hermes homes or env files;
- remove fixed local auth;
- require `CANVAS_IMAGE` and set
  `image: ${CANVAS_IMAGE:?CANVAS_IMAGE must be an immutable SHA tag}` with no
  production `build:` fallback;
- expose `CANVAS_REAL_RUNTIME_ENABLED`, `CANVAS_MEMORY_POLICY_ENABLED`,
  `CANVAS_REAL_RUNS_ENABLED` and `CANVAS_FAKE_RUNTIME_ENABLED`;
- remove `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_AVAILABLE_MODELS` and
  `AI_DEFAULT_MODEL` from Compose and the protected Canvas env, and prove
  filtered `docker inspect` output contains none of those names;
- keep app port at loopback `127.0.0.1:3000`.

The deployment check runs `docker compose config`, proves the resolved image
is the requested SHA tag, and compares the running container image ID with the
immutable ID recorded immediately after build. Both Canvas and Worker units
must pass `systemctl --user is-enabled` and `is-active`.

The Canvas unit must contain:

```ini
Wants=ai-super-canvas-runtime-worker.service
After=ai-super-canvas-runtime-worker.service
```

The Worker unit uses `RuntimeDirectoryPreserve=yes`, so Docker cannot
pre-create the Socket directory with the wrong owner. `Wants=` means stopping
only the Worker does not stop Canvas; add a service test that proves `/` stays
200 and persisted history remains readable while `/api/ready` safely reports
the Worker unavailable.

- [ ] **Step 3: Verify configuration with explicit non-secret test values**

```bash
POSTGRES_PASSWORD=config-test-only \
CANVAS_RUNTIME_DIR=/run/user/1000/ai-super-canvas-runtime \
CANVAS_RUNTIME_GID=1000 \
CANVAS_IMAGE=ai-super-canvas:config-test-0000000000000000000000000000000000000000 \
CANVAS_OPERATOR_IMAGE=ai-super-canvas:operator-config-test-0000000000000000000000000000000000000000 \
CANVAS_REAL_RUNTIME_ENABLED=1 \
CANVAS_MEMORY_POLICY_ENABLED=0 \
CANVAS_REAL_RUNS_ENABLED=0 \
CANVAS_FAKE_RUNTIME_ENABLED=0 \
  docker compose config --quiet

docker build --help >/dev/null
```

Expected: Compose validation exits 0 and all required build arguments are
declared. Inspect resolved output and assert the four gate values are exactly
`1,0,0,0`; do not accept values inherited from a developer shell. Do not build
the release image from an uncommitted tree.

- [ ] **Step 4: Commit all Runtime-affecting source and lock the release**

```bash
git diff --check
git add apps/web/src/app/api Dockerfile compose.yaml .env.example
git commit -m "chore(deploy): prove product runtime revision"
test -z "$(git status --short)"
RELEASE_SHA="$(git rev-parse HEAD)"
```

`git status --short` must be empty before `RELEASE_SHA` is accepted. Do not
commit protected local env or systemd files.

- [ ] **Step 5: Build and inspect the exact release**

```bash
docker build \
  --build-arg APP_REVISION="$RELEASE_SHA" \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --tag "ai-super-canvas:real-agent-product-$RELEASE_SHA" .
IMAGE_ID="$(
  docker image inspect --format '{{.Id}}' \
    "ai-super-canvas:real-agent-product-$RELEASE_SHA"
)"
test -n "$IMAGE_ID"
docker build \
  --target operator \
  --build-arg APP_REVISION="$RELEASE_SHA" \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --tag "ai-super-canvas:real-agent-operator-$RELEASE_SHA" .
OPERATOR_IMAGE_ID="$(
  docker image inspect --format '{{.Id}}' \
    "ai-super-canvas:real-agent-operator-$RELEASE_SHA"
)"
test -n "$OPERATOR_IMAGE_ID"
```

Record `RELEASE_SHA`, `IMAGE_ID` and `OPERATOR_IMAGE_ID` for the deployment
task. The release installer receives both image IDs and writes them into the
protected immutable release manifest; later verification never recomputes
expected truth from a possibly retargeted tag.
Evidence/report commits may follow, but before final acceptance require:

```bash
git diff --quiet "$RELEASE_SHA"..HEAD -- \
  apps packages services deploy Dockerfile compose.yaml package.json pnpm-lock.yaml
```

If this fails, tests, build and deployment restart from a new `RELEASE_SHA`.

---

### Task 12: Run the real three-account, three-Agent product acceptance

**Files:**

- Create: `tests/e2e/real-canvas.real.spec.ts`
- Create: `playwright.real-product.config.ts`
- Create: `playwright.persistent-product.config.ts`
- Create: `compose.acceptance.yaml`
- Create: `scripts/start-real-product-acceptance-stack.sh`
- Create: `scripts/with-persistent-product-operator.sh`
- Create: `scripts/test-real-canvas-restart.sh`
- Create: `scripts/verify-real-agent-deployment.sh`
- Create: `artifacts/acceptance/real-canvas/.gitkeep`

- [ ] **Step 0: Commit the acceptance harness before it touches live state**

Implement all files listed above, including their shell-fixture/unit tests,
have them reviewed, and commit them before any persistent deployment,
pairing, Session or Run:

```bash
git diff --check
corepack pnpm exec vitest run \
  scripts/acceptance-operator-channel.test.ts \
  apps/web/src/app/api/health/route.test.ts \
  apps/web/src/app/api/ready/handler.test.ts
git add \
  tests/e2e/real-canvas.real.spec.ts \
  playwright.real-product.config.ts \
  playwright.persistent-product.config.ts \
  compose.acceptance.yaml \
  scripts/start-real-product-acceptance-stack.sh \
  scripts/with-persistent-product-operator.sh \
  scripts/test-real-canvas-restart.sh \
  scripts/verify-real-agent-deployment.sh \
  artifacts/acceptance/real-canvas/.gitkeep
git commit -m "test(e2e): prepare real agent product acceptance"
test -z "$(git status --short)"
ACCEPTANCE_HARNESS_SHA="$(git rev-parse HEAD)"
git diff --quiet "$RELEASE_SHA"..HEAD -- \
  apps packages services deploy Dockerfile compose.yaml package.json pnpm-lock.yaml
```

Record `ACCEPTANCE_HARNESS_SHA`. Any harness edit after a live run invalidates
that run; recommit and repeat the affected acceptance phase. The harness commit
may descend from `RELEASE_SHA` only because the guarded Runtime/image paths
above are unchanged.

- [ ] **Step 1: Deploy with Run gate closed and verify the exact revision**

Apply migrations, seed, install units, and deploy the immutable image already
built from `RELEASE_SHA`. Before any restart, set the protected Canvas/Worker
environment to:

```text
CANVAS_REAL_RUNTIME_ENABLED=1
CANVAS_MEMORY_POLICY_ENABLED=0
CANVAS_REAL_RUNS_ENABLED=0
CANVAS_FAKE_RUNTIME_ENABLED=0
```

Mark persisted Binding memory capabilities unsupported, then deploy:

```bash
HERMES_RELEASE_SHA="$(
  git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy rev-parse HEAD
)"
test "${#HERMES_RELEASE_SHA}" -eq 40
test -z "$(
  git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy \
    status --short
)"
systemctl --user stop ai-super-canvas.service
test -z "$(ss -ltnH 'sport = :3000')"
bash scripts/set-deployment-gates.sh \
  --real-runtime 1 \
  --memory-policy 0 \
  --real-runs 0 \
  --fake-runtime 0
bash scripts/install-runtime-release.sh \
  --sha "$RELEASE_SHA" \
  --release-root /home/youran/.local/share/ai-super-canvas
DATABASE_INSTANCE_ID="$(
  </home/youran/.local/state/ai-super-canvas/database-instance-id
)"
printf '%s\n' "$DATABASE_INSTANCE_ID" | \
  rg -q '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
MIGRATION_MANIFEST="/home/youran/.local/state/ai-super-canvas/migrations/0011-to-0012-$RELEASE_SHA.json"
install -d -m 0700 \
  /home/youran/.local/state/ai-super-canvas/backups \
  /home/youran/.local/state/ai-super-canvas/migrations
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation ensure-database-only
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation backup \
  --expected-current-head 0011 \
  --target-head 0012 \
  --output "/home/youran/.local/state/ai-super-canvas/backups/pre-0012-$RELEASE_SHA.dump"
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation migrate \
  --expected-head 0012
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation verify \
  --expected-head 0012
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --operation activate-memory-policy \
  --disable \
  --expected-canvas-revision "$RELEASE_SHA"
bash scripts/install-runtime-release.sh \
  --sha "$RELEASE_SHA" \
  --release-root /home/youran/.local/share/ai-super-canvas \
  --worker-env /home/youran/.config/ai-super-canvas/runtime-worker.env \
  --canvas-env /home/youran/.config/ai-super-canvas/ai-super-canvas.env \
  --canvas-image "ai-super-canvas:real-agent-product-$RELEASE_SHA" \
  --canvas-image-id "$IMAGE_ID" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --operator-image-id "$OPERATOR_IMAGE_ID" \
  --install-units-dir /home/youran/.config/systemd/user
systemctl --user daemon-reload
systemctl --user cat ai-super-canvas.service | \
  rg "/home/youran/.local/share/ai-super-canvas/current/compose.yaml"
systemctl --user cat ai-super-canvas.service | \
  rg "WorkingDirectory=/home/youran/.local/share/ai-super-canvas/current"
systemctl --user cat ai-super-canvas-runtime-worker.service | \
  rg "WorkingDirectory=/home/youran/.local/share/ai-super-canvas/current"
systemctl --user enable ai-super-canvas.service
systemctl --user enable --now ai-super-canvas-runtime-worker.service
systemctl --user restart ai-super-canvas-runtime-worker.service
systemctl --user restart ai-super-canvas.service
bash scripts/verify-real-agent-deployment.sh \
  --release-sha "$RELEASE_SHA" \
  --image "ai-super-canvas:real-agent-product-$RELEASE_SHA" \
  --expected-image-id "$IMAGE_ID" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --expected-hermes-revision "$HERMES_RELEASE_SHA" \
  --expect-memory-policy disabled \
  --expect-real-runs disabled
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --migration-manifest "$MIGRATION_MANIFEST" \
  --operation seal-migration \
  --expected-head 0012
```

This is an explicit maintenance window: port 3000 and the Web container stay
down while PostgreSQL remains on the private network. The operator validates a
PostgreSQL-18 backup before migration, and its owner-only migration manifest
resumes only the next legal `backup -> migrate -> verify` phase. Failure keeps
Canvas stopped and gates closed, retains backup/manifest, and never switches
the Canvas unit/image. Restore or restart of the `0011` image is allowed only
after the documented compatibility/restore check. The new pinned unit starts
only after verified head `0012` and disabled memory/Run capability state.

The verification script receives `RELEASE_SHA` explicitly and must fail
unless:

```text
RELEASE_SHA == image label revision == /api/health revision
RELEASE_SHA == Runtime Worker UDS health revision == pinned current checkout
PostgreSQL migration head == 0012
Runtime Worker Socket owner/mode are expected
Jarvis, zzh, nsy safe capability probes pass
no production Fake adapter is registered
127.0.0.1:3000 and 127.0.0.1:8642 are the expected listeners
no new TCP listener exists
```

It also requires `--expected-hermes-revision`; that value must equal the live
Gateway `MainPID` cwd/capability revision, installed drop-in target/checksum,
and both zzh/nsy ACP initialize/describe source revisions. A missing value or
any drift fails closed.

For its temporary authenticated checks, the verifier delegates to
`scripts/with-persistent-product-operator.sh`. That helper validates the
pinned operator tag/ID, production Compose project and recorded
`databaseInstanceId`, starts the operator only on the private network with no
port and `--log-driver=none`, and bind-mounts an owner-only `0600` UDS. The
browser child receives only the Socket and safe instance ID, keeps the pairing
code in memory, completes real `/pair`, then revokes unused code/device Session
and stops the operator. Neither verifier nor child inherits `DATABASE_URL`.

If HEAD is now an evidence/test descendant, it must also prove the
Runtime-affecting path diff from `RELEASE_SHA` is empty using Task 11's exact
path list.

- [ ] **Step 2: Re-activate memory against the final deployed revisions**

Set `HERMES_RELEASE_SHA` to the exact reviewed worktree commit loaded by the
Gateway drop-in. With Runs still disabled:

1. verify the Gateway MainPID imports
   `gateway.platforms.api_server` from that worktree and advertises
   `canvas_memory_policy_v1` with `HERMES_RELEASE_SHA`;
2. verify Worker UDS health is `RELEASE_SHA`, then probe zzh/nsy ACP initialize
   metadata for the same Hermes revision and policy version;
3. perform only non-mutating capability/version handshakes on persistent port
   3000; all positive/negative marker behavior belongs to the disposable 3100
   matrix;
4. atomically set memory enabled while Runs stay disabled, restart Worker plus
   Canvas, and verify the resolved four-gate tuple;
5. run the all-three atomic activator:

```bash
HERMES_RELEASE_SHA="$(
  git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy rev-parse HEAD
)"
test "${#HERMES_RELEASE_SHA}" -eq 40
test -z "$(
  git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy \
    status --short
)"
bash scripts/set-deployment-gates.sh \
  --real-runtime 1 \
  --memory-policy 1 \
  --real-runs 0 \
  --fake-runtime 0
systemctl --user restart ai-super-canvas-runtime-worker.service
systemctl --user restart ai-super-canvas.service
bash scripts/run-database-operation.sh \
  --compose-file "/home/youran/.local/share/ai-super-canvas/releases/$RELEASE_SHA/compose.yaml" \
  --project ai-super-canvas \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  --operation activate-memory-policy \
  --expected-canvas-revision "$RELEASE_SHA" \
  --expected-policy-version 1 \
  --expected-hermes-revision "$HERMES_RELEASE_SHA"
bash scripts/with-persistent-product-operator.sh \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  -- corepack pnpm exec playwright test \
  --config=playwright.persistent-product.config.ts \
  tests/e2e/real-canvas.real.spec.ts \
  --project=chromium \
  --workers=1 \
  --grep '@persistent-catalog'
```

Verify all three persisted capability snapshots contain policy version,
Hermes source revision, verified Canvas release and supported modes, then pair
one temporary admin context and prove the safe Agent DTO exposes the expected
memory controls. Any mismatch disables all three again; do not open Runs.

- [ ] **Step 3: Enable Runs and define the disposable product harness**

First open Runs on the persistent product only after Step 2, restart
Worker/Canvas and require `/api/ready` to report real Runtime, memory and Runs
enabled with Fake disabled. Through a temporary admin pairing Context, use only
the visible `http://127.0.0.1:3000/` canvas to create
`部署验收:<nonce>`, complete one non-private Jarvis Run, and reload to prove
node/transcript/policy persistence. Revoke the temporary device Session but
retain the clearly labeled acceptance node as audit evidence; never delete or
rewrite prior user history. A failure closes both memory and Run gates before
continuing.

```bash
bash scripts/set-deployment-gates.sh \
  --real-runtime 1 \
  --memory-policy 1 \
  --real-runs 1 \
  --fake-runtime 0
systemctl --user restart ai-super-canvas-runtime-worker.service
systemctl --user restart ai-super-canvas.service
bash scripts/verify-real-agent-deployment.sh \
  --release-sha "$RELEASE_SHA" \
  --image "ai-super-canvas:real-agent-product-$RELEASE_SHA" \
  --expected-image-id "$IMAGE_ID" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --expected-hermes-revision "$HERMES_RELEASE_SHA" \
  --expect-memory-policy enabled \
  --expect-real-runs enabled
bash scripts/with-persistent-product-operator.sh \
  --release-sha "$RELEASE_SHA" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --database-instance-id "$DATABASE_INSTANCE_ID" \
  -- corepack pnpm exec playwright test \
  --config=playwright.persistent-product.config.ts \
  tests/e2e/real-canvas.real.spec.ts \
  --project=chromium \
  --workers=1 \
  --grep '@persistent-smoke'
```

The complete empty-canvas journey runs in a disposable product stack from the
exact same immutable Web image and Runtime Worker revision:

```text
CANVAS_REAL_RUNTIME_ENABLED=1
CANVAS_MEMORY_POLICY_ENABLED=1
CANVAS_REAL_RUNS_ENABLED=1
CANVAS_FAKE_RUNTIME_ENABLED=0
```

`scripts/start-real-product-acceptance-stack.sh` is the single orchestration
entrypoint. It takes `--release-sha`, Web and operator image tags plus their
independently captured IDs, `--expected-hermes-revision`, `--port 3100`, then
a child command after `--`.
It creates:

- a nonce Compose project and fresh PostgreSQL volume;
- the production image
  `ai-super-canvas:real-agent-product-$RELEASE_SHA` bound only to
  `127.0.0.1:3100`;
- the profile-only
  `ai-super-canvas:real-agent-operator-$RELEASE_SHA` on the private Compose
  network with no published port and `--log-driver=none`;
- an acceptance-scoped transient Worker from the same pinned release, with a
  private UDS/ledger directory and exact `jarvis-local|zzh|nsy` allowlist.

The operator first proves fresh/empty state, migrates through exactly `0012`,
seeds the random database instance receipt and verifies it before the wrapper
starts the acceptance Worker/Web and activates the same three Bindings; before
that, only PostgreSQL and the one-shot operator run. The wrapper checks both image IDs,
health/Worker/Hermes revisions and zero SessionNodes. It rejects inherited
gate values and supplies exactly
real Runtime `1`, memory `1`, Runs `1`, Fake `0` to both disposable Web and
Worker; health/readiness must report that same tuple. The wrapper only
orchestrates: the exact operator container alone receives the nonce
`DATABASE_URL`, verifies the seed receipt's
`databaseInstanceId`/database name and starts the private acceptance operator
channel. The wrapper and child never receive it and explicitly reject any
inherited value. The child gets only
`CONTROL_PLANE_BASE_URL=http://127.0.0.1:3100` plus the safe nonce/project/unit
handles, operator Socket and safe database instance ID. It rejects port 3000.

Before the child, the wrapper creates the shared private-state `0600` durable
manifest and installs its outer trap. For allowlisted product mutation
requests whose `commandId` is generated by the real UI, Playwright uses
`page.route` only as a transparent pre-dispatch barrier: parse the safe
`commandId` and operation, call the private operator channel's
`record_command`, then `route.continue()` without fulfilling or changing the
body. A record failure aborts the request and fails the test. The child never
opens the manifest.
On cleanup the trap changes it to `cleaning`, resolves exact receipts, calls
`cleanup_acceptance_run` for every terminal Run before
`cleanup_acceptance_session` for every Session, revokes this run's device
Sessions/codes, proves both resource manifests empty, seals it, stops the
transient Worker, and runs `docker compose down -v` for the exact validated
nonce project. A later invocation first resumes any owned unsealed manifest.
It does not invent an acceptance Session-key namespace: every key remains
`canvas:<binding-id>:<canvas-session-id>:<session-generation-key>`. It never
clears or rewrites the user's persistent product database.

Pair three independent Playwright contexts through that stack's real `/pair`
page. The parent uses `acceptance-operator-client.ts` over the private Socket;
the wrapper-side server alone spawns the CLI with its nonce DB environment and
piped stdout. The parent parses each one-use code only in memory and never
invokes free-standing shell commands. Playwright's `finally` closes the three
contexts and requests cleanup; the outer wrapper trap remains authoritative
for normal exit, child failure and signals. User history and unrelated
profile/Gateway Sessions are out of scope.

- [ ] **Step 4: Execute ZZH journey on `/`**

At `1440×1000`:

1. verify default Jarvis and only Jarvis/于途;
2. from an empty Canvas choose “新建对话”, select 于途 on the client draft,
   create the first real Session, and send a real marker prompt;
3. observe visible running/delta/final persisted response;
4. set current project memory and select an 于途 historical Session;
5. verify the selected marker is used;
6. switch to Jarvis and verify a linked new node plus cleared 于途 selection;
7. reload and verify both nodes/history/config;
8. save `zzh-desktop.png`.

- [ ] **Step 5: Execute NSY journey on `/`**

In a separate browser context:

1. verify only Jarvis/乔晶晶;
2. create the first real 乔晶晶 Session from an empty Canvas and complete a Run;
3. select/unselect a 乔晶晶 Session and prove behavior;
4. prove 于途 is absent and direct API use returns 404;
5. reload and save `nsy-desktop.png`.

- [ ] **Step 6: Execute admin journey and narrow-screen journey**

Before screenshots, drive the memory controls from `/` and complete the full
positive/negative marker matrix for Jarvis, 于途 and 乔晶晶:

- `session_only`: current transcript is available, but approved Agent/project
  memory and historical Session markers are absent;
- `agent_project`: an explicitly selected same-Agent Session and an approved
  project marker are available, while an unselected Session, other Agent and
  other project markers are absent;
- `agent_global`: approved global memory for that same Agent is available,
  while other Agent/project markers remain absent;
- unselecting a historical Session and narrowing
  `agent_global -> session_only` take effect on the next Run and remain narrow
  after Worker/Gateway restart; the negative marker must never have been
  echoed into the current Canvas transcript, because visible current-session
  history is intentionally retained;
- a rejected proposal is never written/read; an approved proposal becomes
  visible only inside its declared scope.

Each assertion needs the product-visible result plus safe DB/Worker evidence
of the effective policy/context digest. A model's unsupported self-report is
not evidence.

Admin context:

- sees exactly three Agent names and safe status/capability summaries;
- sees no internal refs in DOM/network JSON.
- cannot see ZZH or NSY Sessions even though all three Accounts share the
  product Workflow and Jarvis grant; direct Session/transcript APIs return the
  same 404 shape as a nonexistent Session.

At `390×844`, complete Agent, memory, Session, send and proposal decision in
the bottom drawer. Stop the Runtime Worker after history loads and prove:

- history remains readable;
- status becomes offline/confirming;
- resend is blocked when result is unknown;
- recovery action is visible and understandable.

Restart Worker and save `admin-desktop.png`, `mobile-normal.png`,
`mobile-recovery.png`.

Separately generate one `commandId`, and have the restart helper arm the
acceptance-only Worker with
`CANVAS_ACCEPTANCE_FAULT_AFTER_ACCEPT_COMMAND_ID=<that exact uuid>`. The
failpoint is one-shot and records consumption before dropping the UDS response
after upstream durable acceptance. Prove the UI enters “正在确认是否已收到”, does
not resend, and reconciliation converges to exactly one upstream Session/Run.
In a `finally` block recreate the acceptance Worker without the fault
variable, require health `faultArmed=false`, inspect the transient unit to
prove the variable is absent, then complete one normal Run through Jarvis,
于途 and 乔晶晶. Merely testing a known-offline Worker does not satisfy this
unknown-delivery gate, and no fault flag may touch the persistent Worker.

- [ ] **Step 7: Run the service restart journey**

The still-running Playwright parent invokes:

```bash
bash scripts/test-real-canvas-restart.sh \
  --acceptance-project "$CANVAS_ACCEPTANCE_PROJECT" \
  --acceptance-worker-unit "$CANVAS_ACCEPTANCE_WORKER_UNIT" \
  web-only
```

The helper records safe Account label, node/session/config/run IDs, service
state, image ID and revision, then restarts only the disposable production Web
container. It never handles browser Cookie/storage state. All three
`browser.newContext()` instances remain alive in the Playwright parent; after
the helper returns, those same in-memory Contexts prove nodes, history, policy
and selected node return and start one new real Run for Jarvis, 于途 and
乔晶晶.

Repeat explicitly for the disposable acceptance Worker:

```bash
bash scripts/test-real-canvas-restart.sh \
  --acceptance-project "$CANVAS_ACCEPTANCE_PROJECT" \
  --acceptance-worker-unit "$CANVAS_ACCEPTANCE_WORKER_UNIT" \
  worker-only
```

Then exercise the existing Jarvis Gateway without restarting Web or the
acceptance Worker:

```bash
bash scripts/test-real-canvas-restart.sh \
  --gateway-unit hermes-gateway.service \
  --expected-hermes-revision "$HERMES_RELEASE_SHA" \
  gateway-only
```

`gateway-only` accepts exactly `hermes-gateway.service`. Before restart it
records a `MainPID > 1`, proves the process cwd is the reviewed Hermes worktree,
proves that cwd is clean and resolves to `HERMES_RELEASE_SHA`, and verifies the
authenticated Canvas capability handshake reports that same revision. It then
uses `systemctl --user restart`, requires a different live `MainPID`, and
repeats the cwd, clean revision, health and authenticated capability checks.
It neither prints the API key nor captures response bodies containing private
state. Any mismatch fails before Playwright resumes.

All three browser Contexts stay alive across every mode. After `gateway-only`,
the `@restart` scenario repeats `agent_global -> session_only` for Jarvis and
the cross-Agent/cross-account negative assertions, then completes one new Run
for Jarvis, 于途 and 乔晶晶. The final `--grep '@restart|@fault'` gate therefore
executes the Gateway proof rather than relying on narrative evidence.

Expected: no Fake, no Binding/profile mix-up, no lost history.

- [ ] **Step 8: Run real E2E directly**

`playwright.real-product.config.ts` targets only the wrapper-provided
`http://127.0.0.1:3100`, has no `webServer` block, rejects port 3000, and
checks the health revision plus zero-node gate before tests.
Trace, video, network bodies and storage-state artifacts are disabled for this
suite. Pairing codes are piped only with `--allow-non-tty`, retained in the
parent Playwright process memory, and every token/session is revoked in
`finally`.

```bash
bash scripts/start-real-product-acceptance-stack.sh \
  --release-sha "$RELEASE_SHA" \
  --image "ai-super-canvas:real-agent-product-$RELEASE_SHA" \
  --expected-image-id "$IMAGE_ID" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --expected-hermes-revision "$HERMES_RELEASE_SHA" \
  --port 3100 \
  -- corepack pnpm exec playwright test \
  --config=playwright.real-product.config.ts \
  tests/e2e/real-canvas.real.spec.ts \
  --project=chromium \
  --workers=1
```

Expected: every real product assertion passes. Agent self-reported identity is
not accepted as routing evidence. This is the product `/` from the immutable
production image with real Agents and a fresh database; `/control-plane-test`
is never visited.

- [ ] **Step 9: Seal the safe artifact index**

```bash
git diff --check
test "$ACCEPTANCE_HARNESS_SHA" = "$(git rev-parse HEAD)"
test -z "$(git status --short --untracked-files=no)"
```

Only the explicitly allowlisted screenshots and non-secret result index may
remain for Task 13's evidence commit. Do not commit browser
Cookie/storage-state files. Any source/harness diff returns to Step 0.

---

### Task 13: Synchronize operations truth and acceptance evidence

**Files:**

- Modify: `README.md`
- Modify: `docs/deployment/linux-nas-docker.md`
- Create:
  `docs/acceptance/2026-07-27-real-canvas-product-acceptance.md`
- Modify: `/home/youran/data/agent-architecture.md`
- Modify: `/home/youran/data/service-ports.md`
- Modify: `/home/youran/data/service-ports.json`

- [ ] **Step 1: Document the product, not the diagnostic page**

README/deployment docs must state:

- entry is `/`;
- how to pair a device;
- authorized Agent matrix;
- three memory modes and proposal semantics;
- Worker Socket architecture and service names;
- read-only behavior when Runtime is down;
- no Fake fallback;
- backup/migration/restart/rollback commands;
- formal local device pairing/revocation through the pinned
  `run-database-operation.sh --operation pair|revoke-*` entrypoint, with exact
  operator ID, release and `databaseInstanceId`; only an interactive TTY may
  display a one-use code, while automated acceptance uses the private UDS and
  never prints it;
- `/control-plane-test` is diagnostic only.

- [ ] **Step 2: Update Hermes architecture and both port inventories**

`agent-architecture.md` must record:

- Web → protected UDS → Runtime Worker;
- Worker → Jarvis loopback and profile ACP;
- exact `jarvis-local|zzh|nsy` allowlist;
- Canvas DB vs native Hermes memory ownership;
- per-Agent/session namespace and request memory policy;
- systemd dependencies and failure behavior.

No new persistent TCP port is added. Update both `service-ports.md` and
`service-ports.json` together to record:

- Canvas remains `127.0.0.1:3000`;
- Jarvis remains `127.0.0.1:8642`;
- `127.0.0.1:3100` is reused only serially by the identity wrapper, memory
  wrapper, mock-product `next start`, and real-product wrapper; none is enabled
  at boot or allowed to overlap;
- Playwright `webServer` owns and reaps the mock listener, while each real
  wrapper's outer trap stops its private Worker and runs its validated nonce
  `docker compose down -v`;
- Runtime Worker uses a Unix Socket and adds no TCP listener;
- verification date, exact start/stop commands, owner/purpose and listener
  evidence before, during and after every 3100 phase, including proof that the
  port is closed before the next phase.

- [ ] **Step 3: Define the final evidence schema**

Before final gates, define the report/manifest template only; do not seal or
claim final counts yet. The completed evidence must include:

- exact Canvas `RELEASE_SHA`, image ID/label, Web health and Worker health
  revision;
- exact operator image ID/label, safe `databaseInstanceId`, migration manifest
  terminal phase and owner-only backup path/checksum without backup contents;
- exact `HERMES_RELEASE_SHA`, live Gateway `MainPID` cwd and installed drop-in
  checksum;
- every command, exit code, file count and test count;
- desktop/narrow-screen screenshot paths;
- three Account/Agent safe routing evidence;
- memory marker matrix;
- restart before/after evidence;
- listener, service, container and database evidence;
- failure/recovery proof;
- current untested boundaries and rollback trigger.

Also write the non-secret machine-readable
`artifacts/acceptance/real-canvas/release-manifest.json` with exact
`releaseSha`, `webImageId`, `operatorImageId`, `hermesReleaseSha`,
`databaseInstanceId`, migration from/to/phase/backup checksum, four gate
booleans, persistent/disposable acceptance result IDs,
`acceptanceHarnessSha` and the evidence commit's parent SHA.
Validate its schema and cross-check every value against live evidence. It must
contain no endpoint/secret/external Runtime ref, Cookie, pairing code, marker
content or private transcript.

- [ ] **Step 4: Run final gates**

```bash
docker build --target test \
  --build-arg APP_REVISION="$RELEASE_SHA" \
  --tag ai-super-canvas:product-final .
docker run --rm ai-super-canvas:product-final lint
docker run --rm ai-super-canvas:product-final typecheck
docker run --rm ai-super-canvas:product-final test
COMPOSE_PROJECT_NAME=ai-super-canvas-product-final \
  bash ./scripts/test-integration.sh
bash scripts/test-product-mock-e2e.sh
bash scripts/verify-real-agent-deployment.sh \
  --release-sha "$RELEASE_SHA" \
  --image "ai-super-canvas:real-agent-product-$RELEASE_SHA" \
  --expected-image-id "$IMAGE_ID" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --expected-hermes-revision "$HERMES_RELEASE_SHA" \
  --expect-memory-policy enabled \
  --expect-real-runs enabled
bash scripts/start-real-product-acceptance-stack.sh \
  --release-sha "$RELEASE_SHA" \
  --image "ai-super-canvas:real-agent-product-$RELEASE_SHA" \
  --expected-image-id "$IMAGE_ID" \
  --operator-image "ai-super-canvas:real-agent-operator-$RELEASE_SHA" \
  --expected-operator-image-id "$OPERATOR_IMAGE_ID" \
  --expected-hermes-revision "$HERMES_RELEASE_SHA" \
  --port 3100 \
  -- corepack pnpm exec playwright test \
  --config=playwright.real-product.config.ts \
  tests/e2e/real-canvas.real.spec.ts \
  --project=chromium \
  --workers=1 \
  --grep '@restart|@fault'
git diff --check
```

Expected: every command exits 0.

Only now write/finalize the report, `result-index.json` and
`release-manifest.json` from the just-completed command outputs. Record every
final command, exit code and test count, set migration phase from the sealed
owner-only manifest, cross-check live provenance, then run:

```bash
jq -e ".releaseSha and .webImageId and .operatorImageId and .hermesReleaseSha" \
  artifacts/acceptance/real-canvas/release-manifest.json
jq -e ".acceptanceHarnessSha and .persistentResultId and .disposableResultId" \
  artifacts/acceptance/real-canvas/release-manifest.json
if rg -n "API_SERVER_KEY=|Authorization: Bearer|Cookie:|pairingCode|externalSessionRef|externalRunRef" \
  docs/acceptance/2026-07-27-real-canvas-product-acceptance.md \
  artifacts/acceptance/real-canvas; then
  exit 1
fi
git diff --check
```

Any failure or missing final count returns to the relevant gate; never publish
the pre-gate template as completed evidence.

- [ ] **Step 5: Commit repository documentation**

```bash
git add \
  README.md \
  docs/deployment/linux-nas-docker.md \
  docs/acceptance/2026-07-27-real-canvas-product-acceptance.md \
  artifacts/acceptance/real-canvas/release-manifest.json \
  artifacts/acceptance/real-canvas/result-index.json \
  artifacts/acceptance/real-canvas/zzh-desktop.png \
  artifacts/acceptance/real-canvas/nsy-desktop.png \
  artifacts/acceptance/real-canvas/admin-desktop.png \
  artifacts/acceptance/real-canvas/mobile-normal.png \
  artifacts/acceptance/real-canvas/mobile-recovery.png
git commit -m "docs: record real canvas product acceptance"
test -z "$(git status --short)"
```

External systemd and `/home/youran/data` files are verified separately and are
not committed to this repository.

---

## Rollback procedure

Rollback does not delete user data and never restores the Demo:

1. use `scripts/set-deployment-gates.sh` to atomically set the shared tuple to
   `1,0,0,0`;
2. restart Runtime Worker and Canvas, then verify both resolved environments
   plus `/api/ready` report memory/Run writes closed and Fake closed;
3. verify `/` remains readable and new Composer submissions are disabled;
4. leave Jarvis/profile services unchanged unless they are the
   source of the incident;
5. restore the previously tagged Canvas/operator images only after checking
   their database migration compatibility and immutable IDs;
6. keep PostgreSQL, Session, Message, Run, ContextRef and proposal history;
7. record the incident and the exact cross-account/Agent/project condition.

Immediate rollback triggers:

- any unauthorized Agent becomes visible or runnable;
- any cross-Agent/profile/project marker is readable;
- Agent switch reuses an old external Session;
- unknown delivery produces a duplicate Run/tool side effect;
- real Runtime failure invokes Fake;
- `session_only` reads long-term memory;
- browser/log/database payload reveals secret or internal Runtime ref;
- restart restores a Session under the wrong Agent or policy.

## Product Definition of Done

This plan is complete only when all of the following are true:

- `/` is the real spatial Canvas and no longer the Demo;
- ZZH, NSY and admin complete their own real paired browser journeys;
- Jarvis, 于途 and 乔晶晶 each complete a real Run from the Canvas;
- all memory modes, historical Session selection and proposal decisions work;
- Agent/account/project/profile isolation is proven with negative markers;
- Agent switch produces a linked new node and preserves the old node;
- refresh, Canvas restart and Worker restart recover safely;
- desktop and 390×844 screenshots exist;
- revision, listeners, services, database and Runtime evidence agree;
- operations documents and both port inventories are current;
- rollback remains available without deleting data.

Only after this list is satisfied may the implementation handoff say
“现在能用”。

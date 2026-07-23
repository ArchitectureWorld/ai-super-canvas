# 服务器持久化 Session 纵切设计规格

- 日期：2026-07-23
- 状态：**Proposed / 等待 PR 审阅**
- 基线提交：`7ee476a`
- 目标阶段：S1 控制面闭环，为 S3 真实 Chat SessionNode 提供可运行入口
- 关联设计：[`2026-07-18-control-plane-test-vertical-slice-design.md`](./2026-07-18-control-plane-test-vertical-slice-design.md)

## 1. 决策摘要

下一开发阶段先完成一个与现有 localStorage 画布隔离的服务器持久化 Session 纵切：

```text
/control-plane-test
  -> Next.js Route Handlers
    -> Control Plane application service
      -> PostgreSQL repository
      -> DeterministicFakeRuntime
```

用户必须能够在浏览器中初始化本地 Alpha、创建 Session、发送消息、看到 FakeRuntime 回复，并在刷新后从 PostgreSQL 恢复同一 transcript。

本纵切不直接接 Hermes，不重写现有画布，不实现 World Canvas，也不复制已经完成的数据库、领域或 Runtime 契约工作。

## 2. 当前代码事实

截至基线提交，仓库已经具备：

- Agent、Session、Run 和状态转换领域契约；
- `RuntimeAdapter` 与 `DeterministicFakeRuntime`；
- `ControlPlaneRepository` 与 `PostgresControlPlaneRepository`；
- root/anchored/fork Session 准备、Run 准备、dispatch phase、Runtime ref attach、事件摄取、transcript/snapshot 读取和 reconciliation 持久化；
- 164 个单元/契约测试和 72 个 PostgreSQL 集成测试；
- 隔离的 Docker 集成环境、生产构建和 CI 安全门槛。

仍然缺少：

- `packages/control-plane` application service；
- `SessionService` 和唯一的 `RunEventPump`；
- `apps/web/src/server` 服务端依赖组合；
- bootstrap、Session、Run、事件和 transcript HTTP 接口；
- 数据库 readiness 接口；
- `/control-plane-test` 页面；
- 浏览器到 PostgreSQL 的 Golden Path 与刷新/服务重启证据。

当前 `/` 页面继续把业务数据保存在 localStorage；这不是本纵切的事实源。

## 3. 方案选择

### 方案 A：先完成服务器纵切（采用）

先以 FakeRuntime 打通服务、API、数据库和浏览器，再把同一契约用于现有画布和 Hermes。

优点：故障边界清楚；数据可恢复；后续 UI 和 Runtime 都能复用。

### 方案 B：先接 Hermes（拒绝）

会同时引入外部 Worker、协议、模型、网络和持久化问题，无法清楚判断故障属于哪一层。

### 方案 C：先做 World Canvas（延后）

只读种子投影可以后续验证，但正式门户和关系依赖服务器事实源、权限、Artifact 和 Proposal。本纵切不得被顶层视觉工作打断。

## 4. 范围和边界

### 4.1 本轮包含

- root Session 的创建和 Runtime Session attach；
- 单条用户消息触发单个 Run；
- FakeRuntime 事件持续写入 PostgreSQL；
- transcript、活动 Run 和 reconciliation 状态读取；
- 持久化事件的增量读取；
- 浏览器刷新恢复；
- 服务重启后的历史读取和 Runtime 不可用提示；
- server-owned ActorContext、模型和工具策略；
- 数据库 readiness；
- 单元、Route 合约、PostgreSQL 集成和浏览器 E2E。

### 4.2 本轮不包含

- Hermes、Letta 或真实模型调用；
- anchored fork、message fork、取消和工具审批 UI；
- 把现有 `/` 画布切换到服务器事实源；
- localStorage v1 数据导入；
- Artifact、Proposal、主干回流或 WorldRelation；
- 多账号认证、共享 Workspace 或生产 secret 管理；
- 新增正式 `Project` 聚合；
- 新端口或新部署服务。

## 5. 组件设计

### 5.1 `packages/control-plane`

这是 application layer，只依赖 `@ai-super-canvas/core`、`@ai-super-canvas/ai` 和 Repository 接口，不依赖 React、Next.js 或具体 SQL。

职责拆分：

- `runtime-event-mapper.ts`：穷尽映射 `RuntimeEvent` 到 `PersistableRunEvent`；
- `run-event-pump.ts`：每个 Run 只允许一个事件消费者，负责持续摄取和终态检查；
- `session-service.ts`：编排 Session 创建、Run 启动、Runtime ref 持久化和重启可用性检查；
- `dto.ts`：定义 web/API 可以依赖的稳定 application DTO；
- `errors.ts`：定义稳定 application error code；
- `index.ts`：仅导出公开接口。

`SessionService` 不直接执行 SQL；所有权威状态变化必须经 Repository。

### 5.2 `apps/web/src/server`

`control-plane.ts` 是 server-only composition root，负责创建并复用：

- `PostgresControlPlaneRepository`；
- `DeterministicFakeRuntime`；
- `RunEventPump`；
- `SessionService`。

本地 Alpha 的 `authSubject` 来自服务端配置 `APP_OWNER_SUBJECT`。请求体中的 `accountId`、`authSubject`、模型或工具策略一律不作为授权输入。

V0.1 部署约束为单 web 进程。composition root 在开发热重载中通过 `globalThis` 保持进程内单例，`RunEventPump` 用进程内 active-Run 注册表拒绝第二个消费者。多副本部署需要数据库租约或专用 worker，在另一个规格中设计；本纵切不得把进程内互斥宣称为多副本安全。

服务继续使用当前默认的 loopback 绑定；本地 Alpha Route 不应在未加入正式认证前暴露到公网或不受信任 LAN。

### 5.3 Route Handlers

Route 只负责：解析请求、验证 schema、解析服务端 ActorContext、调用 application service、把稳定错误映射成 HTTP。Route 不复制业务状态机。

### 5.4 `/control-plane-test`

页面与现有 `/` 原型隔离。它只在 localStorage 保存：

- 最后一个 `sessionId`；
- 尚未确认结果的 `commandId` / `idempotencyKey`；
- 非权威的页面显示偏好。

页面不得在 localStorage 保存 transcript、RunEvent、assistant 回复、账号、模型或工具策略。

## 6. API 合约

```text
POST /api/control-plane/bootstrap
  body: { commandId, displayName? }
  200: { accountId, agentId, agentBindingId, workspaceId, workflowId, trunkRevisionId }

POST /api/control-plane/sessions
  body: { commandId, workflowId, agentBindingId, title }
  201: { sessionId, nodeId, status }

POST /api/control-plane/sessions/:sessionId/runs
  body: { commandId, idempotencyKey, content }
  202: { runId, status }

GET /api/control-plane/runs/:runId/events?after=0
  200: { events, nextAfter, terminal: null | { status: "succeeded" | "failed" | "cancelled" } }

GET /api/control-plane/sessions/:sessionId/transcript
  200: { sessionId, messages, activeRun, reconciliationState, runtimeAvailability: "available" | "unavailable" }

GET /api/ready
  200: { status: "ready", database: "ready" }
  503: { status: "not-ready", database: "unavailable" }
```

V0.1 事件接口读取 PostgreSQL 中已经持久化的事件，不直接消费 Runtime stream。客户端重复请求 `after=lastSequence`，直到收到终态。这里采用短轮询 JSON，不在第一版引入长期 SSE 连接；以后可以在不改变 application service 的前提下替换传输层。`reconciliationState` 为 `null`，或 `{ kind: "run-reconciling" | "runtime-unavailable", message: string }`。readiness 使用受限应用账号执行带短超时的 `SELECT 1`，不调用 Runtime，也不把 liveness 和 readiness 混成同一接口。

## 7. 一次完整操作的数据流

1. 页面生成 bootstrap `commandId`，先保存 pending ID，再请求 bootstrap。
2. 服务端使用稳定 `APP_OWNER_SUBJECT` 创建或读取本地 Alpha 资源。
3. 页面用返回的 `workflowId` 和 `agentBindingId` 创建 root Session。
4. Repository 先写 `canvas_prepared`；Service 获得 dispatch 租约后调用 `RuntimeAdapter.createSession`。
5. Service 先记录已知外部 Session ref，再 attach 到 Canvas Session。
6. 用户发送消息；页面保存 `commandId` 和 `idempotencyKey` 后请求创建 Run。
7. Repository 原子写用户 Message、Run 和命令收据。
8. Service 调用 `RuntimeAdapter.startRun`，先持久化外部 Run ref，再 attach。
9. `RunEventPump` 作为唯一消费者调用 `streamRunEvents`，把每个事件通过 Repository 原子投影为 RunEvent、assistant Message 和 Run 终态。
10. 页面轮询已持久化事件和 transcript，直到 Run 终态。
11. 页面刷新后只用保存的 `sessionId` 请求 PostgreSQL snapshot，不从浏览器恢复聊天内容。

## 8. 幂等、并发和 reconciliation

- 所有写请求必须携带 UUID `commandId`；Run 额外携带独立 `idempotencyKey`；
- 请求发出前保存 ID，只有得到确定结果才清除；网络重试复用原 ID；
- 同一 commandId + 同一 payload 返回原结果；不同 payload 返回 `409`；
- Runtime dispatch 只能在 Repository phase 授予租约后发生；
- Runtime 明确 `not-applied` 时进入可重试失败；
- Runtime 结果可能已经生效但客户端未确认时进入 `reconciling`，不得盲目再次 dispatch；
- 外部 Session/Run ref 必须先记录，再 attach；
- 一个 Session 同时只允许一个活动 Run；
- 一个 Run 同时只允许一个 `RunEventPump`；
- 同 eventId 重放只持久化一次；内容相同但 eventId 不同的事件必须全部保留；
- Runtime stream 无终态结束时，Run 必须进入 `reconciling`。

## 9. 错误映射

| 场景 | HTTP | 用户表面状态 |
| --- | --- | --- |
| 非法 JSON、UUID 或 schema | 400 | 校验失败 |
| command/payload 或 active Run 冲突 | 409 | 冲突，可刷新当前状态 |
| 未授权或资源不可见 | 404 | 不泄露资源是否存在 |
| dispatch 结果未知 | 202 | 需要对账，保留 commandId |
| 数据库未就绪 | 503 | 服务暂不可用，可重试 |
| 内部错误 | 500 | 稳定错误码，不返回堆栈、SQL 或 Runtime ref |

日志可以记录关联 ID 和内部诊断，但不得记录 secret、完整工具输入或未脱敏的私有上下文。

所有错误响应使用稳定结构：

```text
{ error: { code, message, retryable }, commandReceiptId? }
```

## 10. 刷新与服务重启语义

- 浏览器刷新：从 PostgreSQL 恢复 Session、Message、RunEvent 和 Run 状态；
- web 服务重启：历史仍可读取；
- `DeterministicFakeRuntime` 是进程内 Runtime，重启后旧 external Session ref 不可续跑；
- Service 必须探测该事实，并把旧 Session 标为历史可读、Runtime 不可用；
- 页面提供“新建测试 Session”，不能把不可续跑状态伪装成成功恢复；
- 本纵切不宣称 in-flight Run 可以跨进程恢复。

## 11. 测试设计

### 11.1 application 单元测试

- root Session 只 dispatch 一次；
- Runtime ref 记录早于 attach；
- `not-applied` 和 `unknown` 走不同 phase；
- 一个 Run 只有一个事件泵；
- 事件映射穷尽；
- stream 无终态进入 reconciliation；
- 异步泵错误被捕获，不产生未观察 Promise。

### 11.2 Route 合约测试

- server-owned ActorContext；
- 非法 JSON、UUID 和 path/body mismatch；
- idempotency conflict、active Run conflict 和 404 隐藏；
- 事件分页边界；
- readiness 的 200/503；
- 错误响应不泄露内部引用。

### 11.3 PostgreSQL Golden Path

从空数据库开始：bootstrap -> root Session -> Run -> FakeRuntime 事件 -> assistant Message -> succeeded -> 重建 Repository/Service -> 读取相同 transcript。

必须继续覆盖并发、重复命令、重复事件和 reconciliation。

### 11.4 浏览器 E2E

- 初始化、创建 Session、发送消息、看到确定性回复；
- 刷新后显示相同 transcript；
- 重复点击或网络重试不重复创建 Run；
- 服务重启后历史可读且 Runtime 不可用提示正确；
- 现有 `/` 原型 Golden Path 不回归。

## 12. PR 交付边界

每个完成项都通过独立 PR 交付，不直接写 main：

1. **设计 PR（本文件）**：确认范围、边界和验收；
2. **Application PR**：新增 `packages/control-plane`、SessionService、RunEventPump 和单元测试；
3. **API PR**：新增 server composition、Route Handlers、readiness 和 Route 合约测试；
4. **Test Page PR**：新增 `/control-plane-test`、客户端状态机和页面测试；
5. **Golden Path PR**：补齐数据库支持的完整纵切、浏览器 E2E、重启语义和执行证据文档。

每个 PR 都必须：

- 基于最新 main；
- 只包含本 PR 负责的边界；
- 先写失败测试，再实现；
- 通过 lint、typecheck、相关单元/集成测试和 build；
- 等 GitHub required checks 通过后才申请合并；
- 合并后删除远端分支，再开始下一个 PR。

现有画布迁移、Hermes spike 和 World Canvas 分别使用后续独立规格与 PR，不塞进本纵切。

## 13. 完成定义

只有以下全部由自动化证据证明，本纵切才完成：

- 用户可以从浏览器创建服务器 Session 并发送消息；
- PostgreSQL 中存在对应用户 Message、assistant Message、Run 和有序 RunEvent；
- FakeRuntime 回复通过 application service 持久化，不由页面伪造；
- 刷新后 transcript 与数据库一致；
- 服务重启后历史仍可读，旧 FakeRuntime ref 被如实标为不可用；
- 重复请求不产生重复 Session、Run、Message 或 Runtime dispatch；
- ActorContext、模型和工具策略不能由浏览器覆盖；
- reconciliation 不会盲目重试未知外部效果；
- `/api/ready` 真实检查数据库；
- 现有画布不回归；
- lint、typecheck、unit、PostgreSQL integration、build 和目标 E2E 全部通过；
- 不新增端口、服务或生产 secret；
- 所有阶段都通过独立 PR 交付。

## 14. 与旧计划和 World Canvas 的关系

[`2026-07-18-control-plane-test-vertical-slice.md`](../plans/2026-07-18-control-plane-test-vertical-slice.md) 保留历史设计和实现细节，但其勾选状态不能代表当前代码完成度。新的实施计划必须从当前代码反向核对，只规划尚未存在的 application、API、页面和 E2E 工作。

World Canvas 仍是产品顶层方向，但正式项目门户必须读取服务器事实源。本纵切完成前，不把 localStorage 项目副本包装成正式 World Canvas 数据源。

## 15. 审阅门槛

本规格经用户在 PR 中确认后，才编写逐文件、逐测试、逐提交的实施计划。未获确认前不进入代码实现。

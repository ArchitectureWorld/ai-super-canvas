# Control Plane 真实后端测试纵切设计

## 决策

在不改动现有结构化生长画布的前提下，新增一条独立、可在浏览器直接操作的真实后端纵切：

```text
/control-plane-test
→ Next.js API
→ Control Plane 应用服务
→ PostgreSQL + DeterministicFakeRuntime
→ Runtime 事件持久化并投影为消息
→ 页面轮询已持久化结果
→ 刷新后从 PostgreSQL 恢复
```

该纵切的目标不是扩大产品功能面，而是证明现有 Session 控制平面骨架能够真正完成一次“创建、运行、落库、回读”的闭环。现有画布继续使用 `localStorage`，直到这条后端 Golden Path 通过。

## 当前基线与缺口

当前已经具备：

- `packages/ai` 的 Runtime Adapter 合约与 `DeterministicFakeRuntime`；
- `packages/db` 的 PostgreSQL schema、迁移和 `PostgresControlPlaneRepository`；
- 本地 Alpha bootstrap、Session 创建、Runtime Session dispatch/attach、授权读取和 transcript 读取能力；
- 现有浏览器画布及其稳定的本地 Golden Path；
- Docker Compose 中的应用和 PostgreSQL 服务。

当前尚未具备：

- Run 创建、Runtime Run attach、RunEvent 去重入库和终态投影所需的 Repository 接口；
- 位于 Repository 与 API 之间的 Control Plane 应用服务；
- Runtime 事件泵；
- Control Plane API；
- 面向用户的真实后端测试入口；
- 浏览器刷新后从 PostgreSQL 回读真实会话的路径。

因此，本次不能通过“给现有页面加一个按钮”完成，必须先补齐 Run 与事件的后端主链。

## 方案比较

### 方案 A：正规的最小纵切（采用）

补齐 Repository 的 Run/事件能力，新增独立的 `packages/control-plane`，再通过 API 暴露给 `/control-plane-test`。

优点是边界清楚、数据真实落库、错误可以正确补偿，后续替换 Runtime 实现时无需重写页面和业务编排。代价是需要同时完成 Repository、服务、API 和页面四层，但这些工作都直接属于最终架构。

### 方案 B：Next.js Route 直接编排数据库与 Runtime（拒绝）

在 API Route 中直接调用 Repository 和 Fake Runtime，可以更快看到页面回复，但 Runtime dispatch、attach、事件去重和补偿逻辑会散落在 HTTP 层。后续增加其他入口或替换 Runtime 时必须重构，且很难证明幂等性。

### 方案 C：直接替换现有画布的数据源（本次拒绝）

把现有分支和消息交互一次性切换到后端，用户界面变化最直接，但会同时引入旧 WorkspaceState 投影、Session 图、Run、事件和布局状态迁移，风险与本次“先验证闭环”的目标不匹配。

## 组件边界

### `packages/db`

Repository 是 PostgreSQL 的唯一访问边界。本次补充最小 Run/事件能力：

- 在 Runtime I/O 之前原子创建用户 Message、Run 和命令收据；
- 给一次 Run dispatch 发放唯一租约；
- 先记录已知的 Runtime Run ref，再完成 Canvas Run attach；
- 以 Runtime `eventId` 去重写入 RunEvent；
- 在同一事务中完成事件写入、assistant Message 投影和 Run 终态迁移；
- 查询授权后的 RunEvent 和 Session transcript；
- 在流提前结束、attach 结果未知或服务恢复时标记 `reconciling`；
- 已 attach 的相同命令重试直接返回已存结果，不再次调用 Runtime。

浏览器提供的账号、模型、工具策略或 Runtime ref 都不能进入这些接口的信任边界。

### `packages/control-plane`

新增 `SessionService` 和 `RunEventPump`：

- `SessionService.bootstrapLocalAlpha` 创建或读取本地账号、默认 Agent、Fake Binding、Workspace 和 Workflow；
- `SessionService.createRootSession` 编排 Canvas Session 与 Runtime Session 的创建和挂接；
- `SessionService.startRun` 从 Repository 获取授权后的 Session Runtime Context，创建 Run，调用 Fake Runtime，并启动事件泵；
- `RunEventPump` 是唯一 Runtime→Canvas 事件摄取执行器；
- 每个 Run 同时最多存在一个内部消费者；
- 泵自身捕获异步异常，不产生未观察的 Promise；
- 流结束却没有终态时，Run 进入 `reconciling`。

服务层不包含 HTTP、React 或具体 PostgreSQL 查询。

### `apps/web` 服务端

`apps/web/src/server/control-plane.ts` 只在服务端创建并持有：

- `PostgresControlPlaneRepository`；
- `DeterministicFakeRuntime`；
- `RunEventPump`；
- `SessionService`。

本地 Alpha 使用稳定的 `APP_OWNER_SUBJECT` 解析 ActorContext。ActorContext 必须由服务端注入，请求 JSON 中即使出现 `accountId` 或 `authSubject` 也不会被采用。

### `/control-plane-test` 页面

这是与现有画布隔离的测试页，包含：

- 当前后端、数据库、Runtime 状态；
- 初始化本地环境按钮；
- 创建 Session 按钮；
- 消息输入框与发送按钮；
- Run 状态和事件序列；
- 从 PostgreSQL 读取的完整 transcript；
- 清晰的错误与 `reconciling` 提示；
- “新建测试 Session”入口。

页面可以在 `localStorage` 中保存最后一个 `sessionId` 和尚未完成请求的 `commandId`，但不得保存 transcript、RunEvent 或 AI 回复。刷新后必须通过 API 从 PostgreSQL 回读真实数据。

## API 合约

本次只暴露闭环必需的接口：

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
  200: text/event-stream
  返回所有 sequence > after 的已持久化事件，然后关闭连接

GET /api/control-plane/sessions/:sessionId/transcript
  200: { sessionId, messages, activeRun, reconciliationState }
```

事件读取接口只读取 PostgreSQL，不直接消费 Runtime 流。页面记录最后一个事件 sequence 并重复请求，直到收到终态；Runtime→PostgreSQL 的持续摄取完全由 `RunEventPump` 负责。

## 一次完整操作的数据流

1. 页面生成并保存 bootstrap `commandId`，调用 bootstrap API。
2. 服务端以稳定 auth subject 原子创建或读取本地 Alpha 资源。
3. 页面生成 Session `commandId`，创建 Canvas Session。
4. Repository 先保存 `canvas_prepared`，获得 dispatch 租约后，Service 调用 Fake Runtime 创建 Runtime Session。
5. Service 先记录外部 ref，再把它 attach 到 Canvas Session；attach 成功后 Session 可运行。
6. 用户输入消息。页面生成并保存 Run `commandId` 与 `idempotencyKey`。
7. Repository 原子写入用户 Message、Run 和命令收据，Service 再调用 Runtime `startRun`。
8. Runtime Run ref attach 成功后，事件泵开始消费确定性事件。
9. 每个事件由 Repository 单事务完成去重、RunEvent 写入、assistant Message 投影和必要的 Run 状态迁移。
10. 页面轮询已持久化事件与 transcript，显示完成后的 AI 回复。
11. 页面刷新时只从本地找到最后一个 Session 指针，实际内容全部从 PostgreSQL 重新加载。

## 幂等、并发与补偿

- 每个有副作用的请求必须包含 UUID `commandId`；Run 还包含独立的 `idempotencyKey`。
- 页面在请求发出前保存 commandId；只有收到确定结果后才清除 pending command，网络重试沿用同一 ID。
- 相同 commandId + 相同 payload 返回原结果；相同 commandId + 不同 payload 返回冲突。
- Runtime dispatch 必须由 Repository 中的命令收据阶段机授予，API 或 Service 不能自行猜测是否可以重发。
- Runtime 明确报告 `not-applied` 时可记录可重试失败；任何可能已生效的网络或 attach 异常都进入 `reconciling`。
- 已知外部 ref 必须先持久化，再尝试 attach。
- 一个 Session 同时只允许一个活动 Run；一个 Run 同时只允许一个事件消费者。
- 相同事件内容但不同 eventId 必须保留为两条事件；相同 eventId 重放只落一次。

## 错误映射

- 非法 JSON 或 schema 校验失败：`400`；
- commandId payload 冲突或路径/body 不一致：`409`；
- 未授权与资源不存在统一返回 `404`，避免泄露资源是否存在；
- 命令结果未知且需要对账：`202`，返回 `commandReceiptId`、状态和 `Retry-After`；
- 服务器内部错误：返回不含数据库、Runtime ref 和堆栈的稳定错误结构，同时在服务日志保留诊断信息。

测试页必须把“校验失败”“处理中”“需要对账”“Runtime 已丢失”和“完成”显示为不同状态，不能把所有失败折叠成一个弹窗。

## 刷新与进程重启语义

本次必须证明浏览器刷新后，Session、用户消息、RunEvent 和 AI 回复仍能从 PostgreSQL 恢复。

`DeterministicFakeRuntime` 是进程内实现，并明确声明 Runtime Session 不持久化。因此：

- 浏览器刷新但服务进程未重启：可以继续同一个 Session；
- 服务进程重启：历史 transcript 仍可读取和展示；
- 服务进程重启后，旧 Fake Runtime ref 不得伪装为可继续使用；页面要提示新建测试 Session；
- 本次不宣称 Runtime 进程重启恢复能力。

## 测试策略

实现遵循 TDD，每一层先写失败测试：

1. Repository PostgreSQL 集成测试：Run 准备、dispatch、attach、事件去重、消息投影、终态、回滚和授权。
2. Control Plane 单元测试：Session 创建补偿、Run 调度、单事件泵、流失败和重试不重复调用 Runtime。
3. API 合约测试：服务端身份、非法请求、冲突、授权、SSE replay 和 `reconciling` 映射。
4. 数据库支持的 Golden Path：从空数据库 bootstrap，创建 Session，运行 Fake Run，读取持久化事件和 transcript。
5. Playwright：进入测试页，初始化，创建 Session，发送消息，看到确定性回复，刷新并看到相同 transcript。
6. 生产验证：lint、typecheck、完整测试、生产构建、Docker Compose 健康检查。

## 完成定义

只有同时满足以下条件才算本纵切完成：

- 用户能够在浏览器中独立完成初始化、创建 Session、发送消息和收到 AI 回复；
- 页面显示的数据与 PostgreSQL 中的 Session、Run、RunEvent 和 Message 一致；
- 刷新后 UI 从 API 恢复相同 transcript；
- 重复请求不产生重复 Runtime Session、Run、事件或消息；
- 浏览器不能覆盖服务端 ActorContext、模型或工具策略；
- Runtime/attach 结果未知时不会盲目二次 dispatch；
- 现有画布 Golden Path 不回归；
- lint、typecheck、单元测试、PostgreSQL 集成测试、生产构建和 Playwright 全部通过；
- 使用现有应用端口，不新增或修改主机端口。

## 非目标

本次不实现：

- 把现有结构化生长画布切换到 PostgreSQL；
- 锚点 Session、消息 Fork、Run 取消和审批；
- 旧 `WorkspaceState v1` 导入；
- 真实外部模型调用；
- 多用户认证和协作；
- Runtime 进程重启后的旧 Session 续跑；
- 新增端口、服务或部署拓扑。

这些能力继续由现有 Control Plane foundation 计划的后续任务承接，本纵切只提前验证它们共同依赖的最短真实链路。

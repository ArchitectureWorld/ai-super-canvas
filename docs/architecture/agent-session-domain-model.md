# Agent-Session 领域模型

状态：Accepted
版本：1.0
日期：2026-07-15

## 1. 目标

本模型把“登录账号拥有长期助理、一个 Workflow 中有多个 Chat Session、对话像植物一样分枝生长”转化为可持久化、可授权、可替换 Runtime 的产品语义。

核心关系是：

```text
Account ─owns/uses─> AgentIdentity ─binds─> Agent Runtime
   │
   └─member-of─> Workspace ─contains─> Workflow
                                      ├─ TrunkRevision
                                      ├─ BranchAnchor
                                      └─ SessionNode ─projects─> Session
                                                           └─ Run*
```

## 2. 规范术语

| 对象 | 定义 | 所有者 | 关键区别 |
|---|---|---|---|
| `Account` | 登录身份、资源所有权和权限主体 | Canvas | 不是 Agent；`defaultAgentId` 只是偏好 |
| `Workspace` | 成员和资源授权边界 | Canvas | 可以包含多个 Workflow |
| `AgentIdentity` | 长期人格、能力和记忆的产品身份 | Canvas | 不等于某个 Hermes 进程或模型 |
| `AgentAccessGrant` | 账号对非自有 AgentIdentity 的显式使用或管理授权 | Canvas | 共享 Agent 的唯一授权依据；可撤销、可审计 |
| `AgentBinding` | AgentIdentity 与具体 Runtime 资源的绑定 | Canvas | 保存 Runtime kind、external ref、隔离键和能力快照 |
| `Workflow` | 一个目标下的权威主干和 Session 生长图 | Canvas | 不是 Runtime workflow，也不是单个 Session |
| `TrunkRevision` | Workflow 当前权威上下文的不可变版本 | Canvas | Agent 无权直接覆盖 |
| `BranchAnchor` | 分枝来源的词、句、消息、产物区域或 revision 选择器 | Canvas | 是来源证据，不是装饰性标签 |
| `SessionNode` | Chat 块在 Workflow 图中的节点身份和生长状态 | Canvas | v1 与 Session 一一对应；Branch 是它的生长角色 |
| `Session` | 与一个 AgentBinding 连续交互的隔离工作上下文 | Canvas + Runtime 映射 | 一个 Session 可有多次 Run |
| `SessionRuntimeRef` | Canvas Session 与某个 Runtime 原生 Session 的映射 | Canvas | 可保留历史映射；external ref 从不成为产品主键 |
| `SessionEdge` | SessionNode 之间的派生、引用、支持、反驳或依赖关系 | Canvas | 派生边可关联 BranchAnchor |
| `SessionConfigRevision` | Session 模型、工具和上下文策略的不可变版本 | Canvas | Run 必须引用并保存最终快照 |
| `Run` | 一次发送、恢复、重试或执行 | Canvas + Runtime 映射 | 不是 Session，也不是一条纯文本消息 |
| `RunEvent` | Run 的有序生命周期事件 | Canvas | append-only，支持重连、审计和 UI 重放 |
| `Message` | 用户/Agent/系统在 Session 中的规范化内容 | Canvas | 工具审批和 Artifact 不是普通 Message |
| `Artifact` | 文档、代码、图片、结论、任务等正式产物 | Canvas | 与聊天过程分离，保留 provenance |
| `Proposal` | Artifact 对主干或其它对象提出的变更 | Canvas | 必须人工确认并做 revision 冲突检查 |
| `ContextRef` | 允许注入 Run 的上下文引用或派生摘要 | Canvas | 不等于复制 Agent 私有长期记忆 |
| `ToolGrant` | 对工具调用的允许、拒绝或需审批规则 | Canvas | 与 Runtime 原生权限取交集 |
| `ModelEntry` | 产品可见模型及能力、状态和路由信息 | Canvas | `.env` 只提供启动配置和密钥 |

## 3. Branch 与 Session 的关系

`Branch` 保留为产品语言，但不再与 Session 建立一套重复的会话数据。

在 v1 中：

```text
Branch = 一个具有 derives 入边、BranchAnchor 和生长生命周期的 SessionNode
Chat 块 = SessionNode 的画布投影
Chat 内容 = Session 下的 Message/Run/Event
```

因此：

- 创建分枝就是原子创建 `BranchAnchor + Session + SessionNode + SessionEdge`；
- 分支标题、休眠和代谢状态属于 SessionNode；
- 对话连续性、模型配置、运行和消息属于 Session；
- 一个 Branch 不再另存一份 `conversationId` 和消息列表；
- 将来一个视觉容器需要展示多个 Session 时，必须新增组合节点类型，不能破坏 v1 的一一对应约束。

## 4. 聚合边界

### 4.1 Identity Aggregate

包含 `Account`、`AgentIdentity`、`AgentAccessGrant`、`AgentBinding`。

不变量：

1. Account 可以拥有多个 AgentIdentity，也可以通过有效 `AgentAccessGrant` 使用共享 Agent。
2. 每个 Account 最多有一个有效默认 Agent；默认 Agent 必须由该账号拥有，或存在未撤销的 `use/admin` Grant。删除默认 Agent 不删除账号。
3. AgentBinding 的 `runtimeKind + externalAgentRef` 在有效绑定中唯一。
4. Runtime 凭证只保存 secret reference，不能进入数据库 JSON、Message 或 ContextRef。
5. 一个 AgentIdentity 可以迁移到新 Binding；历史 Session 始终保留原 Binding 引用。

### 4.2 Workflow Aggregate

包含 `Workspace`、`Workflow`、`TrunkRevision`、`BranchAnchor`、`SessionNode`、`SessionEdge`。

不变量：

1. Workflow 必须有且仅有一个 current trunk revision。
2. TrunkRevision 不可修改，只能追加新 revision。
3. BranchAnchor 必须指向同一 Workflow 中存在的 source object/revision。
4. `derives` 边必须带 anchor；其它边不得伪造植物分枝。
5. SessionEdge 不得跨 Workflow。
6. `derives` 子图必须无环；其它语义边可以形成网络。
7. 用户移动节点只改变布局投影，不改变 Session 亲缘关系。

### 4.3 Session Aggregate

包含 `Session`、`SessionConfigRevision`、`Message`、`ContextRef`。

不变量：

1. 一个 Session 属于一个 Workflow，并绑定一个 AgentBinding。
2. 第一次 Run 后不得静默更换 AgentBinding；需要新 Agent 时 fork 新 Session。
3. 模型可创建新 SessionConfigRevision；历史 Run 不被回写。
4. Message 的 `ordinal` 在 Session 内单调递增且唯一。
5. Canvas Session ID 是主键；`runtimeSessionRef` 只在 AgentBinding 内唯一。
6. 父 Session 保持可用，fork 不得隐式关闭父 Session。
7. Runtime transcript 与 Canvas transcript 漂移时进入 reconciliation 状态，不做静默覆盖。

### 4.4 Run Aggregate

包含 `Run`、`RunEvent`、工具审批记录和运行快照。

不变量：

1. 同一个 `sessionId + idempotencyKey` 只能创建一个 Run。
2. 一个 Session 同时最多有一个非并行模式的 active Run。
3. RunEvent 的 `sequence` 在 Run 内单调递增且唯一。
4. Run 保存实际 AgentBinding、模型、工具策略和上下文策略快照。
5. `waiting_approval` 只能由 `approval.required` 进入，并由授权决定恢复或拒绝。
6. Runtime 命令或传输结果未知时，Run 进入 `reconciling` 并继续占用该 Session 的 active-run 槽位。
7. `succeeded/failed/cancelled` 是终态；迟到事件只记录为 reconciliation warning，不能复活 Run。

### 4.5 Outcome Aggregate

包含 `Artifact`、`Proposal` 和应用后的 TrunkRevision。

不变量：

1. 正常新建 Artifact 必须记录来源 Session、Run 和内容 revision；只有显式 `legacy-import` 流程可暂时没有原 Run，且必须在 revision provenance 中审计导入器、来源引用和内容摘要。
2. Proposal 必须声明 `baseTrunkRevisionId` 和结构化 operation/patch。
3. 接受 Proposal 前必须验证用户权限和 base revision；不一致则进入 `stale`。
4. 接受 Proposal、创建新 TrunkRevision 和写入审计事件必须在同一事务。
5. Agent 只能创建或更新 draft/ready Artifact 和 pending Proposal。

## 5. 生命周期

### SessionNode 生长状态

```text
active <──> dormant
active/dormant ──metabolize──> metabolized
```

`metabolized` 表示退出活跃生长投影，但来源、消息、事件和审计仍保留。真正删除由独立数据保留策略处理。

### Session 状态

```text
provisioning ──> active <──> dormant ──> closed ──> archived
       └────────> error
```

Session 状态描述连续上下文是否可用；Run 是否运行不写入 Session 状态。

### Run 状态

```text
queued -> running -> waiting_approval -> running -> succeeded
   │        │                     ├──> failed
   │        └── transport/command unknown ──> reconciling
   └────────────────────────────────────> cancelled

reconciling -> running | waiting_approval | succeeded | failed | cancelled
```

`reconciling` 不是终态，也不是“可以再开一个 Run”的许可。只有对账得到规范终态事件，或证明原 Run 从未开始，才能离开该状态。

### Artifact 与 Proposal

```text
Artifact: draft -> ready -> accepted | rejected | superseded
Proposal: pending -> accepted | rejected | stale
```

## 6. 锚点 fork 语义

创建分枝使用可判别联合，Trunk 锚定与 Message/Artifact fork 不共享一组伪必填字段：

```ts
interface ForkMessageSessionCommand {
  kind: 'fork-message';
  commandId: string;
  workflowId: string;
  parentSessionId: string;
  atMessageId: string;
  sourceRevisionId: string;
  anchor: {
    sourceKind: 'message';
    sourceId: string;
    selector: {
      kind: 'text-quote';
      exact: string;
      prefix?: string;
      suffix?: string;
      startCodePoint?: number;
      endCodePoint?: number;
    };
  };
  title: string;
  agentBindingId?: string;
}

interface ForkArtifactSessionCommand
  extends Omit<ForkMessageSessionCommand, 'kind' | 'anchor'> {
  kind: 'fork-artifact';
  anchor: {
    sourceKind: 'artifact';
    sourceId: string;
    selector: {
      kind: 'text-quote';
      exact: string;
      prefix?: string;
      suffix?: string;
      startCodePoint?: number;
      endCodePoint?: number;
    };
  };
}

interface CreateAnchoredSessionCommand {
  kind: 'anchor-trunk';
  commandId: string;
  workflowId: string;
  sourceRevisionId: string;
  anchor: {
    sourceKind: 'trunk-revision';
    sourceId: string;
    selector: {
      kind: 'text-quote';
      exact: string;
      prefix?: string;
      suffix?: string;
      startCodePoint?: number;
      endCodePoint?: number;
    };
  };
  title: string;
  agentBindingId: string;
}

type CreateBranchSessionCommand =
  | ForkMessageSessionCommand
  | ForkArtifactSessionCommand
  | CreateAnchoredSessionCommand;
```

所有 TextQuote selector 的 `startCodePoint/endCodePoint` 必须成对出现；都省略时依赖 exact/prefix/suffix 重定位，只出现一个属于无效命令。

领域命令本身不携带可由客户端伪造的 `accountId`。应用服务以 `{ actor: ActorContext, command: CreateBranchSessionCommand }` 调用领域逻辑；`ActorContext` 只能由认证边界创建，并贯穿 Workflow、Session、Run 与事件读取的 Repository 授权查询。

处理顺序：

1. 校验账号对 Workflow、父 Session 和 AgentBinding 的权限；
2. 校验 source revision、message 和 text quote 未漂移；
3. 截取父 Session 在 `atMessageId` 之前且包含该消息的规范化 transcript prefix；
4. 创建 BranchAnchor；
5. 创建新 Canvas Session 和 SessionNode；
6. 创建带 anchor 的 `derives` SessionEdge；
7. 在同一 Canvas 事务写入初始 ContextRef、`session.forked` 领域事件和 phase=`canvas_prepared` 的 CommandReceipt 后提交；不得跨 Runtime 网络调用持有数据库事务；
8. 通过 Receipt 原子取得一次 dispatch lease，再调用 RuntimeAdapter 创建或 fork Runtime Session；
9. 先把已知 external ref 写入 receipt，再以一个事务保存 `runtimeSessionRef`、激活 Session 并置 phase=`attached`；
10. `attached` 重试直接返回；dispatch 后未知或 attach split failure 进入 reconciling/补偿 ledger，未证明副作用不存在前不得再次 dispatch。

父 Session 不进入 closed/dormant，除非用户另行操作。

CommandReceipt 是外部副作用编排状态机，不只是数据库唯一键。`canvas_prepared/retryable_failure` 才能取得 dispatch lease；`runtime_dispatched/runtime_known/reconciling` 只能对账或补偿；`attached` 必须返回原 Canvas 结果。该规则同样适用于创建根 Session、锚点 Session、fork 和 start Run。

从 TrunkRevision 文本直接创建首层 Branch 时，`kind = anchor-trunk`，因此不存在 `parentSessionId/atMessageId`。对应 derives Edge 的 source SessionNode 为空，target 为新 SessionNode；这不是“缺失父节点”，而是明确从权威主干生长。`kind = fork-message` 时，`atMessageId` 必须属于父 Session，且 `anchor.sourceId` 必须与 `atMessageId` 完全相等。`kind = fork-artifact` 在 S4 Outcome 表落地后启用，Artifact 必须能追溯到该父 Session 在此消息之前的 Run；S1 不接受该命令。

## 7. 上下文与记忆作用域

| Context `scope` | 持久化 `visibility` 默认值 | 上下文寿命 | 内容与注入规则 |
|---|---|---|---|
| account | `private` | 长期 | 用户偏好、账号级约束；仅本人授权的 Agent |
| agent | `private` | 长期 | SOUL、长期记忆、技能偏好；同一 AgentBinding，共享需显式授权 |
| workflow | `workspace` | Workflow 存续期 | 已确认主干、共享材料、团队规则；Workflow 成员按角色读取 |
| session | `private` | Session 存续期 | transcript、局部摘要、锚点上下文；仅当前 Session 和显式 fork 子 Session |
| run | `private` | Run 内临时 | 本次临时变量、工具中间结果；Run 结束后按保留策略提取或销毁 |

`scope` 描述上下文绑定层级，寿命列描述保留期；它们都不是可见性。所有持久化 ContextRef 的 `visibility` 仅允许 `private | workspace`，不得写入 `session` 或 `ephemeral`。

fork 默认行为：

- 继承同一个 AgentIdentity/AgentBinding；
- 引用同一个 Workflow 权威上下文；
- 复制到锚点为止的 Session transcript prefix；
- 不复制 Account/Agent 私有记忆，只通过原 AgentBinding 按策略访问；
- 不继承父 Run 的临时工具授权；
- Session 级模型配置可继承，但新 Session 产生独立 config revision。

## 8. 模型和工具策略

生效模型按以下优先级解析：

```text
Run 显式覆盖
> SessionConfigRevision
> Agent 默认策略
> Account/Workspace 可见策略
> 系统默认与健康降级路由
```

每个 Run 保存解析后的实际 `provider/model/capabilities/runtimeKind` 快照。`.env` 只承载 provider secret、endpoint 和 bootstrap default，不直接决定某个历史 Run 使用了什么。

有效工具权限是以下交集，并且 deny 优先：

```text
Account 权限
∩ Agent ToolPolicy
∩ Workflow 角色权限
∩ Session ToolGrant
∩ Runtime 原生安全策略
∩ 本次人工审批
```

## 9. 植物生长映射

| 植物语义 | 领域对象 | 行为 |
|---|---|---|
| 根 | Agent 长期身份/记忆 + 已确认 ContextRef | 提供稳定但受权限控制的长期上下文 |
| 主干 | Workflow + TrunkRevision | 当前权威目标与结论 |
| 芽点 | BranchAnchor | 可验证的分枝起点 |
| 枝 | 带 derives 入边的 SessionNode | 独立 Session 探索空间 |
| 叶 | Message、Run 中间结果 | 聚焦时展开，不强制成为画布节点 |
| 花 | ready Artifact / pending Proposal | 已形成但未确认的成果 |
| 果 | accepted Artifact + applied Proposal | 已确认并可回流主干 |
| 休眠 | SessionNode.dormant | 保留全部来源并退出焦点 |
| 腐殖 | Metabolism Artifact/ContextRef | 从结束方向提取可追溯经验 |

植物语义是拓扑和生命周期，不使用树皮、叶片等写实皮肤替代精确状态。

本架构中的 `Workflow` 特指 Canvas 的目标/Session 生长图。未来 LangGraph 等确定性步骤定义统一称 `ExecutionWorkflowDefinition/WorkflowVersion`，不得与 Canvas Workflow 混用。登录态统一称 `AuthSession`，不得与 Agent 对话 Session 混用。

代谢、休眠和归档是知识生命周期，不取代安全删除。用户清除请求、保留期限到期、密钥泄漏和法律/隐私要求可以触发受审计的硬删除或加密销毁。

## 10. 迁移当前原型

当前 `WorkspaceState.version = 1` 的迁移映射：

| 旧对象 | 新对象 |
|---|---|
| `WorkspaceState` | 一个 Workspace + 一个 Workflow |
| `trunk.revisions` | TrunkRevision |
| `TextAnchor` | BranchAnchor |
| `Branch` | SessionNode + Session + derives SessionEdge |
| `BranchMessage` | Message；导入时 `runId = null`、标记 `source = legacy-local` |
| `ConclusionCard ready` | Artifact ready + Proposal pending；`provenanceMode = legacy_import`，允许原 Run 为空但必须记录导入 provenance |
| `ConclusionCard integrated` | Artifact accepted + Proposal accepted + TrunkRevision 关联；沿用同一 legacy import provenance |
| `WorkspaceEvent` | DomainEvent 导入记录，不伪造 RunEvent |

迁移必须生成稳定映射表，允许重复执行而不重复创建数据；原 localStorage 数据在用户确认服务器导入成功前保持只读备份。

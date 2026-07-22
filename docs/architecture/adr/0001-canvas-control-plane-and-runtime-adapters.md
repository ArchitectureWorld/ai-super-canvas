# ADR-0001：Canvas 控制面与可替换 Agent Runtime

- 状态：Accepted
- 日期：2026-07-15
- 决策者：AI Super Canvas 产品负责人
- 影响范围：领域模型、数据库、API、Agent 集成、Chat 块、模型和工具权限

## 背景

产品要支持“一个长期个人 Agent、多个 Workflow、每个 Workflow 多个可分枝 Session”。Chat 块必须具备普通 Agent 的连续对话、流式输出、工具调用、审批、取消、恢复和模型切换能力，同时保持植物式语义锚点、成果回流和知识代谢。

市场框架已经普遍区分 Agent、Session/Thread 和 Run：OpenAI Agents SDK 将 Session 作为多次运行之间的历史容器；LangGraph 以 Thread/checkpoint 保存可恢复状态；Letta 允许一个持久 Agent 拥有多个隔离 Conversation，并共享长期记忆。上述能力证明领域抽象可行，但不提供 Canvas 的账号、植物式 Session 图、主干 revision 和成果回流控制面。

本机 Hermes 已经具备 profile 隔离、Session 持久化、ACP 流式交互、模型切换、工具事件和审批能力；其原生 fork 目前复制完整历史，部分 API fork 还会结束父 Session，不满足 Canvas 的锚点分枝语义。

## 决策驱动力

1. Canvas 的 Workflow、锚点、Session 图和 Artifact 必须独立于任何 Agent 框架长期存在。
2. 每个账号的个人 Agent 需要长期人格和记忆，同时保证不同 Session 的即时上下文隔离。
3. 产品必须能替换 Runtime，不能因 Hermes、Letta 或模型供应商变化迁移全部业务数据。
4. 工具权限、审批、运行状态、费用和审计必须由产品控制面统一治理。
5. 分枝必须从任意消息/文本锚点创建，父 Session 继续运行，来源可追溯。
6. 研发资源应优先投入产品差异化，而不是重复开发通用 agent loop。

## 决策

采用“**Canvas Control Plane + RuntimeAdapter + 隔离 Runtime Worker**”架构。

### Canvas 持有的事实源

- Account、Workspace、成员关系和资源授权；
- AgentIdentity、AgentBinding 和默认 Agent；
- Workflow、TrunkRevision、BranchAnchor、SessionNode 和 Session 边；
- Session、SessionConfigRevision、Run、Message 和 RunEvent；
- Artifact、Proposal、人工确认和 provenance；
- ModelRegistry、ToolGrant、配额、审计和幂等键；
- Canvas ID 与 Runtime external reference 的映射。

Canvas 数据库中的规范化 Message/Event 是 UI 和审计事实源。Runtime 中的原生 transcript 用于执行恢复和对账，不反向定义产品对象。

### Runtime 持有的执行职责

- 模型调用和 agent loop；
- Runtime 原生 Session/Run 状态；
- profile 内长期 Agent 记忆；
- 工具实现、MCP 接入和原生流式事件；
- Runtime 快照、恢复信息和健康状态。

Runtime 不拥有 Workflow 拓扑、锚点、主干 revision、成员授权或 Proposal 状态。

### 主线

第一代实现采用 `HermesAcpRuntimeAdapter`。初期每个 `AgentBinding + Workspace execution scope` 使用独立 profile-scoped ACP Worker；同一隔离范围内的一个 Worker 承载该 Agent 的多个 Session。后续再演进为隔离进程池或容器池。

Canvas 定义 `forkSession({ atMessageId, sourceRevisionId })` 语义。Runtime 只能复制完整历史时，Adapter 只有在能安全创建新 Runtime Session、精确导入经过校验的 transcript prefix/ContextRef，并通过 history digest 与 lineage 契约测试后，才能声明 `forkAtMessage = adapter`。否则必须返回 unsupported；不得静默改成 HEAD fork、空 Session 或结束父 Session。

### 备用线

`LettaRuntimeAdapter` 是独立备用候选。其产品模型具备长期 Agent、多个 Conversation、共享长期记忆和消息级 fork，但只有固定版本通过 Canvas 全套契约与隔离测试后才成为“真备用”；它仍不得成为 Canvas 产品数据库。

`LangGraphRuntimeAdapter` 只在出现需要 checkpoint、暂停恢复、确定性节点与 Agent 混合的复杂 Workflow 时引入，不承担 Account、AgentIdentity 或画布模型。

### 原生 Runtime

在 Hermes 和 Letta 两套 Adapter 均通过相同契约测试之前，不开发完整 `CanvasNativeRuntime`。两套实现验证后的共同最小语义，才可以成为未来原生 Runtime 的输入。

## 关键不变量

1. `Account != AgentIdentity != Session != Run`。
2. 一个 Account 可拥有或使用多个 Agent；默认 Agent 只是偏好，不是数据库基数约束。
3. v1 一个 SessionNode 恰好投影一个 Session；同一 Session 不得出现在两个 Workflow。
4. Session 在第一次 Run 后不得静默更换 AgentBinding；更换 Agent 必须新建或 fork Session。
5. 模型可以按 Session 配置并按 Run 覆盖；每个 Run 保存最终生效配置快照。
6. Runtime external ID 只在对应 AgentBinding 内唯一，不能作为 Canvas 外键主键。
7. 工具审批是 Run 状态与审计记录，不是普通聊天消息。
8. Agent 只能产生 Artifact/Proposal；应用 Proposal 必须检查主干 revision 并由授权用户确认。
9. 个人 Agent 记忆默认 private；共享 Workflow 只能消费显式授权的 ContextRef 或派生摘要。
10. 所有 Runtime 事件必须经过规范化、排序和幂等去重后写入 Canvas；事件行、完成消息/产物投影和终态推进必须在一个事务提交。
11. CommandReceipt 保存 Runtime 副作用的编排 phase；进程重启后的重试只有在证明原副作用未发生时才能再次 dispatch。

## 被否决或延后的方案

### 直接把 Hermes 当产品后台

否决。它会让 Canvas 的账号、权限、Workflow、Session 图和数据迁移绑定 Hermes 内部结构；现有 fork、模型覆盖和多租户路由也不满足产品语义。

### 立即重写完整 Agent 内核

延后。工具安全、模型兼容、流式输出、记忆、恢复和 MCP 都是高成本基础设施，当前没有证据表明重写能提升核心产品验证速度。

### 直接使用 Letta 作为产品数据库

否决。Letta 的 Agent/Conversation 模型与本产品接近，但没有 Canvas 的 Workflow/Anchor/Trunk/Proposal 领域语义，并会形成另一种运行时锁定。

### 一个 Workflow 共用一个 Session

否决。不同分枝会污染即时上下文，无法独立暂停、恢复、切换模型或审计。

### 一个 Chat 块创建一个 Agent

否决。人格、长期记忆、工具和授权会碎片化，失去“长期助理、多条探索会话”的核心体验。

## 正面影响

- 产品核心数据和交互语义不依赖单一 Runtime；
- 可以先复用 Hermes 能力，同时保留 Letta 和未来原生 Runtime；
- Chat 块获得真正 Session/Run 生命周期；
- 锚点 fork、Artifact、Proposal 和人工回流成为可测试领域能力；
- 模型、工具、费用和审计可统一治理。

## 成本与风险

- 需要维护 Canvas 与 Runtime 的双重 Session 引用和对账；
- 需要事件规范化、幂等、重连和漂移检测；
- profile-scoped Worker 比共享单进程更消耗资源；
- Hermes ACP 不直接提供任意消息 fork；Adapter 是否能安全补齐必须由能力闸门证明；
- 多 Runtime 契约会限制使用供应商特有功能，特有能力必须通过 capability negotiation 显式暴露。

## 重新评估条件

出现以下任一情况时重新评估 Runtime 选择，但不推翻 Canvas 控制面：

- Hermes 无法通过 profile 隔离、双 Session 并发、重启恢复或审批安全闸门；
- 锚点 fork 必须长期依赖脆弱的 transcript 注入；
- Hermes 版本无法固定并通过契约测试复现；
- Letta 在相同契约下显著降低运行复杂度；
- 两套 Adapter 暴露出稳定共同语义，足以设计轻量 CanvasNativeRuntime。

## 参考证据

- [OpenAI Agents SDK Sessions](https://openai.github.io/openai-agents-python/sessions/)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Letta Conversations](https://docs.letta.com/guides/core-concepts/messages/conversations/)
- Hermes ACP SessionManager（外部 Hermes 固定版本：`acp_adapter/session.py`，约第 186 行）
- Hermes API fork 行为（外部 Hermes 固定版本：`gateway/platforms/api_server.py`，约第 1601 行）
- 部署端 Hermes profile 架构（外部运维文档：`<deployment-data-root>/agent-architecture.md`）

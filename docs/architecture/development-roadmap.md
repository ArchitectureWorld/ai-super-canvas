# AI Super Canvas 主线与备用线发展路线

状态：Canonical
版本：2026-07-15
适用范围：从当前本地画布原型发展为可替换 Runtime 的 Agent Session Graph 产品。

## 1. 北极星

AI Super Canvas 不是“白板里放几个 Chat 窗口”，也不是“给现有 Agent 套一个节点 UI”。产品核心是：

> 以长期个人 Agent 为根，以 Workflow 权威上下文为主干，以语义锚点创建隔离 Session 分枝，以 Run/Event 保留生长过程，以 Artifact/Proposal 形成可确认成果。

可防御的核心资产：

1. 语义锚点和任意消息/revision fork；
2. Session 图与明确的上下文继承；
3. 长期个人 Agent 与多 Session 连续性；
4. Message、Run、Artifact、Proposal 的边界；
5. 人工确认后的主干 revision 回流；
6. provenance、休眠、代谢和长期知识提取；
7. Runtime、模型和工具可替换但产品数据不迁移。

## 2. 三条技术线

### A. 主发展线

```text
Canvas Control Plane
  -> FakeRuntime（先验证领域契约）
  -> Hermes ACP Adapter（首个真实 Runtime）
  -> 完整 SessionNode Agent 体验
```

主线研发资源优先级最高。Canvas 自己实现身份、权限、Workflow/Session 图、Run/Event、Artifact/Proposal、ModelRegistry 和 ToolGrant。

### B. 独立备用线

```text
同一 Canvas Control Plane
  -> LettaRuntimeAdapter
```

备用线不平行重做 UI 或数据库。它只通过 Runtime 契约证明 Canvas 能摆脱 Hermes。Letta 在契约测试前只是备用候选；Hermes 未触发硬失败前，不同时维护两套生产部署。

### C. 专项与长期线

- LangGraph：只承接需要 checkpoint、确定性节点、长暂停和复杂 HITL 的专项 Workflow；
- CanvasNativeRuntime：至少两种外部 Adapter 通过契约后再评估；
- MCP：Agent 到工具的边界；
- A2A：远程 Agent 委派边界；
- MCP/A2A 都不是 Canvas 内部数据库模型。

## 3. 阶段路线

以下交付项和退出条件都是路线要求，不是完成声明；任何阶段只有在绑定提交、测试结果和运行证据后才能标记完成。

### S0：架构冻结（当前文档基线）

目标：团队只使用一套 Agent/Session/Run 语言。

交付：

- Accepted ADR；
- 领域模型与不变量；
- PostgreSQL 草图；
- RuntimeAdapter 契约；
- Hermes capability gates；
- 首阶段 TDD 实施计划；
- 旧文档状态和权威顺序。

退出条件：文档链接、术语和状态一致，实施计划不再引用旧 Conversation/Node/AI Run 混合模型。

### S1：控制面地基 + FakeRuntime

目标：在不接真实模型的情况下打通一个服务器持久化 Session 的完整生命周期。

交付：

- Account、AgentIdentity、AgentBinding、Workspace、Workflow；
- Session、SessionNode、BranchAnchor、SessionEdge；
- SessionConfigRevision、Run、RunEvent、Message；
- RuntimeAdapter 和 DeterministicFakeRuntime；
- 创建 Session、锚点 fork、开始 Run、事件重放和取消 API；
- 空库 local-alpha bootstrap、服务端 ActorContext、结构化取消 ack 与 reconciling；
- PostgreSQL 事务、复合租户约束、带编排 phase 的幂等收据、原子事件投影、补偿 ledger 和权限/故障注入测试；
- 与主开发库完全隔离且无主机端口的测试 Compose project；
- 浏览器 localStorage v1 导入器设计与 fixture。

Golden Path：

```text
创建账号默认 Agent
-> 创建 Workflow
-> 创建主 SessionNode
-> Fake Run 流式返回
-> 从中间消息 fork
-> 父子 Session 独立继续
-> 重建 Repository/Service 后恢复 Canvas transcript 与事件
-> 明确证明内存 FakeRuntime 不虚报跨进程恢复
```

退出条件：Golden Path 全部由自动化测试证明，前端尚未接入也可通过 API 完成。Runtime 原生跨重启恢复仍属于 S2 Hermes gate，不由 S1 Fake 的内存行为冒充。

### S2：Hermes ACP 能力 Spike

目标：只验证 Runtime 能力，不把 UI 和产品逻辑提前绑定 Hermes。

交付：

- 固定 Hermes artifact/commit；
- profile-scoped ACP Worker launcher；
- HermesAcpRuntimeAdapter；
- Runtime 契约测试报告；
- profile 隔离、双 Session、forkAt、流式事件、审批、取消、恢复和模型切换证据；
- 资源基线和故障恢复记录。

退出条件：满足 [Hermes ACP 能力闸门](./hermes-acp-capability-gates.md) 的正式通过标准。

失败出口：触发硬门槛后冻结 Hermes 扩展，进入 S2B Letta Adapter Spike；Canvas 控制面继续使用。

### S3：真实 Chat SessionNode

目标：把现有视觉 Chat 块替换为真正 Session 投影，而不是在 localStorage 原型上继续叠功能。

交付：

- 每个 Chat 块加载 Session/Message/Run；
- 块内输入、流式输出、停止、重试、恢复；
- 工具状态与审批 UI；
- 模型选择写 SessionConfigRevision，不再写 CanvasLayoutState；
- 块设置跟随节点移动；
- 右键短按菜单、长按拖动平移；
- 以鼠标为中心缩放；
- 移除无目标 Session 的全局底部对话栏；
- 分枝关键词/句子使用独立 BranchAnchor 视觉编码；
- 刷新和服务重启后恢复用户表面状态。

退出条件：两个真实 Session 并行对话无上下文串用；浏览器端到端测试验证锚点 fork、取消、审批和模型快照。

### S4：Artifact、Proposal 与主干回流

目标：Agent 的价值从聊天输出升级为可验证成果。

交付：

- Artifact 创建、版本和 provenance；
- pending Proposal、Diff、权限检查和 revision 冲突；
- 接受 Proposal 原子生成 TrunkRevision；
- stale/rejected/superseded 生命周期；
- 成果回流线和历史重放；
- Agent 无法绕过 Proposal 直接改主干的授权测试。

退出条件：并发修改下 stale Proposal 不污染主干，全部接受操作可追溯到 Account/Agent/Session/Run。

### S5：多账号、共享 Workflow 与隐私

目标：支持真实账号和团队，同时保护个人 Agent 记忆。

交付：

- Workspace membership 和 owner/editor/runner/viewer；
- 默认个人 Agent 与可选专业/共享 Agent；
- ContextRef 可见性和私有记忆摘要策略；
- ToolGrant 交集、deny-first 和审批审计；
- 配额、费用、速率限制和数据保留；
- Runtime Worker 隔离、secret reference 和安全测试。

退出条件：跨账号、跨 AgentBinding 渗透测试通过；共享 Workflow 不泄露个人 memory/secret。

### S6：Runtime 可替换性证明

目标：让“可插拔”从设计宣言变成运行事实。

交付：

- LettaRuntimeAdapter；
- 同一契约测试在 Fake/Hermes/Letta 上运行；
- Binding 级 Runtime 迁移/新建策略；
- capability 差异和降级 UI；
- 无需迁移 Workflow/SessionNode/Artifact 的演示。

退出条件：同一 Workflow 可以为新 Session 选择另一 Runtime，旧 Session 仍可读取和审计。

### S7：复杂 Workflow 和生态边界

目标：在核心 Session 图稳定后扩展复杂执行，不反客为主。

交付候选：

- LangGraph durable workflow adapter；
- WorkflowVersion、Step、父 Run/Step Run；
- MCP Tool Registry 与集中授权；
- A2A remote agent delegation；
- 多模态 Artifact、图像/文件区域 Anchor；
- Agent/Workflow 模板市场。

进入条件：至少有三个真实业务流程无法由 Session 图 + Run/Tool 完成，且共同需要耐久 workflow 语义。

## 4. 关键依赖顺序

```text
领域不变量
  -> Runtime 契约
    -> FakeRuntime
      -> PostgreSQL/API
        -> Hermes capability spike
          -> SessionNode UI
            -> Artifact/Proposal
              -> 多账号安全
                -> 第二 Runtime
```

不得倒置：

- 不先做“看起来像 Agent”的 UI，再补 Session 数据；
- 不先直连 Hermes，再反推 Canvas 领域模型；
- 不在 Run/Event 完成前做复杂 Agent 编排；
- 不在 ToolGrant 和身份边界完成前开放高风险工具；
- 不在第二 Adapter 证明前宣称 Runtime 无关。

## 5. 决策指标

每阶段统一跟踪：

| 维度 | 指标 |
|---|---|
| 正确性 | 幂等冲突、事件重复、transcript 漂移、stale proposal 数 |
| 隔离 | 跨 Session/Agent/Account 泄漏测试结果 |
| 恢复 | Worker/服务重启后的 Session/Run 恢复率 |
| 交互 | 从 Anchor 创建可用子 Session 的完成率和时延 |
| 执行 | Run 成功率、取消延迟、审批等待、工具失败率 |
| 成果 | Artifact 形成率、Proposal 接受率、回流后继续使用率 |
| 可替换 | Runtime 契约通过率和 vendor-specific 分支数量 |
| 成本 | 每 Run token/cost、活跃 Worker 资源、冷启动 |

## 6. 旧路线图的处理

`docs/02-product-roadmap.md` 保留产品功能演进背景，但其中把 Agent 协作推迟到 V0.7、并固定 Hermes/OpenClaw/Codex 职责的部分，不再作为架构执行顺序。

原因：Session 和 AgentBinding 已经是每个 Chat 块的基础，而不是后期附加功能。复杂多 Agent 自动调度仍然延后；单 Agent 多 Session 控制面必须前置。

## 7. 当前唯一执行入口

S1 的可执行任务见：

[2026-07-15-agent-session-control-plane-foundation.md](../superpowers/plans/2026-07-15-agent-session-control-plane-foundation.md)

S2 只有在 S1 通过后才进入 Hermes 实现。S3 不得在 FakeRuntime API 和 Hermes 契约结果之前改写 Chat 块数据源。

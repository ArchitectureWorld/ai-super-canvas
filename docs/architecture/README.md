# Agent Session Graph 架构基线

状态：**Accepted**
生效日期：2026-07-15
适用范围：AI Super Canvas 产品控制面、Agent Runtime 接入、Workflow/Session 图和后续 Chat 块实现。

> `Accepted` 只表示架构决策已成为文档基线，不代表 S1 控制面、Hermes Adapter 或真实 SessionNode 等能力已经交付；实现状态必须由对应提交、自动化测试和运行证据证明。

## 一句话决策

> AI Super Canvas 自研 Agent 控制面与植物式 Session 图；Hermes ACP 是第一代候选运行时，Letta 是独立备用候选，二者都必须通过同一契约；LangGraph 仅在复杂耐久工作流出现后作为专项执行器。

这意味着：

- 每个画布 Chat 块是一个 `SessionNode`，v1 与一个持久化 `Session` 一一对应；
- 一个登录账号默认绑定一个长期个人 Agent，但领域模型允许多 Agent 和共享 Agent；
- 一个 Workflow 包含多个 Session，Session 之间通过锚点和有向边形成生长图；
- 每次发送、重试、恢复或工具执行都是独立 `Run`；
- Canvas 持有账号、权限、Workflow、Session、Run、事件、产物和回流的事实源；
- Hermes、Letta、LangGraph 不进入 Canvas 的核心数据库语义，只通过 `RuntimeAdapter` 接入。

## 架构图

```text
Account / Workspace
├── AgentIdentity
│   └── AgentBinding ───────────────┐
│                                   │
└── Workflow                        │
    ├── TrunkRevision               │
    ├── BranchAnchor                │
    └── SessionNode ── Session ─────┼── RuntimeAdapter
                         ├── Run     │      ├── Hermes ACP（候选主线）
                         ├── Event   │      ├── Letta（备用候选）
                         ├── Message │      └── LangGraph（专项）
                         └── Artifact/Proposal
```

## 权威文档顺序

遇到概念或实施冲突时，按以下顺序裁决：

1. [ADR-0001：Canvas 控制面与可替换 Runtime](./adr/0001-canvas-control-plane-and-runtime-adapters.md)
2. [Agent-Session 领域模型](./agent-session-domain-model.md)
3. [PostgreSQL 数据库草图](./postgres-schema.md)
4. [RuntimeAdapter 契约](./runtime-adapter-contract.md)
5. [Hermes ACP 能力闸门](./hermes-acp-capability-gates.md)
6. [主线与备用线发展路线](./development-roadmap.md)
7. [首阶段实施计划](../superpowers/plans/2026-07-15-agent-session-control-plane-foundation.md)

较早的 `docs/00`—`docs/09` 仍保留产品背景、植物语义、统一工作台、动态生长和世界画布研究价值；其中与 Agent、Conversation、Branch、Session、Run、模型管理、权限或开发优先级冲突的部分，以本目录为准。

## 产品层级补充：World Canvas

[`docs/09-world-canvas.md`](../09-world-canvas.md) 定义顶层世界画布、项目门户、语义缩放和跨项目关系的产品基线；其详细设计见 [`2026-07-23-world-canvas-and-multiscale-subgraphs-design.md`](../superpowers/specs/2026-07-23-world-canvas-and-multiscale-subgraphs-design.md)。

该产品层不得改变本目录的领域不变量：

- 世界画布是账号可见资源的顶层投影，不重新定义 `Workspace`；
- 项目门户是引用和摘要投影，不立即新增与 `Workflow` 冲突的事实源；
- `SessionEdge` 仍不得跨 Workflow；跨项目关系必须使用独立模型；
- 世界关系不授予权限，也不能直接修改 Session、Run、Artifact 或 TrunkRevision；
- 如需正式 `Project` 聚合，必须另写 ADR、数据库迁移和授权规则；
- 世界画布的长期方向不得打乱当前 S1–S4 依赖顺序。

## 当前仓库与目标架构的距离

当前原型仍是浏览器本地状态：`WorkspaceState` 只有主干、锚点、分支、消息、成果卡和事件；Chat 提交只追加 `BranchMessage`；`packages/ai` 只有模型目录和环境变量解析。它尚未实现 Account、Agent、Session、Run、Runtime、工具审批或服务器事件流。

因此后续不得继续把“给 Chat 块增加更多按钮”当作 Agent 后台建设。实施顺序必须从领域契约、Runtime 契约和持久化控制面开始，再把真实 Session 投影回画布。

世界画布同样不能建立在浏览器 localStorage 项目副本之上。只读种子原型可以先验证尺度和导航，但正式项目门户、关系、权限过滤和 Context Compiler 必须读取服务器事实源。

## 明确不做

- 不把 `Account`、`Agent`、`Session`、`Run` 合并成同一对象；
- 不把 Hermes Session ID 当作 Canvas 主键；
- 不直接读取或修改 Hermes profile 的内部 Session 文件；
- 不让 Agent 绕过 Proposal/人工确认直接改写主干；
- 不把个人 Agent 的私有记忆自动复制进共享 Workflow；
- 不用 `.env` 代替产品级模型注册表、权限和运行快照；
- 不在验证两种 Runtime Adapter 之前重写完整 Agent 内核；
- 不用世界画布关系绕过 Workspace 授权或伪造 Session 亲缘。

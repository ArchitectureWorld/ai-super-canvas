# AI Super Canvas / AI 超级画板

AI 超级画板是一个面向 AI 原生工作流的**图谱式 / 有机式智能画布**。

它的第一项核心功能不是绘图本身，而是把传统线性 Chat 转化为一个可分枝、可回流、可代谢、可重构的会话空间。用户可以从任意词汇、句子、段落、图片素材、文件片段、画布节点或局部区域生成分支，在独立上下文中探索，并将有效结果回流到主线或其它相关节点。

## 核心定位

> AI 超级画板的第一个功能，是让 AI 对话从线性消息流变成可分枝、可回流、可代谢的有机图谱式会话空间。

## 统一工作台原则

AI 超级画板不是多个工作台的拼接，而是一张统一的有机式 AI 工作画布。

> **工作台只有一个，但在同一个工作台里存在不同功能侧重点。**

TapNow 类节点生成、素材管理、历史版本和 Workflow 能力，属于这张统一画布中的“创意执行侧重点”，不是另一个下级工作台，也不是 AI 超级画板的产品母体。

建议的焦点模式：

```text
生长 | 创意 | 资产 | 任务 | 复盘 | 历史
```

焦点模式只改变同一画布中对象的显示权重和操作入口，不改变对象归属。

## 第一阶段目标

当前仓库优先沉淀 **Feature 01：图谱式 / 有机式会话画布**。

这一功能将成为后续能力的空间底座，包括：

- AI 绘图与多方案分支
- 图像分层与 PSD / PPT 还原
- PPT 生成与审美确认流程
- Rhino / Grasshopper 看图建模工作流
- Hermes / OpenClaw / Codex 等 Agent 协作
- 项目知识沉淀、稳定结论与长期记忆

## 当前架构主线

每个画布 Chat 块将演进为一个持久化 `SessionNode/Session`；登录账号默认绑定长期个人 Agent，一个 Workflow 由多个可分枝 Session 组成，每次执行记录为独立 Run。

产品采用“Canvas Agent 控制面 + 可替换 Runtime”架构：Hermes ACP 是第一代候选 Runtime，Letta 是备用候选，二者都必须通过统一契约和隔离测试。权威入口见 [`docs/architecture/README.md`](docs/architecture/README.md)。

## 当前文档结构

```text
.
├─ README.md
├─ docs/
│  ├─ 00-project-overview.md
│  ├─ 01-organic-graph-chat.md
│  ├─ 02-product-roadmap.md
│  ├─ 03-data-model.md
│  ├─ 04-glossary.md
│  ├─ 05-ui-direction.md
│  ├─ 06-unified-workspace-model.md
│  ├─ architecture/
│  │  ├─ README.md
│  │  ├─ adr/
│  │  │  └─ 0001-canvas-control-plane-and-runtime-adapters.md
│  │  ├─ agent-session-domain-model.md
│  │  ├─ postgres-schema.md
│  │  ├─ runtime-adapter-contract.md
│  │  ├─ hermes-acp-capability-gates.md
│  │  └─ development-roadmap.md
│  └─ superpowers/
│     ├─ specs/
│     └─ plans/
└─ packages/
   ├─ core/
   ├─ ai/
   └─ db/
```

## 关键词

- 图谱式会话 Graph-based Conversation
- 有机式会话 Organic Conversation
- 统一工作台 Unified Workspace
- 焦点模式 Focus Mode
- 语义锚点 Semantic Anchor
- 分枝 Branching
- 回流 Feedback / Reintegration
- 剪枝 Pruning
- 落叶 Decay
- 腐殖化 Humification
- 主线重构 Trunk Reconstruction

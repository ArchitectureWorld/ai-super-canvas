# 世界画布与多尺度子图设计规格

- 日期：2026-07-23
- 状态：**Proposed / 待用户审阅**
- 产品基线：[`docs/09-world-canvas.md`](../../09-world-canvas.md)
- 范围：顶层世界画布、项目门户、跨项目关系、语义缩放、全局导航和 AI 关系建议
- 不包含：本文件之后的详细实施计划、数据库迁移或前端代码

## 1. 决策摘要

AI Super Canvas 增加一个顶层 **World Canvas / 世界画布**，用于呈现用户有权访问的项目、领域、能力、基础设施和成果之间的关系。

该设计采用：

> **分层投影 + 语义缩放 + 项目门户引用 + 有类型的跨项目关系**

而不是：

- 项目列表式 Dashboard；
- 把每个项目内部所有节点一次性塞进一张超大图；
- 把世界画布另做成第二套工作台；
- 将 `Workspace`、`Workflow`、`SessionNode` 或 `SessionEdge` 政名后复用为跨项目模型。

## 2. 用户问题与成功标准

### 2.1 用户问题

复杂的长期 AI 工作会逐渐形成多个项目、仓库、Skill、Agent、设备、服务和成果。仅靠项目列表、文件夹和聊天历史，用户难以回答：

- 我做过哪些事情？
- 哪些项目属于同一条产品线或技术路线？
- 某个 Agent、Skill、设备或服务支持哪些项目？
- 哪些项目共享资产或重复建设？
- 一个旧项目后来被什么替代？
- 我现在应该从哪个项目、Workflow 或 Session 继续？

### 2.2 成功标准

世界画布 V0.1 成功时，用户可以：

1. 在一个视图中看到主要领域和项目；
2. 通过有类型的关系理解项目依赖、演化和成果；
3. 从世界总览连续进入项目门户和真实 Workflow/Session；
4. 搜索一个能力或项目并查看影响范围；
5. 返回世界视图时保持原位置和尺度；
6. 接受或拒绝 AI 提出的关系建议；
7. 确认世界画布不复制项目事实源、不越过 Workspace 权限，也不打乱当前 Agent-Session 路线。

## 3. 方案比较

### 3.1 方案 A：项目列表 + 统计 Dashboard

```text
最近项目
项目状态
活动时间
里程碑统计
```

优点：

- 实现最简单；
- 容易适配移动端；
- 适合按时间、状态或负责人排序。

缺点：

- 无法表达项目之间的依赖、演化和共享；
- 不能形成空间记忆；
- 无法成为 Context Compiler 的结构化导航输入；
- 最终仍然需要另一个图谱页面。

结论：只作为世界画布的表格投影，不作为顶层主模型。

### 3.2 方案 B：单张超大事实图

把所有 Workspace、Workflow、Session、Message、Artifact、文件和关系全部放在一张无限画布中。

优点：

- 概念上只有一张图；
- 任意对象理论上都可直接连接。

缺点：

- 首屏信息密度失控；
- 权限、加载和布局成本极高；
- 项目内部关系会淹没跨项目关系；
- 用户缩放时难以理解尺度切换；
- 容易错误复用 `SessionEdge` 处理跨 Workflow 关系。

结论：拒绝。

### 3.3 方案 C：分层投影 + 项目门户 + 语义缩放

世界层只展示领域、项目门户、能力、基础设施、成果和跨项目关系。项目内部数据在聚焦或显式进入项目后再加载。

优点：

- 顶层图可读；
- 保留空间连续性；
- 不复制项目事实源；
- 适合权限过滤和渐进加载；
- 可以同时提供图、表、时间线等投影；
- 与现有 Workflow/Session 领域模型保持边界。

代价：

- 需要独立世界索引和投影层；
- 需要明确跨尺度导航状态；
- 需要区分 `WorldRelation` 与 `SessionEdge`。

结论：**采用方案 C**。

## 4. 设计原则

1. **世界画布是顶层投影，不是第二套事实源。**
2. **一张产品图谱，多种尺度与投影。** 世界图、项目图、表格和时间线引用同一对象身份。
3. **项目门户只保存引用、布局和少量显示覆盖。** 状态、活动和成果从项目事实源派生。
4. **跨项目关系必须有类型、方向、来源和审计。**
5. **AI 只提出 Proposal。** 未确认关系不得进入正式图谱或高风险上下文。
6. **权限过滤先于投影。** 前端不得先拿到不可见节点再隐藏。
7. **渐进加载。** 世界层不得预取所有 Session、Message 和 Run。
8. **空间稳定优先。** 新增项目不能让用户已经整理好的世界布局整体跳动。
9. **不打乱当前控制面主线。** 本设计不改变 S1–S4 的依赖顺序。

## 5. 与现有权威架构的边界

Accepted Agent-Session 架构定义：

```text
Account
└── Workspace（授权边界）
    └── Workflow（一个目标下的主干与 Session 生长图）
        ├── TrunkRevision
        ├── BranchAnchor
        ├── SessionNode
        └── SessionEdge（不得跨 Workflow）
```

世界画布在此之上增加读取和导航层：

```text
Account-visible resource index
└── WorldCanvasProjection
    ├── DomainNode
    ├── ProjectPortalNode ─references─> Workflow / ExternalProjectDescriptor
    ├── CapabilityNode
    ├── InfrastructureNode
    ├── DeliverableNode
    └── WorldRelation
```

本设计明确不做以下偷换：

- 不把 `Account` 当作世界画布节点容器；
- 不把 `Workspace` 改成“项目”；
- 不强制一个项目永久等于一个 `Workflow`；
- 不允许 `SessionEdge` 跨 Workflow；
- 不让世界关系直接修改 TrunkRevision、Session 或 Artifact；
- 不在没有 ADR 的情况下新增正式 `Project` 聚合。

### 5.1 V0.1 项目引用

V0.1 使用可判别引用：

```ts
export type ProjectRef =
  | {
      kind: 'workflow';
      workspaceId: string;
      workflowId: string;
    }
  | {
      kind: 'external-project';
      sourceKind: 'repository' | 'folder' | 'url' | 'manual';
      externalId: string;
      canonicalUri?: string;
    };
```

约束：

- `workflow` 引用必须经过 Workspace 权限检查；
- `external-project` 必须由用户显式登记或确认导入；
- V0.1 不自动递归扫描整个磁盘；
- 如果后续需要项目包含多个 Workflow，应新增 `Project` ADR，而不是改变 `ProjectRef` 的含义。

## 6. 组件架构

```text
┌─────────────────────────────────────────────────────────────┐
│                     World Canvas UI                         │
│ Graph View | Search | Breadcrumb | Inspector | Filters     │
└─────────────────────────────┬───────────────────────────────┘
                              │ projection commands
┌─────────────────────────────▼───────────────────────────────┐
│               World Projection Application Layer           │
│ Semantic Zoom | Portal Summary | Layout | Navigation       │
│ Relation Filter | Proposal Preview | Return-state          │
└───────────────┬─────────────────────┬───────────────────────┘
                │                     │
┌───────────────▼────────────┐  ┌─────▼───────────────────────┐
│ Accessible Resource Index │  │ World Graph Store           │
│ Workspace/Workflow        │  │ Domain / Portal / Relation  │
│ Artifact/Activity Summary │  │ Layout / Proposal / Audit   │
│ External Project Registry │  └─────────────────────────────┘
└───────────────┬────────────┘
                │ permission-filtered refs
┌───────────────▼─────────────────────────────────────────────┐
│ Existing Canvas Control Plane                              │
│ Account | Workspace | Workflow | Session | Run | Artifact  │
└─────────────────────────────────────────────────────────────┘
```

### 6.1 Accessible Resource Index

职责：

- 返回当前 Actor 有权访问的 Workspace、Workflow 和摘要；
- 聚合最近活动、当前主干版本、最近 Session 和主要 Artifact；
- 读取显式登记的外部项目描述；
- 不返回 Message 正文、Agent 私有记忆或不可见资源；
- 为搜索和项目门户提供稳定 read model。

### 6.2 World Graph Store

职责：

- 保存世界画布身份和拥有者；
- 保存手动领域节点、项目门户引用和跨项目关系；
- 保存用户布局覆盖、折叠状态和关系筛选偏好；
- 保存 AI Proposal、用户决定和审计；
- 不保存 Workflow、Session、Run 或 Artifact 的副本。

### 6.3 World Projection Layer

职责：

- 根据当前尺度选择节点投影；
- 组合门户摘要和世界布局；
- 过滤弱关系和不可见端点；
- 管理从世界视图进入项目以及返回时的导航状态；
- 生成 CanvasAdapter 所需的渲染节点和边。

## 7. 概念数据模型

以下类型是设计契约，不在独立 ADR 前自动成为数据库权威模型。

```ts
export type WorldNodeKind =
  | 'domain'
  | 'project-portal'
  | 'capability'
  | 'infrastructure'
  | 'deliverable';

export interface WorldCanvasRecord {
  id: string;
  ownerAccountId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorldNodeBase {
  id: string;
  worldCanvasId: string;
  kind: WorldNodeKind;
  title: string;
  description?: string;
  position: { x: number; y: number };
  positionSource: 'auto' | 'user';
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPortalNode extends WorldNodeBase {
  kind: 'project-portal';
  projectRef: ProjectRef;
  displayMode: 'collapsed' | 'summary' | 'expanded';
  manualSummaryOverride?: string;
}
```

### 7.1 关系类型

```ts
export type WorldRelationKind =
  | 'contains'
  | 'depends_on'
  | 'uses'
  | 'produces'
  | 'supports'
  | 'evolves_from'
  | 'supersedes'
  | 'shares_with'
  | 'deployed_on';

export interface WorldRelation {
  id: string;
  worldCanvasId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: WorldRelationKind;
  status: 'confirmed' | 'archived';
  source: 'user' | 'import' | 'accepted-proposal';
  evidenceRefs: string[];
  createdByAccountId: string;
  createdAt: string;
  archivedAt: string | null;
}
```

### 7.2 关系不变量

1. 关系两端必须存在于同一 World Canvas 投影身份空间；
2. `fromNodeId !== toNodeId`；
3. `contains` 子图必须无环；
4. `evolves_from` 和 `supersedes` 不得形成环；
5. `shares_with` 在产品上对称，但数据库只保存一个规范化方向；
6. 任何正式关系必须带来源；AI 产生的候选关系不是 `WorldRelation`；
7. 如果任一端点因权限不可见，关系也不可见；
8. 关系归档保留审计，不做无痕硬删除；
9. 跨 Workspace 关系不赋予额外访问权；
10. 世界关系不能被解释为 Session 亲缘、上下文继承或工具授权。

## 8. 项目门户摘要契约

```ts
export interface ProjectPortalSummary {
  projectRef: ProjectRef;
  title: string;
  goal?: string;
  status: 'active' | 'blocked' | 'dormant' | 'completed' | 'archived' | 'unknown';
  lastActivityAt?: string;
  currentMilestone?: string;
  recentSessionRef?: string;
  primaryArtifactRefs: string[];
  deliverableRefs: string[];
  healthSignals: Array<{
    kind: 'stale' | 'blocked' | 'missing-source' | 'permission-changed';
    label: string;
  }>;
}
```

派生规则：

- `title` 和 `goal` 优先来自内部 Workflow 或外部项目描述；
- `lastActivityAt` 取用户有权看到的最近事件，不泄露隐藏 Session；
- `recentSessionRef` 只能指向当前用户可访问的 Session；
- `primaryArtifactRefs` 只包含正式 Artifact，不把 Message 当成果；
- 手动摘要覆盖只覆盖门户文案，不覆盖项目事实状态；
- 项目源不可用时显示 `missing-source`，门户不会被静默删除。

## 9. 语义缩放状态机

语义层级由画布 zoom、当前 focus 和用户显式进入动作共同决定。

```ts
export type WorldScale =
  | 'world-overview'
  | 'domain-cluster'
  | 'project-portal'
  | 'project-detail';
```

默认规则：

| 层级 | 进入条件 | 显示内容 |
| --- | --- | --- |
| `world-overview` | `zoom <= 0.55` | 领域、核心门户、主要关系、活跃区域 |
| `domain-cluster` | `0.55 < zoom <= 0.9` 或聚焦领域 | 领域内项目、能力、基础设施和正式关系 |
| `project-portal` | `zoom > 0.9` 且项目进入视口中心 | 门户摘要、里程碑、最近活动和主要成果 |
| `project-detail` | 用户显式双击/Enter/“进入项目” | 加载并显示真实 Workflow/Session 画布 |

重要约束：

- 仅缩放到项目附近不会自动加载 Message 正文或 Agent 私有上下文；
- `project-detail` 是显式导航动作，不由 zoom 阈值单独触发；
- 返回时恢复 `worldCanvasId + viewport + focusedNodeId + activeFilters`；
- 用户可以通过键盘进入和返回，不依赖鼠标滚轮；
- 阈值属于投影配置，不写入项目领域对象。

## 10. 渐进加载与数据流

### 10.1 首屏

```text
Authenticate Actor
→ Fetch permission-filtered world index
→ Fetch confirmed top-level relations
→ Build overview projection
→ Restore viewport/layout
→ Render
```

首屏不读取：

- Session Message 正文；
- RunEvent 明细；
- Agent 私有记忆；
- 项目内部完整 Artifact 内容；
- 未进入视口的深层子图。

### 10.2 聚焦项目门户

```text
Focus portal
→ Fetch/refresh ProjectPortalSummary
→ Display summary and relation neighborhood
→ Keep project internals unloaded
```

### 10.3 进入项目

```text
Explicit enter
→ Save world return state
→ Authorize projectRef again
→ Load Workflow/Session projection
→ Navigate with breadcrumb
```

### 10.4 返回世界画布

```text
Return
→ Re-authorize visible world index
→ Restore saved viewport/focus/filter
→ Reconcile changed summaries
```

## 11. 布局策略

### 11.1 稳定布局

- 用户拖动后的节点位置标记为 `positionSource = user`；
- 自动布局只处理未放置节点和新关系邻域；
- 新增项目不得全图重新布局；
- 删除或归档节点后不自动压缩用户空间；
- “整理当前领域”是显式命令，只影响所选领域内的自动布局节点；
- 自动布局结果先预览，用户确认后保存。

### 11.2 默认布局

未放置数据采用分层径向或分区布局：

```text
中心：世界标题 / 当前长期主题
第一圈：Domain
第二圈：Project Portal
外围：Capability / Infrastructure / Deliverable
跨领域关系：保留曲线或桥接边
```

这只是初始布局，不把图强制限制为树。`depends_on`、`shares_with`、`supports` 等关系可以跨领域连接。

## 12. 关系渲染与筛选

- `contains` 使用低视觉权重的组织边或分组边界；
- `depends_on`、`uses`、`deployed_on` 默认有方向箭头；
- `shares_with` 使用无方向视觉表达；
- `evolves_from`、`supersedes` 在历史焦点下提高权重；
- AI Proposal 使用虚线，不与正式关系混淆；
- 默认只显示主要关系，用户可以按类型、状态、时间和领域筛选；
- Inspector 必须展示关系类型、来源、证据、创建者和确认时间；
- 视觉样式不能成为唯一语义，必须同时提供标签和可访问名称。

## 13. AI Proposal

```ts
export interface WorldRelationProposal {
  id: string;
  worldCanvasId: string;
  proposedKind: WorldRelationKind;
  fromNodeId: string;
  toNodeId: string;
  rationale: string;
  evidenceRefs: string[];
  confidence?: number;
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'stale';
  createdByRunId: string;
  createdAt: string;
}
```

流程：

```text
用户请求整理 / 系统发现候选
→ Agent 读取已授权摘要和关系
→ 生成 WorldRelationProposal
→ UI 以虚线显示，并展示依据
→ 用户接受 / 拒绝
→ 再次校验权限和端点版本
→ 接受后原子创建 WorldRelation + AuditEvent
```

约束：

- Agent 不得直接写正式关系；
- Proposal 两端变化、来源失效或权限变化时进入 `stale`；
- 接受 Proposal 不得同时修改项目内容；
- “合并项目”“替代旧项目”“归档项目”必须是独立操作，不能作为接受关系的副作用；
- 低置信度可以影响排序，但不能改变权限或自动执行；
- 拒绝结果保留审计，并可用于减少重复建议。

## 14. Context Compiler / ME-Brain 使用规则

世界图谱可用于：

- 识别与当前目标相关的项目；
- 找到最近 Session 和主要 Artifact；
- 解释项目之间的依赖与演化；
- 选择应注入的 ContextRef 候选；
- 识别已经被替代或归档的项目。

必须遵守：

1. 只使用当前 Actor 可见的节点和正式关系；
2. 候选 Proposal 不作为事实注入；
3. `shares_with` 不等于允许复制私有内容；
4. `depends_on` 不等于自动加载整个依赖项目；
5. 上下文编译结果必须列出来源项目、Artifact/Session 引用和裁剪理由；
6. 高风险工具执行前仍需 ToolGrant 和运行审批；
7. 项目被 `supersedes` 后，旧项目默认降权但仍可按历史请求检索。

## 15. 权限与隐私

- World Canvas 属于账号级个人布局，但节点数据来自账号当前可访问资源；
- 服务端在构建索引前执行 Workspace membership 和资源权限过滤；
- 关系只有在两端均可见时才返回；
- 默认不显示“存在一个你无权访问的隐藏项目”之类的幽灵计数；
- 权限撤销后，门户、摘要、缓存和关系立即从当前投影移除；
- 世界关系不授予对目标项目的访问权；
- 共享 Workflow 不复制个人 Agent 私有记忆；
- 外部项目 URI 必须经过允许列表和协议校验，不能在 UI 中执行任意本地路径或脚本；
- 导出世界图时只包含当前用户可见内容，并标注导出时间与过滤条件。

## 16. 错误与退化状态

| 场景 | 行为 |
| --- | --- |
| 内部 Workflow 被删除或不可见 | 门户从当前投影移除；保留可审计的孤立引用记录，不泄露名称 |
| 外部项目源暂时不可达 | 门户保留，显示 `missing-source`，继续保留手动关系 |
| 项目摘要刷新失败 | 显示最后成功摘要和明确的陈旧时间，不伪装为最新 |
| Proposal 端点变化 | 标记 `stale`，要求重新生成或人工确认新端点 |
| 权限在进入项目时被撤销 | 阻止进入，清除缓存，返回世界视图并解释原因 |
| 世界关系形成非法环 | 命令拒绝并指出冲突路径 |
| 自动布局失败 | 保留当前布局，未放置节点进入待整理区域 |
| 项目内部加载失败 | 世界门户保持可用，提供重试，不破坏返回状态 |

## 17. 主要用户流程

### 17.1 从世界总览继续项目

```text
打开 World Canvas
→ 搜索 “AI Super Canvas”
→ 聚焦项目门户
→ 查看最近 Session 和当前里程碑
→ 点击“继续上次工作”
→ 进入真实 SessionNode
→ 完成工作后返回世界原位置
```

### 17.2 查看基础设施影响范围

```text
选中 NAS / Agent Control Center
→ 查看 uses / deployed_on / supports 关系
→ 过滤仅显示 active 项目
→ 获得受影响项目列表
→ 进入某个项目检查具体依赖
```

### 17.3 确认 AI 关系建议

```text
Agent 建议 “lighting-platform uses Agent Control Center”
→ 世界画布显示虚线
→ Inspector 展示依据
→ 用户接受
→ 写入 confirmed WorldRelation
→ 关系可用于搜索和上下文编译
```

### 17.4 组织新项目

```text
显式登记外部仓库或创建 Workflow
→ 生成未归类项目门户
→ 用户拖入某个 Domain
→ 创建 contains 关系
→ 项目状态从事实源持续更新
```

## 18. MVP 验收

### 18.1 Golden Path

```text
创建个人 World Canvas
→ 注册三个项目门户和两个能力/基础设施节点
→ 创建 Domain 并组织项目
→ 创建 uses / depends_on / produces 关系
→ 在世界、领域、门户三个尺度间缩放
→ 搜索并聚焦项目
→ 显式进入内部 Workflow/Session
→ 返回原世界位置
→ Agent 提出一条关系 Proposal
→ 用户查看依据并接受
→ 权限撤销后相关门户和边消失
```

### 18.2 “ArchitectureWorld 开发全景”种子样例

参考样例应至少覆盖：

- 中央长期主题；
- 硬件系统；
- 家庭 AI 系统；
- 统一 AI 工作台；
- 网站开发；
- 独立应用 / 文件项目；
- 多元知识产品线；
- Skill 基础设施；
- 专业流水线 / 领域服务；
- 跨领域的 Agent、Skill、部署和演化关系。

验收结果必须证明该图可以从“人工绘制的静态 SVG”升级为：

- 有对象身份；
- 有类型关系；
- 有权限边界；
- 有项目事实源；
- 有语义缩放；
- 有连续导航；
- 有 AI Proposal；
- 可供 Context Compiler 使用的动态世界模型。

## 19. 测试策略

### 19.1 单元测试

- 语义缩放层级选择；
- 项目门户摘要派生；
- `contains`、`evolves_from`、`supersedes` 环检测；
- `shares_with` 规范化方向；
- 权限过滤后关系端点完整性；
- 返回状态序列化与恢复；
- 自动布局只移动 `positionSource = auto` 的节点。

### 19.2 集成测试

- Workflow 活动更新后门户摘要刷新；
- Artifact 创建后 Deliverable/摘要投影更新；
- 接受 Proposal 原子创建关系和审计事件；
- 权限撤销后索引、缓存和边同时失效；
- 外部项目不可达时保留最后摘要并标记陈旧；
- 进入项目时再次授权，不依赖世界首屏旧权限。

### 19.3 浏览器 E2E

- 世界总览 → 项目门户 → Session → 返回原视口；
- 键盘搜索、进入和返回；
- 关系筛选和 Inspector；
- AI 虚线建议与接受/拒绝；
- 权限变化后的无数据泄露；
- 300 个顶层节点和 1,000 条关系下可完成缩放、搜索和聚焦。

### 19.4 性能目标

V0.1 桌面目标：

- 首屏只加载顶层索引和主要关系；
- 已加载索引上的搜索反馈目标小于 150 ms；
- 尺度切换和过滤不触发项目内部全量请求；
- 300 节点 / 1,000 关系样例中，拖动和缩放保持可交互；
- 项目详情数据只在显式进入后加载；
- 返回世界视图不重新布局用户固定节点。

性能目标必须通过实际测试报告验证，不能仅凭主观体验宣称达标。

## 20. 分阶段交付

### Phase A：只读种子投影

- 使用“ArchitectureWorld 开发全景”整理结构化种子数据；
- 实现世界、领域和项目门户三种投影；
- 支持搜索、聚焦、面包屑和返回状态；
- 不接 AI，不写跨项目关系。

### Phase B：项目注册与正式关系

- 内部 Workflow 项目门户；
- 显式外部项目登记；
- Domain、WorldRelation、布局覆盖和审计；
- 权限过滤和摘要刷新。

### Phase C：AI Proposal

- 关系候选生成；
- 虚线预览、证据和接受/拒绝；
- stale 检查与审计；
- 不自动合并或归档项目。

### Phase D：全局上下文导航

- Context Compiler 使用正式关系；
- “继续相关项目”检索；
- 影响范围和被替代项目识别；
- 严格的 ContextRef、ToolGrant 和权限边界。

本规格获用户确认后，再单独编写实施计划；实施计划不得越过当前 Agent-Session 路线的依赖条件。

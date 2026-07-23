# 世界画布：顶层项目图谱

> 文档状态：**Product Baseline / 产品基线**  
> 日期：2026-07-23  
> 适用范围：AI Super Canvas 的顶层信息架构、跨项目导航、语义缩放和世界图谱产品语言。  
> Agent、Workspace、Workflow、Session、Run、Artifact 和 Proposal 的权威语义仍以 [`docs/architecture/README.md`](./architecture/README.md) 为准。

## 1. 一句话决策

> AI Super Canvas 的最顶层应是一张 **World Canvas / 世界画布**：它以图谱方式呈现用户正在建设的项目、领域、能力、基础设施和成果，并通过语义缩放连续进入项目门户、项目内部 Workflow/Session 图和具体语义对象。

世界画布不是传统 Dashboard，也不是简单的“最近项目”列表。它主要回答：

- 我做过和正在做哪些事情？
- 这些项目、能力、资源和成果之间是什么关系？
- 某项能力或基础设施正在支持哪些项目？
- 一个旧项目后来演化成了什么？
- 我下一步应该从哪里继续？

## 2. 与统一工作台的关系

世界画布不创建第二套工作台，也不把所有项目的数据复制进一个超大 Workspace。

更准确的结构是：

```text
同一套产品图谱与导航系统
├── L0  世界画布 / World Canvas
│   └── 领域、项目门户、能力、基础设施、成果和跨项目关系
├── L1  项目门户 / Project Portal
│   └── 项目目标、状态、里程碑、最近活动和项目子图入口
├── L2  项目内部画布
│   └── Workflow、主干、Chat Session、科研块、创意块、任务块、文件和 Artifact
└── L3  具体语义对象
    └── Message、Anchor、Run、Problem、Evidence、Method、Claim、Task、Deliverable 等
```

这些层级不是互相割裂的页面，而是同一信息空间在不同尺度下的投影。

需要特别说明：当前 Accepted 架构把 `Workspace` 定义为成员和资源的授权边界，把 `Workflow` 定义为一个目标下的权威主干和 Session 生长图。因此：

- 世界画布首先是**账号可见资源的顶层投影**，不是对 `Workspace` 的重新定义；
- 项目门户首先是 UI/导航对象，不立即新增一个与 `Workspace` 或 `Workflow` 冲突的持久化实体；
- 第一版项目门户可以引用一个内部 `Workflow` 或一个显式登记的外部项目描述；
- 如果未来需要“一项目包含多个 Workflow”的正式领域对象，必须通过独立 ADR 引入 `Project` 聚合，不能静默复用 `Workspace`、`Workflow` 或 `SessionNode`。

## 3. 世界画布中的顶层对象

第一版只定义五类顶层对象：

| 类型 | 含义 | 示例 |
| --- | --- | --- |
| `domain` | 长期领域、产品线或工作方向 | 网站开发、专业流水线、统一 AI 工作台 |
| `project-portal` | 某个项目或 Workflow 的入口与摘要投影 | AI Super Canvas、lighting-platform |
| `capability` | 可被多个项目复用的能力 | Agent、Skill、科研能力、图像生成能力 |
| `infrastructure` | 项目运行依赖的设备、服务和控制面 | NAS、服务器、Agent Control Center |
| `deliverable` | 项目形成的正式成果或产品 | 网站、Release、文档、平台、应用 |

这些对象的作用不同，不能全部退化为“项目卡片”。

## 4. 有类型的跨项目关系

世界画布中的关系必须表达业务语义，不能只画无类型连线。

第一版关系集合固定为：

| 关系 | 含义 |
| --- | --- |
| `contains` | 领域、组合或项目包含某对象 |
| `depends_on` | 一个项目或成果依赖另一对象 |
| `uses` | 项目使用某项能力、Skill、Agent 或资源 |
| `produces` | 项目产生某个成果 |
| `supports` | 某能力、基础设施或项目支持另一项目 |
| `evolves_from` | 当前项目从旧项目或旧方案演化而来 |
| `supersedes` | 当前对象明确替代旧对象 |
| `shares_with` | 两个项目共享资产、知识、代码或能力 |
| `deployed_on` | 项目或成果部署在某个设备、服务或平台上 |

`SessionEdge` 仍然只用于同一 Workflow 内的 SessionNode 关系。跨 Workflow、跨 Workspace 或外部项目的关系必须使用独立的 `WorldRelation`/资源关系模型，不能绕过现有领域不变量。

## 5. 语义缩放

世界画布成立的前提不是无限缩放，而是 **Semantic Zoom / 语义缩放**。缩放改变信息密度和对象投影，不改变事实源。

### 5.1 远景：世界总览

显示：

- 领域与产品线；
- 核心项目门户；
- 主要跨项目关系；
- 活跃、停滞和近期变化区域。

隐藏：

- Session、Message、Run 等项目内部细节；
- 大多数弱关系和辅助元数据。

### 5.2 中景：领域或项目群

显示：

- 具体项目；
- 项目状态、最近活动和当前里程碑；
- Agent、Skill、仓库和基础设施依赖；
- 项目间正式关系。

### 5.3 近景：项目门户

显示：

- 项目目标和当前状态；
- 最近一次 Session；
- 当前 Workflow/里程碑；
- 主要 Artifact 和 Deliverable；
- “进入项目”以及继续上次工作的入口。

### 5.4 深景：项目内部

进入项目的 Workflow/Session 画布后，才加载：

- 主干、BranchAnchor 和 SessionNode；
- Chat、科研、创意和任务块；
- Message、Run、Artifact、Proposal 和文件级细节。

世界视图不得一次性加载所有项目内部节点。投影和数据加载都必须按层级渐进展开。

## 6. 项目门户

`ProjectPortalNode` 是对项目事实源的引用和摘要，不是项目数据副本。

门户可以保存：

```text
portalId
projectRef
worldCanvasLayout
collapsed/expanded display mode
manual summary override（可选）
```

门户应从项目或 Workflow 事实源派生：

```text
项目名称
一句话目标
当前状态
最近活动时间
当前里程碑
最近 Session
主要 Artifact / Deliverable
健康或阻塞提示
```

当项目名称、状态、最近活动或成果发生变化时，世界画布应通过投影更新，而不是要求用户在两个地方重复维护。

## 7. 导航与空间连续性

世界画布的核心交互不是“点击卡片后跳到另一个陌生页面”，而是保持尺度和上下文连续：

```text
世界总览
→ 聚焦某个领域
→ 放大项目门户
→ 展开项目子图
→ 进入 Workflow/Session
→ 返回原世界位置
```

第一版必须提供：

- 搜索并聚焦对象；
- 面包屑和当前尺度提示；
- 一键返回世界视角；
- 进入项目后保持返回位置；
- 关系筛选与类型图例；
- 项目门户折叠/展开；
- 稳定布局覆盖，避免新增项目导致整张图跳动。

## 8. AI 的权限边界

AI 在世界画布中是整理和导航助手，不是自动造图者。

AI 可以：

- 建议项目归类；
- 建议可能存在的依赖、演化或共享关系；
- 总结项目状态；
- 提示长期停滞、重复建设或潜在影响范围；
- 根据用户目标建议应该打开哪些项目和 Session。

AI 不可以：

- 静默创建正式项目或跨项目关系；
- 自动合并、替代、归档或删除项目；
- 将推断关系当成事实写入图谱；
- 绕过 Workspace 权限读取或暴露不可见项目；
- 自动连续创建科研块、任务块或其它专项结构。

建议关系的默认流程是：

```text
AI 发现候选关系
→ 生成 Proposal
→ 在画布上以虚线建议呈现
→ 用户查看依据和影响
→ 用户接受或拒绝
→ 接受后写入正式 WorldRelation
```

## 9. 世界图谱与全局上下文

世界画布也是长期个人 Agent、ME-Brain 或 Context Compiler 的导航输入。

例如用户说：

> 继续我之前那个和 Zotero、科研流程有关的项目。

系统可以沿已确认关系检索：

```text
科研领域
→ Zotero capability / Skill
→ 文献处理流水线
→ 关联项目门户
→ 最近 Workflow / Session
→ 未完成里程碑
```

上下文编译器必须区分：

- 已确认的正式关系；
- AI 尚未确认的候选关系；
- 当前账号无权访问的隐藏资源；
- 已被 `supersedes` 替代或已经归档的历史项目。

候选关系只能用于向用户解释建议，不能被当作事实自动注入高风险执行上下文。

## 10. MVP 边界

世界画布 V0.1 只交付以下能力：

1. 为当前账号创建一张世界画布投影；
2. 将已有 Workflow 或显式登记的外部项目显示为项目门户；
3. 手动创建领域分组，并把项目门户组织到领域中；
4. 支持本文件定义的少量关系类型；
5. 显示项目状态、最近活动、当前里程碑和主要成果摘要；
6. 支持远景、中景、近景、深景四级语义缩放；
7. 支持搜索、聚焦、面包屑、返回世界视角和稳定布局；
8. 支持 AI 生成关系 Proposal，且必须由用户确认；
9. 点击或继续放大项目门户后进入真实 Workflow/Session 画布；
10. 权限变化后立即隐藏无权访问的门户和关系。

V0.1 不做：

- 把所有项目内部节点暴露在世界层；
- 自动扫描整个磁盘并静默导入项目；
- 自动生成大量关系；
- 通用图数据库推理平台；
- 复杂运营指标 Dashboard；
- 多人实时共同编辑世界布局；
- 把世界画布提前插入当前 S1–S4 控制面主线并打乱依赖顺序。

## 11. 与当前发展路线的关系

本产品基线不改变 [`docs/architecture/development-roadmap.md`](./architecture/development-roadmap.md) 的当前依赖顺序。

- S1–S3 先证明可持久化的 Workflow/Session/Run 和真实 Chat SessionNode；
- S4 证明 Artifact、Proposal 和主干回流；
- 世界画布的只读项目门户原型可以在这些阶段后并行验证；
- 正式跨项目关系、权限过滤和全局上下文编译应建立在服务器事实源、Artifact 和 Workspace 授权边界之上；
- 如需引入正式 `Project` 聚合，必须先提交独立 ADR、数据库迁移和权限模型。

## 12. 参考验收样例

“ArchitectureWorld 开发全景关系图”可作为世界画布的种子样例。验收时应证明：

- 中央能够表达整个开发世界；
- 硬件系统、家庭 AI 系统、统一 AI 工作台、网站开发、独立应用、Skill 基础设施、专业流水线等可作为领域或项目群；
- lighting-platform、AI Super Canvas、Agent Control Center、skill-hub 等可以成为独立门户或能力节点；
- 项目之间的跨分支依赖仍然存在，而不是被强制压成一棵树；
- 远景不会显示项目内部全部 Session；
- 放大项目后可以连续进入真实项目空间；
- 项目状态变化能够回写世界视图；
- Agent 可以使用已确认图谱找到相关上下文，但不能越权或把候选关系当成事实。

完整可实施设计见：

[`docs/superpowers/specs/2026-07-23-world-canvas-and-multiscale-subgraphs-design.md`](./superpowers/specs/2026-07-23-world-canvas-and-multiscale-subgraphs-design.md)

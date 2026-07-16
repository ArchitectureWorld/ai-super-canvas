# AI 超级画板统一有机工作台设计规格

> 状态：历史综合设计。产品原则和植物语义可复用；Agent、Session、Run、Runtime、Artifact/Proposal 与画布投影的权威边界见 [`docs/architecture`](../../architecture/README.md)。

- 日期：2026-07-12
- 当前状态：Historical；原状态为“稳定设计，进入实施规划”
- 范围：Feature 01——图谱式 / 有机式会话画布的可实施 MVP

## 1. 目标

本规格把已经稳定的产品原则转换为工程边界、交互闭环和数据契约。

AI 超级画板不是多个工作台的拼接，而是一张统一的有机式 AI 工作画布。第一阶段必须证明以下核心价值：

> 用户可以从任意文本语义对象创建分支，在独立上下文中探索，把有效结论回流到主线，并把无效分支代谢为可复用经验；所有过程都可追溯、可确认、可撤销。

第一阶段不以图片生成、PPT、Rhino 或多 Agent 编排为验收对象，但架构必须允许这些能力以后作为同一画布中的新对象类型和焦点模式接入。

## 2. 稳定产品原则

1. **一个统一工作台**：生长、创意、资产、任务、复盘、历史是同一画布的焦点模式，不是不同产品或页面。
2. **语义对象级分枝**：分支起点可以是词、短语、句子、段落、图片区域、文件片段或任何画布对象；MVP 先完成文本锚点。
3. **同一对象，多种投影**：焦点模式只改变显示权重、可见关系和操作入口，不复制对象。
4. **AI 只提出变更，不直接污染画布**：AI 结果先形成结构化 Proposal，经用户确认后转为 Command 执行。
5. **删除优先解释为代谢**：剪枝、落叶、休眠、腐殖化和归档均保留明确语义与审计记录。
6. **动态优先于装饰**：动效必须帮助用户理解来源、状态、回流和代谢，不做无意义的植物动画。
7. **所有关键动作可追溯、可撤销**：分支来源、AI 输入、回流目标、代谢摘要和主线重构都有事件记录。

## 3. MVP Golden Path

MVP 只验收一条完整主路径：

1. 用户创建 Workspace，并输入一个主问题。
2. 系统生成主干文本节点和主线会话。
3. 用户选中一个词、句子或段落，形成 Semantic Anchor。
4. 用户从该锚点创建 Branch。
5. Branch 拥有独立会话，但保留来源锚点和来源修订版本。
6. AI 在分支内流式输出；运行过程可见、可取消。
7. 用户把分支结果整理为 Conclusion Card。
8. 系统生成回流预览，展示将新增或修改的主线内容。
9. 用户确认后应用回流；主线产生新修订并记录影响关系。
10. 用户将该分支标记为已整合，或对无效分支执行休眠 / 腐殖化。
11. Growth Timeline 可完整重放上述关键事件。
12. 用户可以撤销最后一次结构变更，并重新应用。

## 4. 技术选型结论

### 4.1 画布引擎候选

| 方案 | 优点 | 主要风险 | 结论 |
|---|---|---|---|
| React Flow + 自定义节点 | MIT；天然节点 / 边模型；React DOM 节点适合富文本；支持子流、保存恢复和自定义交互 | 无限画布自由度与白板手感需额外打磨 | **MVP 推荐** |
| tldraw SDK | 白板手感、形状系统、绑定、富文本和持久化能力完整 | 生产用途涉及商业许可；域模型容易被 SDK Store 绑定 | 作为后续可替换渲染器和交互标杆 |
| Fabric / Konva 自研 | 控制力最高 | 富文本、节点系统、连线、可访问性、撤销和布局成本过高 | MVP 不采用 |

### 4.2 推荐方案

采用 **React Flow 作为首个 CanvasAdapter 实现**，但领域对象不得直接依赖 React Flow 的 Node / Edge 类型。

必须定义独立的 `CanvasAdapter`：

```ts
export interface CanvasAdapter {
  project(graph: WorkspaceGraph, focus: FocusMode): CanvasProjection;
  fitToSelection(objectIds: ObjectId[]): void;
  focusObject(objectId: ObjectId): void;
  exportViewport(): Promise<Blob>;
}
```

这样可以：

- 在不改变领域数据的情况下替换或并行验证 tldraw。
- 避免把 React Flow 的坐标、句柄和 UI 状态写入核心业务模型。
- 让创意执行节点、图片节点和复杂连接后续沿用同一模型。

### 4.3 推荐技术栈

- 前端与 BFF：Next.js 16 App Router + TypeScript
- 画布：React Flow 12
- 富文本：Tiptap / ProseMirror
- 客户端状态：Zustand
- 自动布局：ELK.js，放入 Web Worker
- 数据库：PostgreSQL 18
- ORM / Migration：Drizzle ORM
- AI：Provider Adapter；首个实现为 OpenAI Responses API，使用 SSE 流式响应和 Structured Outputs
- 本地缓存：IndexedDB
- 单元 / 集成测试：Vitest + React Testing Library
- 端到端测试：Playwright
- 运行环境：Docker Compose，支持本地与私有服务器部署

## 5. 总体架构

```text
┌────────────────────────────────────────────────────────┐
│                    Unified Workspace UI                 │
│ Top Bar | Mainline | Canvas | Inspector | Card Drawer  │
└──────────────────────────┬─────────────────────────────┘
                           │ Commands / Proposals
┌──────────────────────────▼─────────────────────────────┐
│                    Application Layer                   │
│ Anchor / Branch / Card / Integration / Metabolism     │
│ Focus Projection / AI Run / Timeline / Undo-Redo      │
└──────────────────────────┬─────────────────────────────┘
                           │ Domain Events
┌──────────────────────────▼─────────────────────────────┐
│                      Domain Layer                      │
│ Object / Revision / Edge / Anchor / Branch / Card     │
│ Proposal / Command / Event / Snapshot / FocusMode     │
└──────────────────────────┬─────────────────────────────┘
                           │ Repositories
┌──────────────────────────▼─────────────────────────────┐
│                   Persistence + AI                     │
│ PostgreSQL | Event Log | Snapshots | IndexedDB | LLM   │
└────────────────────────────────────────────────────────┘
```

## 6. 核心领域模型

### 6.1 WorkspaceObject

所有可在画布中出现或被引用的对象共享一个身份模型。

```ts
export type ObjectKind =
  | 'trunk'
  | 'message'
  | 'branch'
  | 'card'
  | 'asset'
  | 'task'
  | 'ai-run';

export interface WorkspaceObject<TProps = Record<string, unknown>> {
  id: ObjectId;
  workspaceId: WorkspaceId;
  kind: ObjectKind;
  currentRevisionId: RevisionId;
  props: TProps;
  position: { x: number; y: number };
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
```

### 6.2 不可变修订

文本、卡片和分支摘要不得原位覆盖。每次确认后的内容变更生成不可变 `ObjectRevision`：

```ts
export interface ObjectRevision {
  id: RevisionId;
  objectId: ObjectId;
  parentRevisionId: RevisionId | null;
  content: unknown;
  contentHash: string;
  authorType: 'user' | 'ai' | 'system';
  createdAt: string;
}
```

不可变修订是语义锚点稳定性的前提，也是历史恢复、主线重构和 AI 审计的依据。

### 6.3 Edge

```ts
export type EdgeKind =
  | 'derives'
  | 'supports'
  | 'contradicts'
  | 'refines'
  | 'references'
  | 'depends-on'
  | 'feeds-back-to'
  | 'metabolizes-into';

export interface WorkspaceEdge {
  id: EdgeId;
  workspaceId: WorkspaceId;
  fromObjectId: ObjectId;
  toObjectId: ObjectId;
  kind: EdgeKind;
  props: Record<string, unknown>;
  createdAt: string;
  deletedAt: string | null;
}
```

边表达业务关系，不承担纯视觉连线职责。React Flow 的 Handle 和 Edge 只是在 CanvasProjection 中的表现。

## 7. 语义锚点设计

### 7.1 文本锚点

文本锚点采用“修订固定 + 位置选择器 + 引文选择器”组合：

```ts
export interface TextAnchorSelector {
  type: 'text';
  sourceObjectId: ObjectId;
  sourceRevisionId: RevisionId;
  position: { start: number; end: number };
  quote: {
    exact: string;
    prefix: string;
    suffix: string;
  };
  sourceContentHash: string;
}
```

规则：

1. 原始来源永远指向不可变修订。
2. 在来源新修订中显示锚点时，先按位置匹配。
3. 位置失效时，用 `exact + prefix + suffix` 重新定位。
4. 无法唯一定位时标记 `orphaned`，不得静默连接到错误文本。
5. 用户可以手动重新锚定，产生 `anchor.retargeted` 事件。

### 7.2 后续多模态锚点

MVP 不实现，但模型预留：

```ts
export type AnchorSelector =
  | TextAnchorSelector
  | {
      type: 'image-region';
      assetRevisionId: RevisionId;
      bbox: { x: number; y: number; width: number; height: number };
      svgPath?: string;
    }
  | {
      type: 'file-fragment';
      fileRevisionId: RevisionId;
      page?: number;
      blockId?: string;
      quote?: TextAnchorSelector['quote'];
    };
```

图片坐标使用 0–1 归一化值，避免缩放后失效。

## 8. 分支生命周期

MVP 不把八种植物隐喻都做成顶级状态，以避免状态机膨胀。

```ts
export type BranchState =
  | 'active'
  | 'review'
  | 'integrated'
  | 'dormant'
  | 'metabolized';

export type MetabolismKind =
  | 'prune'
  | 'decay'
  | 'humify'
  | 'archive';
```

状态转换：

```text
active → review → integrated
active → dormant → active
active/review/integrated/dormant → metabolized
```

约束：

- `integrated` 表示至少有一个结果回流，不等于分支不可继续。
- `metabolized` 必须附带 `MetabolismRecord`。
- `humify` 必须保留养分摘要、失败原因或约束卡。
- `prune` 可以不生成新卡，但必须保留事件和操作者。
- 所有转换必须通过 Command 执行并可撤销。

## 9. AI Proposal 模型

AI 运行不得直接写入 `WorkspaceObject`。

```ts
export type Proposal =
  | BranchExpansionProposal
  | CardProposal
  | IntegrationProposal
  | MetabolismProposal;

export interface ProposalEnvelope<T extends Proposal> {
  id: ProposalId;
  workspaceId: WorkspaceId;
  aiRunId: AiRunId;
  type: T['type'];
  payload: T;
  status: 'streaming' | 'ready' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
}
```

执行流程：

```text
用户动作
→ 创建 AI Run
→ SSE 流式显示文本
→ Structured Output 形成 Proposal
→ 用户查看 Diff / Preview
→ Accept
→ Command 事务执行
→ Domain Events
→ 投影更新
```

必须满足：

- 可取消 AI Run。
- AI Run 记录模型、输入对象修订、系统提示版本和输出。
- Proposal 接受前不影响主线。
- 接受后仍可以通过逆向 Command 撤销。
- 自动建议可以出现，但默认不自动应用。

## 10. 回流与主线重构

### 10.1 回流不是复制粘贴

`IntegrationProposal` 必须显式说明：

- 来源卡片 / 分支。
- 目标主线对象与目标修订。
- 变更类型：append / replace-section / create-linked-card。
- 变更前后 Diff。
- 新增关系边。
- 影响的主线摘要。

```ts
export interface IntegrationProposal {
  type: 'integration';
  sourceObjectIds: ObjectId[];
  targetObjectId: ObjectId;
  targetRevisionId: RevisionId;
  operation: 'append' | 'replace-section' | 'create-linked-card';
  nextContent: unknown;
  rationale: string;
  edgeKinds: EdgeKind[];
}
```

### 10.2 并发冲突

如果用户确认前目标主线已经产生新修订：

- Proposal 状态变为 `expired`。
- 系统重新基于最新修订生成预览。
- 禁止把旧 Proposal 直接套用到新内容。

## 11. 焦点模式

```ts
export type FocusMode =
  | 'growth'
  | 'creative'
  | 'assets'
  | 'tasks'
  | 'review'
  | 'history';
```

焦点模式由纯函数生成投影：

```ts
export interface FocusProjection {
  visibleObjectIds: ObjectId[];
  emphasizedObjectIds: ObjectId[];
  visibleEdgeIds: EdgeId[];
  availableActions: Record<ObjectId, string[]>;
  inspectorSections: string[];
}

export function projectFocus(
  graph: WorkspaceGraph,
  mode: FocusMode,
): FocusProjection;
```

MVP 完整实现 `growth` 和 `history`，其余模式保留入口和投影契约，不实现完整业务功能。

## 12. 事件、历史与持久化

### 12.1 四类历史必须分离

| 历史 | 用途 | 保存方式 |
|---|---|---|
| 操作历史 | 当前会话撤销 / 重做 | 客户端 Command 栈 + 已确认事件 |
| 生长时间线 | 分枝、回流、代谢、重构 | `workspace_events` |
| AI / 生成历史 | 模型运行、输入、输出、费用 | `ai_runs` + `proposals` |
| 版本历史 | 对象修订和工作区恢复 | `object_revisions` + `workspace_snapshots` |

### 12.2 数据库原则

不得把整个 Workspace 长期存成一个巨大 JSONB 行。

推荐核心表：

```text
workspaces
workspace_objects
object_revisions
workspace_edges
semantic_anchors
branches
cards
metabolism_records
ai_runs
proposals
workspace_events
workspace_snapshots
assets
```

JSONB 只用于：

- 不同对象类型的 props。
- Anchor selector。
- Event payload。
- Proposal payload。

对象身份、外键、状态、时间和常用查询字段必须规范化。

### 12.3 Event Store

`workspace_events` 为只追加日志：

```ts
export interface WorkspaceEvent<T = unknown> {
  id: EventId;
  workspaceId: WorkspaceId;
  sequence: number;
  type: string;
  aggregateId: string;
  actorType: 'user' | 'ai' | 'system';
  actorId: string | null;
  payload: T;
  inversePayload: T | null;
  occurredAt: string;
}
```

事件示例：

```text
workspace.created
object.created
revision.created
anchor.created
anchor.retargeted
branch.created
branch.state-changed
card.created
integration.applied
metabolism.applied
ai-run.started
ai-run.cancelled
proposal.created
proposal.accepted
snapshot.created
```

每个 Workspace 的 `sequence` 必须单调递增，用于并发检查和客户端同步。

## 13. UI 架构

```text
┌────────────────────────────────────────────────────────────┐
│ Minimal Top Bar：Workspace / Search / Focus / Settings     │
├──────────────┬──────────────────────────────┬──────────────┤
│ Mainline     │ Unified Canvas               │ Inspector    │
│ 主问题       │ 主干 / 分支 / 卡片 / 关系    │ Proposal     │
│ 摘要与状态   │                              │ Object Info  │
├──────────────┴──────────────────────────────┴──────────────┤
│ Collapsible Card Drawer / Growth Timeline                 │
└────────────────────────────────────────────────────────────┘
```

设计约束：

- Canvas 始终占主要面积。
- Inspector 按选择或 Proposal 出现，可折叠。
- Card Drawer 与 Timeline 复用底部区域，不常驻占满。
- Focus 切换不路由到新页面。
- 选中文本后先出现轻量浮动菜单，复杂操作再进入 Inspector。
- 分枝动画必须显示来源锚点到新分支的关系。
- 回流应用前必须显示 Diff；应用后短暂高亮受影响对象。
- 腐殖化后完整分支从主视图淡出，但“养分卡”和 Timeline 仍可追溯。

## 14. 命令与撤销

所有改变图谱的操作通过 Command：

```ts
export interface WorkspaceCommand<TResult = void> {
  id: CommandId;
  type: string;
  expectedWorkspaceSequence: number;
  execute(ctx: CommandContext): Promise<TResult>;
  invert(result: TResult): WorkspaceCommand | null;
}
```

第一批 Command：

```text
CreateObjectCommand
MoveObjectsCommand
CreateTextAnchorCommand
CreateBranchCommand
CreateCardCommand
ApplyIntegrationCommand
ChangeBranchStateCommand
ApplyMetabolismCommand
RetargetAnchorCommand
```

文本输入的逐键编辑不写一条事件；在失焦、显式保存或 800ms 空闲后合并成一次修订。

## 15. 非功能要求

### 15.1 性能预算

MVP 验收目标：

- 200 个可见对象时，平移 / 缩放保持可用，不出现连续明显卡顿。
- 首次载入 100 个对象的 Workspace，在本地开发环境中 2 秒内出现可交互骨架。
- 文本锚点菜单在选择结束后 100ms 内出现。
- ELK 自动布局必须在 Web Worker 执行，不阻塞主线程。
- SSE 流式内容每 50–100ms 批量刷新，避免逐 token 重排画布。

### 15.2 可访问性

- 所有图标按钮必须有可见 Tooltip 和 `aria-label`。
- 键盘可在对象间导航，并可打开 Inspector。
- 颜色不是状态的唯一表达；同时使用标签、图标或纹理。
- 动效遵守 `prefers-reduced-motion`。

### 15.3 安全与隐私

- AI Provider Key 只存在服务端。
- AI 调用前只发送被明确引用的对象和上下文摘要。
- AI Run 记录输入对象 ID 与修订，不把完整隐私内容写入日志。
- Workspace API 必须校验当前用户拥有该 Workspace。
- Proposal 和 Command 均校验 `workspaceId` 与对象归属。

## 16. MVP 明确不做

- 图片区域锚点和图像编辑。
- 创意生成节点、模型参数节点和多媒体历史。
- 多人实时协作和 CRDT。
- 自动 Agent 调度。
- 跨 Workspace 全局知识图谱。
- 自动将分支无确认地回流主线。
- 独立图数据库。
- 复杂植物视觉皮肤。

这些能力以后沿用同一对象、事件、Proposal 和 FocusProjection 契约扩展。

## 17. 验收标准

### 17.1 功能验收

- 可以创建、打开、保存 Workspace。
- 可以创建和编辑主干文本节点。
- 可以从词、句子、段落创建稳定文本锚点。
- 可以从锚点创建独立分支并查看来源。
- 可以在分支中流式调用 AI 并取消。
- AI 结果可以形成待确认 Conclusion Card。
- 回流前可查看明确 Diff；确认后主线产生新修订。
- 分支可休眠、恢复、整合、腐殖化。
- 腐殖化保留养分摘要和来源。
- Growth Timeline 可查看完整事件顺序。
- 最近一次结构变更可撤销 / 重做。

### 17.2 数据验收

- Anchor 永远引用具体 Revision。
- 旧 Proposal 不能应用到已变化的目标 Revision。
- Workspace Event Sequence 不重复、不倒退。
- 删除或代谢不会造成孤立外键。
- 重新载入后画布位置、对象状态、锚点、分支和时间线一致。

### 17.3 测试验收

- Domain 和 Command 单元测试覆盖关键状态转换与并发条件。
- Repository 和 API 使用真实 PostgreSQL 跑集成测试。
- Playwright 完整通过 Golden Path。
- E2E 覆盖 AI 失败、取消、Proposal 过期和 Anchor 孤立。

## 18. 架构决策记录

### ADR-001：MVP 采用 React Flow，领域模型保持渲染器无关

理由：React Flow 对节点式有机图谱最贴合，MIT 许可降低商业风险；通过 Adapter 避免技术锁定。

### ADR-002：对象内容不可变修订，语义锚点绑定修订

理由：文本继续编辑时仅用字符位置会漂移；不可变修订允许可靠追溯和回流 Diff。

### ADR-003：AI 输出先 Proposal，后 Command

理由：满足可见、可确认、可回滚，防止 AI 直接污染主线。

### ADR-004：关系数据规范化，事件只追加，Snapshot 加速恢复

理由：避免整包 JSON 覆盖、支持历史、并发检查、审计和未来协作。

### ADR-005：焦点模式是投影，不是页面和数据副本

理由：保持一个统一工作台和对象唯一性。

## 19. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| React Flow 白板手感不足 | 视觉与操作不够自由 | Adapter 隔离；Sprint 0 做交互验证；保留 tldraw 评估 |
| 富文本选择与节点拖动冲突 | 无法稳定选词 | 文本编辑态禁用节点拖动；明确编辑 / 画布模式 |
| 锚点在文本更新后漂移 | 分支来源错误 | Revision 固定 + Position + Quote + orphaned 状态 |
| AI 回流覆盖用户新内容 | 数据损坏 | Target Revision 乐观锁；过期 Proposal 强制重生成 |
| Event Store 过度设计 | MVP 进度拖慢 | 只记录领域事件，不做完整 CQRS；当前状态仍用关系表 |
| 状态隐喻过多 | 用户难理解 | MVP 顶级状态收敛为 5 个；植物词作为动作说明而非全部状态 |
| 画布节点过多导致性能下降 | 操作卡顿 | 视口裁剪、Worker 布局、分层渲染、性能预算测试 |
| AI 运行成本不可控 | 费用和延迟上升 | 明确上下文选择、摘要缓存、取消、token / cost 日志 |
| tldraw 未来替换成本 | 二次开发 | CanvasAdapter、领域对象与 SDK 类型隔离 |

## 20. 自检结论

本规格已完成以下检查：

1. **范围检查**：只包含文本锚点到回流 / 代谢的 MVP；创意执行仅保留扩展接口。
2. **一致性检查**：统一工作台、动态生长层、语义锚点和代谢原则均映射到数据与交互。
3. **许可检查**：MVP 避免把商业许可 SDK 设为唯一基础设施。
4. **数据检查**：锚点、回流和 Proposal 均绑定不可变 Revision，避免静默漂移和并发覆盖。
5. **AI 安全检查**：AI 只生成 Proposal，用户确认后 Command 才改变图谱。
6. **可实施性检查**：所有核心模块均有明确接口，可拆成独立开发与测试任务。
7. **占位符检查**：本文无 TBD / TODO；未实施能力均明确列入非目标。

## 21. 研究依据

- React Flow：自定义节点、状态管理、保存恢复、撤销重做和子流能力。
- tldraw：Editor、Shape、Binding、Rich Text、Persistence 和 AI 工作流模式；同时关注生产许可要求。
- ELK.js：复杂图自动布局和 Web Worker 执行。
- W3C Web Annotation：Text Position、Text Quote、Fragment、SVG Selector 等稳定定位模型。
- PostgreSQL：JSONB、约束和递归查询；关系字段规范化，JSONB 用于类型化扩展。
- OpenAI Responses API：SSE 流式响应、Structured Outputs、工具调用和状态化交互。
- TapNow 实操测试：节点、依赖连线、素材 / 历史、全局输入和创意执行工作流；本项目将其放在统一画布的创意执行侧重点。

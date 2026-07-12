# Feature 01 实施方案多轮 Review 记录

- 日期：2026-07-12
- 评审对象：
  - `docs/superpowers/specs/2026-07-12-unified-organic-workspace-design.md`
  - `docs/superpowers/plans/2026-07-12-feature-01-mvp-implementation.md`
- 结论：**通过，带执行前强制修正项**

## 1. Review 方法

本次不是一次性形成方案，而是分五轮从不同角色重新审查：

1. 产品一致性 Review
2. 架构与技术选型 Review
3. 数据完整性与并发 Review
4. UX、动态交互与失败路径 Review
5. 工程实施、测试、许可与运维 Review

每轮先提出反对意见，再决定保留、收敛或修改。

---

## 2. 第一轮：产品一致性 Review

### 审查问题

- 是否错误地把 TapNow 类能力拆成另一个下级工作台？
- 是否仍然以“消息级分支”为实现单位？
- 焦点模式是否复制数据？
- 删除是否又退回普通硬删除？

### 发现

原有竞品参考容易把节点创意画布放大成产品主体。实施方案必须确保：

- 只有一个 Workspace 和一张统一画布。
- `growth / creative / assets / tasks / review / history` 是同一图谱的投影。
- 分支来源是 `SemanticAnchor`，不是整条消息 ID。
- 创意执行未来新增对象类型，但不建立第二套项目、资产和历史。

### 修正结果

已在设计规格和实施计划中固定：

```text
Unified Workspace
→ One Graph
→ Multiple Focus Projections
→ No Object Duplication
```

删除动作固定通过 `MetabolismRecord` 表达；MVP 不提供绕过代谢流程的前端硬删除入口。

### 结论

通过。

---

## 3. 第二轮：架构与技术选型 Review

### 对比方案

#### 方案 A：React Flow + Tiptap + 独立领域模型

优点：

- 节点和边模型与产品当前阶段高度匹配。
- React DOM 节点适合富文本与复杂 Inspector。
- MIT 许可适合私有商业产品。
- 领域模型可通过 Adapter 与渲染器分离。

缺点：

- 白板自由度和极致手感不如专门白板 SDK。
- 文本编辑、节点拖动、自动布局需要自行协调。

#### 方案 B：tldraw 作为唯一基础

优点：

- 画布、Shape、Binding、富文本和交互完成度高。

缺点：

- 生产用途存在商业许可决策。
- 如果直接使用 SDK Store 作为业务真源，后续会产生领域模型锁定。

#### 方案 C：Fabric / Konva 自研

优点：控制力最大。

缺点：第一阶段需要重复建设富文本、节点、边、历史、可访问性和布局，无法聚焦产品差异。

### 决策

采用方案 A，并强制建立 `CanvasAdapter`。tldraw 只作为交互标杆或未来第二个适配器，不进入核心领域和数据库结构。

### 结论

通过。

---

## 4. 第三轮：数据完整性与并发 Review

### 攻击场景 1：文本变化造成锚点漂移

仅存 `{start, end}` 会在插入或删除文本后指向错误内容。

**修正：**

```text
Immutable Revision
+ Text Position
+ Exact Quote
+ Prefix / Suffix
+ Content Hash
```

无法唯一定位时必须进入 `orphaned`，不得静默重连。

### 攻击场景 2：AI 回流覆盖用户新内容

AI 基于 `rev_1` 生成 Proposal，用户已编辑为 `rev_2`，旧 Proposal 仍被确认会破坏数据。

**修正：** `IntegrationProposal` 强制携带 `targetRevisionId`；事务中再次校验。目标已变化则 Proposal 变为 `expired`，重新生成 Diff。

### 攻击场景 3：整包 Workspace JSON 覆盖

巨大 JSONB 行会造成：

- 并发冲突粒度过粗；
- 历史与审计困难；
- 节点级查询和恢复困难；
- 大画布保存成本线性上升。

**修正：** 当前状态使用规范化关系表，领域事件只追加，Snapshot 加速载入。JSONB 只保存类型 props、selector 和 payload。

### 攻击场景 4：重复提交 Command

网络重试可能把同一操作执行两次。

**修正：** Command ID 幂等；Workspace Event Sequence 单调递增；事务使用 `expectedSequence` 乐观锁。

### 攻击场景 5：撤销代谢误删后续内容

如果腐殖化后用户又创建新卡片，旧逆向命令不能删除后续对象。

**修正：** Inverse Command 只引用原 Command 产生的确定对象和事件，不按分支范围批量清理。

### 结论

通过。

---

## 5. 第四轮：UX、动态交互与失败路径 Review

### 核心检查

- 动态内容是否只是视觉动画？
- AI 是否仍像黑箱？
- 用户能否理解分支从哪里生长？
- 禁用状态是否明确说明原因？

### 修正结果

动态层被定义为状态和关系变化，不是装饰：

```text
选中 → 锚定 → 分枝 → 探索 → Proposal
→ 结论化 → Diff → 回流 → 代谢 → 重构
```

AI 状态固定为：

```text
queued → running → awaiting-confirmation → applied
                    ↘ rejected
queued/running → cancelled
queued/running → failed
```

必须实现的失败反馈：

- AI 失败：显示失败原因和重新运行入口。
- AI 取消：保留已流式显示内容，但不生成 Proposal。
- Proposal 过期：显示目标已变化，要求重新生成。
- Anchor orphaned：显示原始修订、候选位置和手动重锚入口。
- Action disabled：显示缺失条件，不只把按钮变灰。
- Delete / Backspace：打开代谢确认，不立即硬删除。

### 动效约束

- 分枝动效只强调来源锚点、新分支和 derives 边。
- 回流动效只强调来源、目标和受影响修订。
- 腐殖化后分支淡出，养分卡与 Timeline 保留。
- `prefers-reduced-motion` 下关闭位移动画，保留状态高亮。

### 结论

通过。

---

## 6. 第五轮：工程实施、测试、许可与运维 Review

### 6.1 发现：浏览器包错误使用 `node:crypto`

详细计划 Task 2 的示例在 `@ai-super-canvas/core` 中使用 `node:crypto`。该包也会被浏览器加载，会造成客户端打包或运行问题。

### 强制修正 F-01

执行 Task 1 时安装跨运行时哈希库：

```bash
pnpm --filter @ai-super-canvas/core add @noble/hashes
```

执行 Task 2 时使用：

```ts
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function contentHash(content: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(content)));
}
```

禁止在 `packages/core` 或任何客户端可达模块中导入 `node:*`。

### 6.2 发现：迁移工具未安装

计划后续调用 `drizzle-kit`，但脚手架依赖未明确安装。

### 强制修正 F-02

执行 Task 1 时追加：

```bash
pnpm --filter @ai-super-canvas/db add -D drizzle-kit
```

`packages/db/package.json` 必须提供：

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "test": "vitest run"
  }
}
```

### 6.3 发现：初始测试命令可能因无测试退出非零

计划要求 Task 1 全部命令退出 0，但初始仓库尚无测试。

### 强制修正 F-03

根脚本在 Task 1 使用：

```json
"test": "vitest run --passWithNoTests"
```

Task 2 创建首个测试后可以继续保留该参数，也可以移除；CI 必须额外校验测试文件数不为 0，避免长期空跑。

### 6.4 发现：包配置描述不应只写“重复同样结构”

### 强制修正 F-04

Task 1 必须显式创建三个 package.json；最低依赖关系：

```text
@ai-super-canvas/core → zod, @noble/hashes
@ai-super-canvas/db   → core, drizzle-orm, postgres, zod; dev: drizzle-kit
@ai-super-canvas/ai   → core, openai, zod
@ai-super-canvas/web  → core, db, ai, React Flow, Tiptap, Zustand, ELK
```

不允许开发者自行猜测包边界。

### 6.5 许可检查

- React Flow 采用 MIT，适合作为首个商业实现。
- tldraw 若进入生产实现，必须单独完成许可评审和预算批准。
- 不允许从 TapNow 或其他闭源产品复制源代码、资源或专有交互实现。
- 竞品只用于功能与交互原则学习。

### 6.6 运维检查

已保留：

- Docker Compose 私有部署；
- PostgreSQL migration；
- 健康检查；
- `pg_dump / pg_restore`；
- 恢复演练；
- Fake AI Provider 确保 E2E 稳定；
- 真实模型只做显式 smoke test。

### 结论

在 F-01 至 F-04 被执行任务采用后通过。

---

## 7. 最终执行优先级

实施顺序不得调整为“先做漂亮画布，再补数据”。推荐顺序：

```text
1. Domain Invariants
2. Database + Command/Event Transaction
3. Canvas Adapter
4. Rich Text + Semantic Anchor
5. Branch Context
6. AI Proposal
7. Card + Integration Diff
8. Metabolism + Timeline
9. Recovery + Accessibility + Performance
10. Private Alpha Deployment
```

原因：产品差异依赖锚点、回流和代谢的正确性，而不是先完成通用画布功能。

---

## 8. Review Gate 机制

每个实施任务完成后必须经过两道 Review：

### Domain Review

- 是否破坏统一工作台原则？
- 是否复制对象或绕过 Revision？
- AI 是否越过 Proposal 边界？
- Command / Event / Inverse 是否完整？
- 状态转换是否符合状态机？

### Engineering Review

- 单元、集成和 E2E 测试是否真实验证？
- 错误反馈是否明确？
- 是否有浏览器 / 服务端边界泄漏？
- 是否存在许可、性能、可访问性或隐私问题？
- 是否可以独立回滚该提交？

严重级别：

| 等级 | 处理 |
|---|---|
| Critical | 禁止合并，立即修复 |
| High | 禁止合并，当前任务内修复 |
| Medium | 当前 Gate 前修复 |
| Low | 记录后进入下一轮 |

---

## 9. 最终结论

实施方案在产品边界、架构、数据安全、动态 UX、失败路径、许可和运维方面已经形成闭环。

当前推荐：

> 以 React Flow + Tiptap 建立首个统一画布适配器，以不可变 Revision 和 W3C 风格 selector 保证语义锚点，以 Proposal → Command → Event 保证 AI 变更可确认和可撤销，以 PostgreSQL 规范化数据 + append-only events + snapshots 保证追溯和恢复。

执行时必须先应用 F-01 至 F-04，再从实施计划 Task 1 开始。
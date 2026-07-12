# Feature 01 可落地实施方案总览

## 1. 最终方案

Feature 01 采用以下技术路线：

```text
Next.js 16 + TypeScript
React Flow CanvasAdapter
Tiptap / ProseMirror Rich Text
Zustand Client State
ELK.js Worker Layout
PostgreSQL 18 + Drizzle
OpenAI Responses API Provider Adapter
IndexedDB Recovery
Vitest + PostgreSQL Integration Tests + Playwright
```

核心不是先做通用无限画布，而是先完成差异化纵向闭环：

```text
主问题
→ 主干文本
→ 任意词 / 句 / 段落语义锚点
→ 独立分支
→ AI 可见执行
→ 待确认结论卡
→ 回流 Diff
→ 主线新修订
→ 休眠 / 腐殖化
→ Growth Timeline
```

## 2. 核心架构原则

1. 一张统一画布，多种焦点投影。
2. 领域模型与 React Flow、Tiptap、OpenAI 解耦。
3. 所有文本内容使用不可变 Revision。
4. Anchor 使用规范化文本的 Position + Quote + Context 定位。
5. AI 只生成 Proposal，用户确认后 Command 才持久化。
6. Command、当前状态和 Domain Event 在同一数据库事务中提交。
7. Workspace Event Sequence 用于幂等、并发检查和同步。
8. 当前状态采用规范化关系表；JSONB 只保存扩展属性和 payload。
9. 操作历史、生长时间线、AI 历史和版本历史分开处理。
10. 删除优先通过代谢语义，而不是无痕硬删除。

## 3. 文档入口

按以下顺序阅读：

1. 设计规格：`docs/superpowers/specs/2026-07-12-unified-organic-workspace-design.md`
2. 多轮 Review：`docs/reviews/2026-07-12-feature-01-implementation-review.md`
3. 详细实施计划：`docs/superpowers/plans/2026-07-12-feature-01-mvp-implementation.md`
4. 最终执行入口：`docs/superpowers/plans/2026-07-12-feature-01-execution-entry.md`

其中第 4 项是执行优先级最高的约束文件。

## 4. 实施阶段

### Gate A：领域与事务基础

- Monorepo 脚手架
- Domain Model
- Revision / Anchor / Branch State Machine
- PostgreSQL Schema
- Command / Event / Snapshot
- Workspace API

### Gate B：统一画布与语义锚点

- CanvasAdapter
- React Flow 投影
- Tiptap 主干文本节点
- 规范化富文本位置映射
- 文本 Anchor
- 分支创建和来源追溯

### Gate C：AI、结论与回流

- AI Provider Adapter
- SSE 运行状态
- Structured Proposal
- Conclusion Card
- Integration Diff
- 乐观锁回流
- Branch Metabolism
- Growth Timeline

### Gate D：Alpha 质量与部署

- Undo / Redo
- IndexedDB 恢复
- 性能预算
- 键盘与可访问性
- 私有 Alpha 身份边界
- Docker 部署
- Backup / Restore
- Golden Path E2E

## 5. 明确不做

Feature 01 不包含：

- 图片生成或图片局部编辑
- 多媒体资产库
- 多人协作和 CRDT
- 自动 Agent 调度
- 全局知识图谱
- 完整创意 Workflow
- 多模型费用管理

这些能力后续在同一 Workspace 中扩展，不创建第二套工作台。

## 6. 最终验收

必须完整通过：

```text
创建 Workspace
→ 输入主问题
→ 选中“腐殖化”
→ 创建 Anchor
→ 长出 Branch
→ 分支 AI 流式探索
→ 生成并确认 Conclusion Card
→ 预览并应用主线回流
→ 腐殖化分支并保留养分
→ 查看 Growth Timeline
→ Undo / Redo
→ Reload 后状态一致
```

同时验证：

- Anchor 不静默漂移。
- 旧 Proposal 不覆盖新 Revision。
- AI 取消 / 失败不污染图谱。
- 所有结构动作可追溯。
- 私有 Alpha 不裸露公网。
- 200 个对象的性能测试达标。

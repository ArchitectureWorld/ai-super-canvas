# 初始数据模型草案

> 文档状态：**Superseded / 历史草案**。旧 `Conversation + Node + Branch + Card` 模型存在重复身份，禁止用于新实现。权威模型见 [`agent-session-domain-model.md`](./architecture/agent-session-domain-model.md) 和 [`postgres-schema.md`](./architecture/postgres-schema.md)。

## 1. 建模目标

本数据模型用于描述 **图谱式 / 有机式会话画布** 的第一版核心对象。

当前阶段不追求完整图数据库设计，而是先定义产品概念与工程实现之间的桥梁，方便后续原型开发。

## 2. 核心对象

第一版核心对象包括：

```text
Workspace
Conversation
Node
Edge
SemanticAnchor
Branch
Card
MetabolismRecord
```

## 3. Workspace

工作空间。对应一个项目或一个长期主题。

示例：

```json
{
  "id": "workspace_ai_super_canvas",
  "name": "AI 超级画板",
  "description": "面向 AI 原生工作流的图谱式 / 有机式智能画布",
  "createdAt": "2026-07-10T00:00:00Z",
  "updatedAt": "2026-07-10T00:00:00Z"
}
```

## 4. Conversation

会话。对应一个主线或一个分支中的连续讨论。

```json
{
  "id": "conv_main_001",
  "workspaceId": "workspace_ai_super_canvas",
  "type": "mainline",
  "title": "AI 超级画板第一功能讨论",
  "status": "active",
  "parentBranchId": null
}
```

会话类型建议：

| 类型 | 说明 |
|---|---|
| mainline | 主线会话 |
| branch | 分支会话 |
| review | 审核会话 |
| archive | 归档会话 |

## 5. Node

节点。图谱式画布中的基本单元。

```json
{
  "id": "node_001",
  "workspaceId": "workspace_ai_super_canvas",
  "type": "message",
  "title": "图谱式 / 有机式会话",
  "content": "AI 对话不应被压缩成单一时间线。",
  "sourceConversationId": "conv_main_001",
  "status": "active"
}
```

节点类型建议：

| 类型 | 说明 |
|---|---|
| message | 消息节点 |
| concept | 概念节点 |
| anchor | 语义锚点节点 |
| branch | 分支节点 |
| conclusion | 结论节点 |
| rule | 规则节点 |
| task | 任务节点 |
| asset | 素材节点 |
| file | 文件节点 |
| region | 局部区域节点 |
| failure | 失败经验节点 |

## 6. SemanticAnchor

语义锚点。用户选中的、可以生成分支的最小语义对象。

```json
{
  "id": "anchor_001",
  "workspaceId": "workspace_ai_super_canvas",
  "sourceNodeId": "node_001",
  "type": "text-span",
  "label": "腐殖化",
  "range": {
    "start": 32,
    "end": 35
  },
  "meaning": "无效分支代谢后转化为可复用养分的过程"
}
```

锚点类型建议：

| 类型 | 说明 |
|---|---|
| text-token | 单个词汇 |
| text-span | 短语或句子 |
| paragraph | 段落 |
| image | 图片整体 |
| image-region | 图片局部区域 |
| file-fragment | 文件片段 |
| canvas-node | 画布节点 |
| edge | 节点关系 |

## 7. Branch

分支。由一个语义锚点触发的新探索空间。

```json
{
  "id": "branch_001",
  "workspaceId": "workspace_ai_super_canvas",
  "sourceAnchorId": "anchor_001",
  "title": "腐殖化机制分支",
  "status": "exploring",
  "conversationId": "conv_branch_001",
  "createdFrom": "anchor_001"
}
```

分支状态建议：

| 状态 | 说明 |
|---|---|
| exploring | 探索中 |
| pending-review | 待确认 |
| integrated | 已回流 |
| dormant | 休眠中 |
| pruned | 已剪枝 |
| decayed | 已落叶 |
| humified | 已腐殖化 |
| archived | 已归档 |

## 8. Edge

边。描述节点之间的关系。

```json
{
  "id": "edge_001",
  "workspaceId": "workspace_ai_super_canvas",
  "fromNodeId": "node_001",
  "toNodeId": "node_002",
  "type": "supports",
  "weight": 0.8,
  "description": "分支结论支持主线定义"
}
```

边类型建议：

| 类型 | 说明 |
|---|---|
| derives | 派生 |
| supports | 支持 |
| contradicts | 反驳 |
| refines | 细化 |
| replaces | 替代 |
| depends-on | 依赖 |
| references | 引用 |
| feeds-back-to | 回流 |
| metabolizes-into | 代谢转化 |
| archives-to | 归档到 |

## 9. Card

卡片。分支探索后的结构化成果。

```json
{
  "id": "card_001",
  "workspaceId": "workspace_ai_super_canvas",
  "type": "conclusion",
  "title": "删除分支应被设计为知识代谢",
  "content": "删除不是消失，而是剪枝、落叶、休眠或腐殖化。",
  "sourceBranchId": "branch_001",
  "targetNodeIds": ["node_main_001"],
  "status": "ready-to-integrate"
}
```

卡片类型建议：

| 类型 | 说明 |
|---|---|
| conclusion | 结论卡 |
| rule | 规则卡 |
| task | 任务卡 |
| asset | 素材卡 |
| failure | 失败经验卡 |
| question | 问题卡 |
| decision | 决策卡 |

## 10. MetabolismRecord

代谢记录。记录分支被剪枝、落叶或腐殖化时保留下来的信息。

```json
{
  "id": "metabolism_001",
  "workspaceId": "workspace_ai_super_canvas",
  "sourceBranchId": "branch_001",
  "action": "humify",
  "retainedNutrients": [
    "删除分支不应等于信息消失",
    "失败分支可以提炼为约束或经验"
  ],
  "discardedContentPolicy": "remove-full-thread-keep-summary",
  "createdAt": "2026-07-10T00:00:00Z"
}
```

代谢动作建议：

| 动作 | 说明 |
|---|---|
| prune | 剪枝 |
| decay | 落叶 |
| dormancy | 休眠 |
| humify | 腐殖化 |
| archive | 归档 |

## 11. 第一版实现建议

第一版可以先使用轻量数据结构：

- 前端状态：JSON graph。
- 本地持久化：IndexedDB / SQLite。
- 后端持久化：PostgreSQL + JSONB。
- 图谱查询：早期不需要专门图数据库。
- 节点关系：先用 Edge 表表达。

后续当关系网络复杂后，再考虑 Neo4j、Kuzu、ArangoDB 或其它图数据库。

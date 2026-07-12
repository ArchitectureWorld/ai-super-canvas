# Feature 01 执行入口与强制修正

> 本文件是 Feature 01 的**唯一执行入口**。当设计规格、详细实施计划和 Review 记录存在冲突时，以本文件的约束为准。

## 1. 执行文档顺序

实施人员必须按顺序阅读：

1. `docs/superpowers/specs/2026-07-12-unified-organic-workspace-design.md`
2. `docs/reviews/2026-07-12-feature-01-implementation-review.md`
3. `docs/superpowers/plans/2026-07-12-feature-01-mvp-implementation.md`
4. 本文件中的 F-01 至 F-06 强制修正

不得只读取详细任务列表后直接编码。

## 2. 最终架构决策

```text
One Unified Workspace
├─ Renderer-independent Domain Model
├─ React Flow CanvasAdapter
├─ Tiptap Rich Text
├─ Immutable Revisions + Stable Selectors
├─ Proposal → Command → Event
├─ PostgreSQL Current State + Append-only Events
├─ Snapshots + IndexedDB Recovery
└─ Focus Projections, not separate workspaces
```

第一阶段只完成：

```text
主干文本
→ 语义锚点
→ 独立分支
→ AI Proposal
→ 结论卡
→ 回流 Diff
→ 主线新修订
→ 分支代谢
→ Growth Timeline
```

## 3. 强制修正

### F-01：跨运行时内容哈希

禁止在 `packages/core` 或浏览器可达模块导入 `node:crypto`。

Task 1 安装：

```bash
pnpm --filter @ai-super-canvas/core add @noble/hashes
```

Task 2 使用：

```ts
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function contentHash(content: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(content)));
}
```

测试必须在 `node` 和 `jsdom` 两个 Vitest environment 下得到相同 hash。

### F-02：Drizzle migration 工具

Task 1 安装：

```bash
pnpm --filter @ai-super-canvas/db add -D drizzle-kit
```

`packages/db/package.json` 必须包含：

```json
{
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

CI 启动集成测试前必须对空数据库运行 migration。

### F-03：无测试脚手架不得导致失败

Task 1 根脚本使用：

```json
"test": "vitest run --passWithNoTests"
```

Task 2 起，CI 追加测试文件计数检查：

```bash
test "$(find packages apps -path '*__tests__*' -name '*.test.*' | wc -l)" -gt 0
```

这样既允许脚手架验证，也避免后续测试长期空跑。

### F-04：包边界必须显式

禁止使用“其它包照此重复”的模糊配置。依赖方向固定为：

```text
@ai-super-canvas/core
  └─ zod, @noble/hashes

@ai-super-canvas/db
  ├─ @ai-super-canvas/core
  ├─ drizzle-orm, postgres, zod
  └─ dev: drizzle-kit

@ai-super-canvas/ai
  ├─ @ai-super-canvas/core
  └─ openai, zod

@ai-super-canvas/web
  ├─ @ai-super-canvas/core
  ├─ @ai-super-canvas/db
  ├─ @ai-super-canvas/ai
  └─ React Flow, Tiptap, Zustand, ELK, IndexedDB adapter
```

禁止 `core → db/web/ai`、`db → web`、`ai → web` 的反向依赖。

### F-05：富文本位置必须先规范化

Tiptap / ProseMirror 的文档位置不是普通字符串字符偏移，不能直接写入 W3C 风格 Text Position Selector。

必须新增：

```text
apps/web/src/features/text/canonicalText.ts
apps/web/src/features/text/positionMap.ts
```

接口：

```ts
export interface CanonicalTextResult {
  text: string;
  pmToText: Map<number, number>;
  textToPm: Map<number, number>;
}

export function canonicalizeRichText(doc: JSONContent): CanonicalTextResult;
```

规范化规则：

1. 文本节点原样输出 Unicode 字符。
2. 段落、标题和列表项之间统一插入 `\n`。
3. 连续三个及以上换行压缩为两个。
4. 不做大小写折叠，不改变全角 / 半角，不进行 Unicode 兼容归一化。
5. Anchor 的 `start/end/exact/prefix/suffix/contentHash` 全部基于规范化文本。
6. 原始修订额外保存 `pmFrom/pmTo` 仅用于快速定位，不作为跨修订的唯一依据。
7. 单元测试覆盖中文、Emoji、组合字符、列表、标题和跨段选择。

### F-06：私有 Alpha 认证边界

`DEV_USER_ID` 只允许本地开发和自动化测试。

私有 Alpha 上线前必须二选一：

#### 路线 A：可信访问代理后的单用户部署（推荐第一阶段）

- 应用只监听私有网络或 loopback。
- 外层由 Tailscale、Cloudflare Access、反向代理 SSO 或同等级可信身份层保护。
- 代理注入经过签名 / 白名单验证的用户标识。
- 应用配置固定 `APP_OWNER_ID`，拒绝缺少可信身份头的请求。

#### 路线 B：应用内正式认证

- 使用独立认证适配器实现 session、CSRF 和安全 cookie。
- 不允许自写明文密码或简单 Basic Auth。

Task 12 的 Release Gate 必须验证：

```text
[ ] DEV_USER_ID 未出现在生产环境
[ ] 应用端口未直接暴露公网
[ ] 可信身份缺失时返回 401
[ ] 访问其它 owner Workspace 返回 404 或 403
[ ] Session / trusted-header 日志不记录凭据
```

## 4. 实施 Gate

### Gate A：领域与事务

完成详细计划 Tasks 1–4，并应用 F-01 至 F-04。

必须通过：

```text
Domain state machine tests
Anchor selector validation tests
PostgreSQL foreign-key tests
Workspace sequence conflict tests
Command idempotency tests
```

### Gate B：画布与锚点

完成 Tasks 5–7，并应用 F-05。

必须通过：

```text
Rich text edit/drag conflict tests
Chinese/Emoji canonical text tests
Position + Quote re-anchor tests
Orphaned anchor tests
Branch source trace E2E
Focus projection object-identity tests
```

### Gate C：AI、卡片与回流

完成 Tasks 8–10。

必须通过：

```text
AI cancel/failure/malformed proposal tests
No mutation before proposal acceptance
Stale target revision rejection
Integration Diff E2E
Humification nutrient trace tests
Timeline sequence tests
```

### Gate D：恢复与发布

完成 Tasks 11–12，并应用 F-06。

必须通过：

```text
Undo/redo tests
IndexedDB recovery tests
200-object performance fixture
Keyboard and reduced-motion E2E
Authorization tests
Backup/restore drill
Full Golden Path E2E
```

## 5. 每个任务的双 Review

每个 Task 完成后执行：

### Domain Review

```text
[ ] 统一工作台原则未被破坏
[ ] 领域对象未依赖 React Flow / Tiptap / OpenAI 类型
[ ] Revision 与 Anchor 关系正确
[ ] AI 未绕过 Proposal
[ ] Command / Event / Inverse 完整
[ ] 状态机转换合法
```

### Engineering Review

```text
[ ] 先有失败测试，再有实现
[ ] 集成测试连接真实 PostgreSQL
[ ] 浏览器 / 服务端依赖边界正确
[ ] 禁用和失败状态有明确原因
[ ] 无 Critical / High 安全问题
[ ] 可访问性和 reduced-motion 已验证
[ ] 提交可以独立回滚
```

## 6. 不得提前实现的能力

以下内容不得进入 Feature 01 MVP：

- 图片生成节点与图片局部编辑
- 多媒体资产库
- 多人实时协作与 CRDT
- Agent 自动调度
- 全局知识图谱
- 复杂 Workflow 模板
- 多模型路由和费用系统
- 植物拟真动画

它们只能使用已经定义的 Object / Anchor / Proposal / Command / Event / FocusProjection 接口进行后续扩展。

## 7. 最终开工条件

开始 Task 1 前必须确认：

```text
[ ] 设计规格已阅读
[ ] Review 记录已阅读
[ ] F-01 至 F-06 已加入任务上下文
[ ] 开发分支从 main 最新提交创建
[ ] PostgreSQL 与 Docker 可运行
[ ] 真实 AI Key 不进入测试环境
[ ] Task 1 只搭骨架，不提前做 UI 功能
```

满足后，从 `feat/feature-01-mvp` 分支开始执行。
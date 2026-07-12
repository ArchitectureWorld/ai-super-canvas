# Feature 01 研究来源映射

本文件说明外部研究如何转化为实施决策，不代表复制第三方产品实现。

| 研究对象 | 学习内容 | 转化到本项目的决策 |
|---|---|---|
| React Flow | Custom Nodes、Edges、State、Save/Restore、Undo/Redo、Subflows | 首个 `CanvasAdapter`；领域模型不依赖 React Flow 类型 |
| tldraw | Editor、Shapes、Bindings、Rich Text、Persistence、AI Canvas 模式 | 交互标杆和未来适配器候选；生产使用前单独许可评审 |
| ELK.js | Directed graph layout、Web Worker | 辅助布局放 Worker，不阻塞主线程 |
| Tiptap / ProseMirror | 结构化富文本编辑 | 作为主干 / 分支文本编辑器；建立规范化文本位置映射 |
| W3C Web Annotation | Text Position、Text Quote、Fragment、SVG Selectors | Semantic Anchor 使用 Revision + Position + Quote；预留图片 / 文件 selector |
| PostgreSQL | JSONB、Constraints、Recursive CTE | 身份 / 状态 / 关系规范化；JSONB 只存扩展 props 与 payload |
| OpenAI Responses API | SSE Streaming、Structured Outputs、Stateful Runs | Provider Adapter；AI 输出先 Proposal，再由 Command 应用 |
| TapNow 实操测试 | Node、Dependency Edge、Asset / History、Global Input、Creative Workflow | 作为统一画布内“创意执行侧重点”的交互参考，不拆第二工作台 |
| Apple 产品界面 | 克制、留白、层级、聚焦 | 作为统一工作台视觉秩序原则，不复制页面和素材 |

## 研究结论

1. 差异化不在“再做一个节点画布”，而在稳定语义锚点、分支演化、回流和代谢。
2. 画布 SDK 应是可替换表现层，不能成为业务数据真源。
3. Rich Text、Canvas 和 AI 三者必须通过明确接口连接，不能在一个大组件里互相直接操作。
4. AI 可见、可取消、可确认、可撤销比自动化程度更优先。
5. 第一阶段必须用一条 Golden Path 证明产品机制，再扩展创意、资产和 Agent 功能。

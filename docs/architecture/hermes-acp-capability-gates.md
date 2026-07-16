# Hermes ACP Runtime 能力闸门

状态：Required before production coupling
审计日期：2026-07-15
目标：验证 Hermes 能否作为 AI Super Canvas 第一代 Agent Runtime，而不是假设“已有 Agent 就能直接接入”。

## 1. 当前审计结论

Hermes 的能力足以进入主线验证，但尚不能直接成为正式产品后台。

已确认能力：

- profile 级 `HERMES_HOME`、配置、SOUL、memory、session、skills 和 secret 隔离；
- ACP Session 创建、列表、加载、持久化恢复和整段历史 fork；
- ACP prompt 流式消息、思考/步骤、工具进度和权限回调；
- 当前 Session 活跃 turn 的取消入口；
- Session 模型切换并持久化；
- Gateway API Server 已有 sessions、runs、SSE events、stop、approval 和 capability surface。

关键缺口：

- ACP fork 只 deep-copy 整段 history，不能按任意 Canvas message/revision 分叉；
- ACP load 的部分回放错误可能被吞掉，缺少可靠 replay completeness 信号；
- Agent 异常可能转成文本错误并以普通 end-turn 结束，缺少稳定 typed failure；
- cancel 不带原生 run-id，也没有可持久化的确认结果；
- in-flight Run、queue、cancel 和 approval 不支持崩溃后精确恢复；
- API Server 的 fork 会结束父 Session，并复制全量历史；
- API Server 的 Session model 字段与实际 Agent 创建路径尚未形成可靠闭环；
- 缺少产品级 Account → profile 路由、租户权限、配额和幂等；
- Hermes toolsets 不是完整的 Session 级 deny-first ACL；
- MCP registry/连接和部分策略是进程级，模型切换缺少统一 idle guard；
- 当前本机 profile 未将 API Server 作为 Canvas 专用、认证和隔离的产品入口；
- 源码依赖需要固定内部版本和补丁清单，不能跟随浮动工作树直接部署。

因此 v1 优先验证 **AgentBinding + Workspace scope 隔离的 Hermes ACP Worker**，不直接把现有 multiplex Gateway 或 API Server 当 Canvas 控制面。当前能力只能进入 Spike，未通过闸门前不得标记为生产支持。

当前对外能力声明基线：

| 能力 | 当前声明 |
|---|---|
| create/load/list、完成回合持久化 | native/adapter，仍需 replay 完整性测试 |
| 同 Worker 多 Session | adapter，需并发和进程级状态隔离测试 |
| HEAD fork | adapter |
| 精确 message/revision forkAt | unsupported，直到安全 prefix import 通过 |
| typed run failure | unsupported |
| run-id 级取消确认 | unsupported/adapter spike |
| 审批 | adapter，必须禁 permanent allow 并验证 fail-closed |
| Session model switch | adapter，必须补 idle guard/allowlist |
| Session Tool/MCP policy | unsupported，需进程/Workspace 隔离 |
| in-flight 崩溃恢复 | unsupported |
| client request 幂等 | adapter，由 Canvas ledger 补齐 |

只读审计运行过 Hermes ACP 的 session/server/permissions/MCP 聚焦测试，结果为 `150 passed`；这只证明现有测试集合通过，不等于上述 Canvas P0 闸门已通过，也不等于 Hermes 全量测试通过。

## 2. 源码证据

- ACP Session 持久化并支持重启恢复：外部 Hermes 固定版本 `acp_adapter/session.py`，约第 186 行
- 创建 Session：外部 Hermes 固定版本 `acp_adapter/session.py`，约第 210 行
- 原生 fork 为全量 history deep copy：外部 Hermes 固定版本 `acp_adapter/session.py`，约第 253 行
- ACP 流式 prompt、工具回调和审批：外部 Hermes 固定版本 `acp_adapter/server.py`，约第 1296 行
- ACP Session 模型切换：外部 Hermes 固定版本 `acp_adapter/server.py`，约第 1995 行
- API Session 创建：外部 Hermes 固定版本 `gateway/platforms/api_server.py`，约第 1494 行
- API fork 会结束父 Session：外部 Hermes 固定版本 `gateway/platforms/api_server.py`，约第 1601 行
- personal profiles 的隔离目录：外部运维文档 `<deployment-data-root>/agent-architecture.md`

## 3. 测试拓扑

测试必须使用隔离的临时 Hermes Home，不得写入家庭 Jarvis 或 personal-assistants 正式 profile。

```text
Canvas Contract Test Runner
├── Binding A -> Worker A -> HERMES_HOME=/tmp/.../agent-a
│                         ├── Session A1
│                         └── Session A2
└── Binding B -> Worker B -> HERMES_HOME=/tmp/.../agent-b
                          └── Session B1
```

测试 secret 使用无生产权限的专用值或完全 Fake provider。所有测试目录和进程在结束后由 fixture 清理。

## 4. 闸门清单

### H0：可复现构建

通过条件：

- [ ] 记录 Hermes commit SHA、内部 patch 清单、Python 和依赖锁版本；
- [ ] 通过该固定版本构建 Worker artifact/image；
- [ ] CI 可以从干净 checkout 重建相同 artifact；
- [ ] Adapter 在启动时报告 runtime 和 adapter version；
- [ ] 升级 Hermes 时自动重跑全部 Runtime 契约测试。

失败处理：不得进入 H1，不得依赖开发者本机浮动源码。

### H1：AgentBinding 隔离

场景：Binding A/B 使用不同 SOUL、memory、toolset 和 marker secret，各创建一个 Session 并并发运行。

通过条件：

- [ ] A 输出只能观察 A 的身份和允许上下文；B 同理；
- [ ] A 无法通过 Session ID 加载 B 的 Session；
- [ ] 任何事件、日志和 transcript 都不出现另一 Binding 的 marker secret；
- [ ] Worker 进程环境不在请求之间切换 HERMES_HOME；
- [ ] 一个 Worker 崩溃不终止其它 Binding Worker。

硬失败：出现跨 profile 记忆、secret、Session 或工具串用，立即停止 Hermes 主线并启动 Letta 备用验证。

### H2：Session 生命周期与恢复

通过条件：

- [ ] `createSession` 返回唯一 external ref；
- [ ] `loadSession` 能在 Worker 仍运行时恢复；
- [ ] Worker 完整重启后仍可加载并继续对话；
- [ ] 不存在的 external ref 返回规范 `session_not_found`；
- [ ] 重复 commandId 不创建第二个 Runtime Session；
- [ ] Canvas Session 与 external ref 的对账可检测 orphan/drift。

### H3：同一 Agent 多 Session 并发

场景：同一个 Binding 同时运行 A1、A2，各自用不同事实和连续追问。

通过条件：

- [ ] 两个 Session 可并发或明确排队，但 transcript 不串；
- [ ] A1 的工具结果不会进入 A2；
- [ ] 取消 A1 不取消 A2；
- [ ] 并发执行不因进程级 `HERMES_SESSION_ID`、MCP registry 或 callback 状态产生串用；
- [ ] A1/A2 可使用不同模型配置并被实际 Run 快照证明；
- [ ] 50 轮交错执行后 Session history 与 Canvas transcript 对账一致。

硬失败：Runtime 只能可靠维护一个 Session，无法支持本产品主模型。

### H4：锚点 fork

场景：父 Session 有 M1…M6，从 M3 的文本锚点创建子 Session。

通过条件：

- [ ] 子 Session 可见 M1…M3，不可见 M4…M6；
- [ ] 父 Session 保持 active，并可继续产生 M7；
- [ ] 子 Session 继承同一 AgentIdentity，但拥有独立即时上下文；
- [ ] fork command 重试不创建多个子 Session；
- [ ] source revision 或 quote 漂移时在调用 Runtime 前失败；
- [ ] transcript prefix 注入不会把 Canvas system metadata 伪装成用户消息。

允许实现：Adapter 新建 Session 并精确导入 prefix，但必须验证 history digest、lineage 和后续隔离。无法安全导入时明确返回 unsupported。禁止调用会结束父 Session 的 API fork，也禁止把非 HEAD fork 偷换为 HEAD fork。

### H5：流式事件完整性

通过条件：

- [ ] 每个 Run 至少产生 accepted、started 和唯一终态；
- [ ] text delta 顺序可重放并等于 completed Message；
- [ ] tool requested/started/completed 引用同一个 toolCallRef；
- [ ] 断线后可以事件重放，或通过 transcript 对账补全且明确标记 warning；
- [ ] 重复/迟到 Runtime 事件不会生成重复 Message；
- [ ] 规范化事件不包含 provider secret、Authorization、cookie。

### H6：工具权限与人工审批

通过条件：

- [ ] Canvas deny 的工具即使 Hermes 配置允许也无法执行；
- [ ] require-approval 工具在执行前进入 `waiting_approval`；
- [ ] allow-once 只影响当前 tool call；
- [ ] allow-session 只影响当前 Canvas Session，不写入 Agent 全局配置；
- [ ] deny 后 Run 得到明确结果，不伪装为成功工具输出；
- [ ] 审批人必须是当前 Workspace 授权成员；
- [ ] 审批超时和重复响应幂等。

硬失败：高风险工具存在绕过审批路径。

### H7：取消、超时和崩溃恢复

通过条件：

- [ ] 用户取消后在验收时限内得到 `run.cancelled`；
- [ ] Adapter 只接受当前 Canvas runId；Hermes 无法确认取消时进入 reconciling，不伪造 acknowledged；
- [ ] Runtime 的迟到 completed 不能复活 cancelled Run；
- [ ] Worker 崩溃后 Canvas 将 active Run 标记为唯一规范状态 `reconciling`，原始 unknown 原因写入事件 payload；
- [ ] 重启后可判定 Run 已完成、失败或需要重试；
- [ ] 重试使用同一 idempotencyKey，不重复执行有副作用工具；
- [ ] shutdown 会发送明确中断事件并释放子进程。

### H8：模型目录与 Session 配置

通过条件：

- [ ] Adapter 从 Runtime 实时发现或验证模型，不依赖静态 UI 列表；
- [ ] Session 模型切换后，下一 Run 的实际 provider/model 与请求一致；
- [ ] 旧 Run 保留原模型快照；
- [ ] 不可用模型返回 `model_not_available`，可配置显式降级；
- [ ] `.env` 中只保存 secret、endpoint 和 bootstrap 默认值；
- [ ] 模型能力和可见性进入 Canvas ModelRegistry。

### H9：安全、审计和数据边界

通过条件：

- [ ] 每个 Canvas 命令带 account/workspace/session 授权上下文；
- [ ] external Session/Run ref 不作为授权证明；
- [ ] Runtime 文件路径、cwd 和 tool input 经过 allowlist/normalization；
- [ ] Message、RunEvent、错误和日志通过 secret 扫描；
- [ ] Canvas 删除/保留策略可以导出或销毁对应 Runtime Session；
- [ ] 私有 Agent memory 只以授权 ContextRef/摘要进入共享 Workflow。

### H10：容量与可运营性

通过条件：

- [ ] 测出单 Worker 可承载的 Session 数、并发 Run 数、内存和冷启动；
- [ ] Worker 有 ready/degraded/unavailable 健康状态；
- [ ] 控制面支持闲置 Worker scale-to-zero 和恢复；
- [ ] 有每 Binding 的 Run 数、失败率、取消延迟和 token/cost 指标；
- [ ] Runtime 升级可做 canary，并能回滚到固定版本；
- [ ] 一条 Binding 故障不会拖垮整个 Workflow API。

## 5. 通过标准

Hermes 进入正式主线必须满足：

- H0、H1、H2、H3、H5、H6、H7、H8、H9 全部通过；
- H4 可以由 Adapter 降级实现，但语义测试必须全部通过；
- H10 至少完成基线测量和健康/隔离，不要求第一版完成自动扩缩容；
- 所有测试以固定 Hermes artifact 在 CI 和本机各成功一次；
- 结果保存为机器可读 capability report，并绑定 runtime commit SHA。

## 6. 切换备用线的硬门槛

满足以下任一项，停止扩大 Hermes 耦合，使用同一契约启动 Letta Adapter：

1. 两轮修复后仍出现跨 AgentBinding 记忆或 secret 串用；
2. 无法稳定支持同一 Agent 多 Session；
3. 取消或审批存在不可封堵的工具副作用风险；
4. Session 重启恢复不可验证，且必须依赖易损内部文件修改；
5. Runtime 版本无法固定、重建和回滚；
6. forkAt 必须修改 Hermes 核心历史格式，Adapter 无法在边界内实现；
7. 同一契约下 Letta 显著更稳定，并且迁移成本低于继续硬化 Hermes。

切换 Runtime 不迁移 Canvas Workflow、SessionNode、RunEvent、Artifact 或 Proposal，只创建新的 AgentBinding/Runtime Session 映射。

## 7. 本机架构文档和端口规则

本闸门是设计与验证规范，不代表已经部署新的 Hermes API/ACP 网络服务，因此本轮不新增端口，也不修改部署数据根目录下的 `service-ports.*`。

当后续实施产生新的监听端口或正式 Worker 服务时，必须同步更新：

- `<deployment-data-root>/service-ports.md`
- `<deployment-data-root>/service-ports.json`
- `<deployment-data-root>/agent-architecture.md`

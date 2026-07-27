# 真实 Agent、可选记忆与产品体验设计

## 状态

- 日期：2026-07-27
- 状态：已确认，进入实施计划
- 基线：`main@48ac3071a5514af08e5f806792020c66aaa2b6a6`
- 产品入口：真实 AI Super Canvas 画板 `/`
- 非产品入口：`/control-plane-test`

## 1. 目标

本设计把 AI Super Canvas 从“画板原型 + Fake Runtime 测试面”推进为用户可以实际使用的真实 Agent 产品体验。

首版必须让用户在真实画板中完成以下闭环：

1. 进入画板并看到自己有权使用的 Agent。
2. 新建主 Agent 节点时默认选择 Jarvis。
3. 在节点面板中直接选择 Jarvis、于途或乔晶晶。
4. 为当前 Agent 选择记忆范围，并按需选择该 Agent 自己的历史 Session。
5. 从画板发送真实消息，看到流式运行状态和真实回复。
6. 刷新页面或重启 Canvas 后，画板、Agent 绑定、Session、消息和记忆策略仍然存在。
7. Agent 离线、请求结果不确定或权限不足时，得到普通用户能理解的恢复指引。

本设计的最高验收原则是：

> 后台、接口、数据库和自动测试全部通过，只能证明技术前置条件成立。只有用户在真实画板中完成完整旅程，才能宣称产品“现在能用”。

## 2. 已确认的产品决定

### 2.1 Agent 清单

首版提供三个可选择 Agent：

| 用户名称 | 类型 | 真实运行目标 |
| --- | --- | --- |
| Jarvis | 家庭总管级 Agent | 当前正在运行的家庭 Jarvis Gateway |
| 于途 | ZZH 个人助理级 Agent | Hermes personal-assistants 的 `zzh` profile |
| 乔晶晶 | NSY 个人助理级 Agent | Hermes personal-assistants 的 `nsy` profile |

用户界面只显示用户能理解的名称、类型和状态，不显示端口、Runtime kind、profile 路径或密钥引用。

### 2.2 默认值与权限

- 当前所有账号的默认 Agent 都是 Jarvis。
- ZZH 账号可选择 Jarvis、于途。
- NSY 账号可选择 Jarvis、乔晶晶。
- 管理员可查看和选择全部三个 Agent。
- 普通账号不能通过隐藏参数或直接调用 API 越权使用另一个账号的个人助理。
- Agent grant 只授权账号创建和使用自己的 Session，不授权读取其他账号
  使用同一 Jarvis/Workspace 创建的 Session。首版没有 Session 分享模型；
  Session 历史只对创建账号可见，管理员角色也不自动绕过。
- 后续管理后台统一维护 Agent、Binding、账号授权、默认 Agent、启停状态和默认记忆策略；本次不实现管理后台。

### 2.3 Agent 切换

- 尚未创建 Canvas Session 时，可以直接更换 Agent。
- Canvas Session 一旦完成 Runtime attach，即使还没有消息，更换 Agent 也必须创建新 Session。
- 原 Session 和历史消息保留，只读可追溯。
- 画板创建一个与原节点有明确来源关系的新 SessionNode，并把焦点移到新节点；不在原节点上偷换 Agent。
- 切换 Agent 时不得迁移原 Agent 的记忆、历史 Session 选择、工具状态或 Runtime Session ref。
- 不允许把旧 Agent 的外部 Session ref 发送给新 Agent。

## 3. 产品交互

### 3.1 真实画板入口

Agent 和记忆配置位于真实画板的节点控制面板中。现有节点面板的模型选择区域改造成以 Agent 为第一层的配置：

```text
使用助理：Jarvis
状态：可用

记忆范围：当前项目
高级设置：
  ☑ 项目记忆
  ☑ 上周的需求讨论
  ☐ 私人家庭规划

允许写入记忆：每次确认
```

模型选择只在当前 Agent 确实支持并能执行模型切换时显示。不能出现“界面选择成功，但 Runtime 仍使用原模型”的假功能。

### 3.2 账号可见选项

选择器由服务端返回授权结果：

- ZZH：Jarvis、于途。
- NSY：Jarvis、乔晶晶。
- 管理员：Jarvis、于途、乔晶晶。

前端过滤只用于体验，服务端必须在列举 Agent、创建 Session、切换 Agent、开始 Run 和读取上下文时重复授权。

### 3.3 运行状态

画板节点和节点面板显示统一状态：

- `可用`：允许创建 Session 和发送消息。
- `降级`：历史可读，部分运行能力不可用。
- `离线`：历史可读，不能发起新任务。
- `正在确认`：Canvas 无法判断请求是否已经被 Agent 接收，禁止重复发送。

状态描述不得暴露内部错误栈、密钥、外部 Session ref 或主机路径。

## 4. 记忆与 Session 策略

### 4.1 永久隔离原则

记忆隔离单位是 Agent：

- Jarvis 只能读取 Jarvis 被授权的上下文。
- 于途只能读取 `zzh` profile 和 Canvas 中属于于途的上下文。
- 乔晶晶只能读取 `nsy` profile 和 Canvas 中属于乔晶晶的上下文。
- 即使多个 Agent 出现在同一个 Workspace 或 Workflow 中，也不能共享项目记忆、历史 Session、Runtime Session ref 或长期记忆。

同一个 Agent 内允许用户调整读取范围，这不是跨 Agent 复制。

### 4.2 三种模式

#### 仅当前对话

- 只读取当前 Canvas Session。
- 保留 Agent 的身份、人格、系统规则和获批工具。
- 不读取 Agent 长期记忆、其他项目记忆或其他历史 Session。
- 不自动写入长期记忆。

#### 当前项目

- 是新 Session 的默认模式。
- 读取当前 Session。
- 读取当前项目内、属于同一个 Agent 的项目记忆、文件和获选历史 Session。
- 不读取该 Agent 的其他项目。
- 新记忆默认写入当前 Agent 在当前项目下的待确认区。

#### Agent 全部记忆

- 读取当前项目上下文。
- 允许读取当前 Agent 自己的长期记忆。
- 可在高级设置中选择或排除该 Agent 自己的历史 Session。
- 只有 Agent 所有者或管理员可启用。
- 永远不能读取另一个 Agent 的内容。

### 4.3 高级 Session 选择

- Session 列表只包含当前账号自己创建、且绑定到当前 Agent 的 Session。
- 选择项显示用户可理解的标题、项目和更新时间，不显示 Runtime ref。
- 取消某个 Session 后，下一个 Run 不再包含它。
- 切换 Agent 后，已选 Session 全部清空。
- 删除、禁用或撤权的 Session 不再作为新 Run 的上下文，但已完成 Run 的历史快照保持可追溯。

### 4.4 记忆写入

- 默认写入策略是“每次确认”。
- Agent 提议写入记忆时，画板显示内容摘要、目标 Agent、目标范围和来源 Session。
- 用户批准后才能提交；拒绝后不得产生长期记忆。
- `仅当前对话` 模式不产生长期记忆写入。
- `当前项目` 模式默认写入当前 Agent 的当前项目记忆。
- 写入 Agent 全局记忆需要所有者或管理员权限。
- 不允许后台静默把项目记忆提升为 Agent 全局记忆。

### 4.5 不可变运行快照

每个 Run 固化：

- Agent 和 AgentBinding；
- 记忆模式；
- ContextRef ID；
- 被选 Session ID；
- 上下文摘要或 digest；
- 写入策略；
- 模型、工具和审批策略。

后续调整设置只产生新的 SessionConfigRevision，不修改旧 Run 的输入快照。
如果策略或解析后的上下文 digest 发生变化，下一个 Run 必须使用新的
`canvas:` Runtime Session，只重放 Canvas 已持久化的安全 transcript；旧
Runtime Session ref 转为历史，不能在原 Session 中就地缩窄策略，以免继续
携带旧长期记忆或缓存 prompt。
策略收窄不删除当前 Canvas Session 已可见的消息；已经出现在旧回复里的内容
仍属于“当前对话”。隔离负向测试必须使用从未回显进当前 transcript 的标记。

### 4.6 数据模型补强

现有 `context_refs` 已支持 account、agent、workflow、session 和 run 范围，但当前 workflow 范围不能同时表达“属于哪个 Agent”。为满足同项目多 Agent 的强隔离，实施时必须采用显式的 Agent × Workflow 范围，而不是依赖 `source_ref` 字符串约定。

推荐增加 `agent_workflow` context scope，并要求：

- `agent_id` 和 `workflow_id` 同时存在；
- `session_id`、`run_id` 为空；
- 授权加载索引包含 Agent、Workflow、Account、Visibility 和过期时间；
- Repository 在服务端从已授权 AgentBinding 推导 Agent ID，不接受浏览器自报；
- 任何跨 Agent 或跨 Workflow ContextRef 在写入和读取时都 fail closed。

## 5. 总体架构

```text
真实画板
  → Canvas Route Handler
  → SessionService / ContextPolicyService
      → PostgreSQL（唯一控制面事实源）
      → RuntimeAdapterRegistry
          → JarvisGatewayRuntimeAdapter
              → 当前家庭 Jarvis Gateway
          → HermesProfileAcpRuntimeAdapter
              → zzh profile / 于途
              → nsy profile / 乔晶晶
```

浏览器永远不直接连接 Jarvis 或 Hermes，不获得 API key，也不决定 Runtime endpoint。

由于当前 Web 运行在 Docker 容器内，而 Jarvis 只监听宿主 loopback，
落地时在 Registry 与真实 Runtime 之间增加受权限保护的宿主 Unix Socket
Worker。Worker 只是 Canvas 的本机 transport adapter：它直接连接 Jarvis
Gateway 或 profile-scoped ACP，不经过旧 Control Center 或 Family Gateway；
它不新增 TCP 端口，也不把 Hermes home、profile 密钥或原始记忆挂进 Web
容器。

### 5.1 Canvas 事实源

Canvas PostgreSQL 是以下数据的唯一控制面事实源：

- Account、Agent、Agent grant 和默认 Agent；
- Workspace、Workflow、画板节点；
- Canvas Session、Message、Run；
- AgentBinding 和外部 Session/Run ref；
- ContextRef、记忆策略和被选 Session；
- 命令 receipt、事件、审批和 reconciliation。

Hermes 继续拥有各 profile 的人格、工具、原生长期记忆和原生 Session。Canvas 只保存必要的引用、授权上下文、不可变运行快照和可展示的规范化事件，不复制 `.env`、SOUL、原始 memory 文件或密钥。

### 5.2 Runtime 路由

现有 Composition Root 不再硬编码单一 `DeterministicFakeRuntime`。新增 RuntimeAdapterRegistry，按数据库中的 `AgentBinding.runtimeKind` 路由。

Runtime kind 必须忠实表达实际协议：

- `hermes-gateway`：Jarvis 的 Hermes HTTP/Run API；
- `hermes-acp`：于途和乔晶晶的 profile-scoped ACP；
- `fake`：仅测试和显式开发。

不得把 Jarvis Gateway 伪装成 `hermes-acp`，也不得只靠 endpointRef 猜测协议。

Binding 上下文必须包含并校验：

- Canvas AgentBinding ID；
- Agent ID；
- Runtime kind；
- isolation key；
- endpoint ref；
- secret ref；
- external agent/profile ref。

Registry 在任何 Runtime 调用前验证 Binding kind 与 Adapter descriptor 一致。未知 kind、缺少 Adapter 或 kind 不匹配时 fail closed。

Fake Runtime 只用于自动测试和显式开发模式，不能成为生产失败时的回退路径。

### 5.3 Jarvis

Jarvis 直接连接当前正在运行的家庭 Jarvis Gateway，使用其现有身份、人格、记忆、技能和工具。

Canvas 使用服务端 secretRef 解析认证信息，并通过 Hermes 的结构化 Run、
事件和 Session 接口完成映射。浏览器不直接访问 Jarvis 本机接口。首版的
审批与停止能力在具备 durable receipt 和 outcome lookup 前明确为
unsupported，产品不显示相关入口，也不启用需要交互审批的工具。

Canvas 为 Jarvis 使用独立的 `canvas:` Session key，不能复用 Discord、cron、DinnerPlanner 或其他家庭入口的会话标识。Agent 全部记忆模式可以读取获准的 Jarvis 长期记忆，但短期对话历史仍按 Canvas Session 隔离。

### 5.4 于途和乔晶晶

个人助理通过现有 Hermes personal-assistants home 中的 profile 运行：

- 于途：`zzh`
- 乔晶晶：`nsy`

首版通过 profile-scoped ACP 接入。Adapter 必须显式设置 personal-assistants HERMES_HOME 和小写 profile ID，不依赖进程默认 home。`zzh`、`nsy` 不单独启动 gateway service；现有 multiplex gateway 保持不变。

Canvas 创建的 Hermes Session 使用独立的 `canvas:` 命名空间，不复用微信、Discord、cron 或其他 Gateway 会话 ID。由于 ACP 与现有 multiplex gateway 会访问同一个 profile，实施前必须证明 SessionDB 和记忆写入的并发安全：

- Canvas Session 不能覆盖或继续消息平台 Session；
- 同一 profile 的并发 Run 使用不同 Session 和审批命名空间；
- 记忆更新使用原子写入或 profile 级互斥；
- 无法证明并发写入安全时，先禁用 Canvas 的长期记忆写入，不能冒险上线。

### 5.5 请求级记忆控制

当前 Hermes Gateway/ACP 没有完整暴露 Canvas 所需的每次 Run 记忆策略。实现必须增加请求级控制，而不能修改 profile 的全局配置：

- 是否读取内建长期记忆；
- 是否读取用户画像；
- 当前 Agent × Project memory scope；
- 被允许的外部 Session/context refs；
- 是否允许提出记忆写入；
- 写入目标范围。

该控制必须是 Agent 实例或请求上下文级，不能通过临时改写共享 `config.yaml` 实现。并发 Run 不得互相污染。

Runtime 不支持某模式时，Adapter 必须诚实声明 unsupported，前端禁用该选项并解释原因。不得显示一个不能实际限制记忆的选择器。

### 5.6 账号身份

当前 Web Route Handler 使用固定的 `AUTH_MODE=local` 和单一 `APP_OWNER_SUBJECT`，不能真实区分 ZZH、NSY 和管理员。多账号产品验收前必须替换为服务端可信的 `AuthenticatedAccountResolver`：

- Account 身份来自服务端验证过的会话；
- 首版本机身份采用 Canvas 自己的设备配对会话；
- 受本机 OS/数据库权限保护的 `local_operator` 命令为指定 Account 生成
  十分钟有效、只能使用一次的配对码，并如实记录 operator issuer，不伪装成
  某个管理员 Account；
- `/pair` 用配对码换取高熵随机 Session token；
- 浏览器只保存 Host-only、HttpOnly、SameSite=Strict Cookie；
- 数据库只保存 token hash、Account、到期时间、创建时间和撤销时间；
- 每个请求由 Resolver 校验 token hash、有效期和撤销状态后生成 ActorContext；
- 浏览器不能通过提交 accountId、authSubject 或自定义 Header 冒充账号；
- Route Handler 只接收 Resolver 返回的 ActorContext；
- ZZH、NSY 和管理员使用隔离的真实浏览器会话完成验收。

配对码和 Session token 不写日志，Session 可由管理员撤销。当前仍保持 loopback；未来通过 TLS 提供远程访问时，Cookie 必须增加 Secure。开发态账号切换器可以辅助自动测试，不能作为多账号产品验收依据。未来统一身份平台可以替换 Resolver，但不改变 Route Handler 和控制面授权。

## 6. 关键数据流

### 6.1 进入画板

1. 服务端解析当前 Account。
2. 查询有效 Agent grants 和存储的 Account default Agent。
3. 返回可用 Agent 的安全摘要，以及只可能指向该过滤列表成员的
   `effectiveDefaultAgentId: string | null`。
4. 正常种子账号的有效默认值是 Jarvis；若默认 grant 被撤销则返回 `null`，
   有其他授权时要求用户显式选择，零授权时显示安全空状态而不创建 draft。
5. 节点已有 Session 时，从服务端恢复 AgentBinding 和 SessionConfigRevision。

### 6.2 创建 Session

1. 用户选择 Agent。
2. 服务端重新验证 Agent grant。
3. 服务端选择该 Agent 的 primary ready/degraded Binding。
4. 持久化 Canvas Session、SessionNode 和初始 SessionConfigRevision。
5. RuntimeAdapterRegistry 创建外部 Session。
6. 先记录外部 ref，再完成 attach；结果未知时进入 reconciliation。

### 6.3 开始 Run

1. 浏览器只提交 Session ID、内容和幂等键。
2. 服务端锁定并授权 Session。
3. 服务端从 SessionConfigRevision 推导 Agent、模型、工具和记忆策略。
4. Repository 原子写入 Message、queued Run、receipt 和不可变快照。
5. Registry 路由到对应 Runtime。
6. Adapter 将 Runtime 事件白名单归一化。
7. 事件持久化后再投影到真实画板。

浏览器不能在请求中覆盖 Runtime kind、external ref、endpoint、secret、Agent ID 或上下文 digest。

### 6.4 切换 Agent

1. 服务端验证目标 Agent 权限。
2. 仅尚未创建 Session 的草稿节点可以直接改选 Agent。
3. 已 attach 的 Session 创建新的 Session 和 SessionNode，并记录来源关系。
4. 新 Session 使用目标 Agent 的默认记忆策略，旧 Agent 的 ContextRef 和历史 Session 选择不进入新 Session。
5. 原节点保留旧 Session 历史，画板选中新节点继续对话。

## 7. 失败、恢复与安全

### 7.1 不回退

- Jarvis、于途或乔晶晶失败时，不自动改用 Fake Runtime。
- 一个真实 Agent 失败时，不自动改用另一个真实 Agent。
- Agent 离线不影响已持久化历史的读取。

### 7.2 重试

- 已确认请求未送达：允许用户点击“重新发送”。
- 已确认失败：显示可理解原因并允许手动重试。
- 无法确认是否送达：显示“正在确认”，禁止重复发送。
- 不执行后台无限自动重试。
- 重试使用服务端幂等和 reconciliation 规则，避免重复工具执行。

### 7.3 权限与密钥

- Agent 列举、Session 创建、Run、上下文加载和记忆写入都执行服务端授权。
- endpointRef 和 secretRef 不返回浏览器。
- 日志、数据库事件和错误消息执行密钥扫描和白名单归一化。
- profile ID、Session ref 和错误栈不作为普通产品文案。
- 撤销 Agent grant 后，禁止新 Run 和新上下文加载。

### 7.4 记忆真实性

如果选择“仅当前对话”后 Agent 仍能读取长期记忆，该模式判定为未实现，整个相关产品旅程失败。

如果“当前项目”能读取同一 Agent 的其他项目、同项目的其他 Agent 或未勾选 Session，视为数据隔离事故，立即停止上线。

## 8. 管理后台演进

本次不实现管理后台，但数据和服务接口必须支持后续统一管理：

- 创建、编辑、禁用 Agent；
- 配置 Runtime Adapter、endpointRef、secretRef 和 external profile ref；
- 配置账号授权；
- 配置账号默认 Agent；
- 配置默认记忆模式和可用模式；
- 查看健康状态、版本和能力；
- 审计记忆写入、授权变化和运行失败。

当前首版使用幂等 provisioning/seed 创建 Jarvis、于途和乔晶晶。Seed 不得覆盖管理员未来修改的名称、授权和默认值。

## 9. 验证策略

### 9.1 自动测试是前置条件

必须覆盖：

- 一次性配对码、Session Cookie、到期、撤销和伪造身份拒绝；
- RuntimeAdapterRegistry 的正确路由和 kind 错配拒绝；
- Canvas Session namespace 与消息平台 Session namespace 不冲突；
- Canvas 与现有 multiplex gateway 并发访问同一 profile 时不串 Session、不丢记忆更新；
- Agent grant 和 default Agent；
- ZZH/NSY/API 越权；
- ZZH、NSY 和管理员共享 Jarvis/Workspace 时仍看不到彼此 Session、边和
  画板位置；
- 空账号从“新建对话”草稿创建并 attach 第一条真实 Session；
- Agent 切换后的新 Session；
- 未知 Runtime 结果、幂等、reconciliation 和手动重试；
- Fake Runtime 禁止生产回退；
- 三种记忆模式；
- Agent × Project ContextRef 强隔离；
- 高级 Session 勾选和取消；
- 切换 Agent 清空上下文选择；
- 记忆写入批准和拒绝；
- Run 上下文快照不可变；
- secret 日志和数据库扫描；
- 刷新、应用重启和 Runtime 重启恢复。
- 真实 Run 闸门关闭时所有 Runtime 写入在 Message/Run 落库前 fail closed，
  但 `/` 和历史仍可读；
- 停止 Runtime Worker 不连带停止 Canvas，恢复 Worker 后无需重启 Web。

### 9.2 真实 Runtime 证明

Jarvis、于途、乔晶晶分别完成至少一次安全的真实对话。验收同时检查：

- Canvas 数据库中的 AgentBinding、Session、Run 和事件；
- Runtime 日志或 Session/Profile 证据；
- 浏览器实际收到的流式事件；
- 没有 Fake Runtime 参与；
- 没有跨 profile 内容。

不能只通过让 Agent 自报“我是 Jarvis/于途/乔晶晶”证明路由正确。

### 9.3 记忆隔离证明

使用不含私人内容的唯一测试标记：

- `仅当前对话` 不能读取长期标记；
- `当前项目` 只能读取当前 Agent 当前项目标记；
- `Agent 全部记忆` 能读取当前 Agent 长期标记；
- 任意模式都不能读取另一个 Agent 标记；
- 勾选的历史 Session 标记可读取；
- 取消后下一个 Run 不可读取；
- 写入批准后可读取，拒绝后不可读取。

### 9.4 产品体验验收

产品验收必须通过真实画板 `/` 完成，`/control-plane-test` 只允许作为诊断工具。

#### ZZH 旅程

1. ZZH 使用一次性配对码建立自己的服务端会话并进入真实画板。
2. 默认 Agent 是 Jarvis。
3. 选择器只显示 Jarvis、于途。
4. 选择于途并使用默认“当前项目”记忆。
5. 从画板发送真实消息并看到流式回复。
6. 选择一个于途历史 Session，下一次回复能使用该上下文。
7. 切换回 Jarvis，系统创建新 Session 并清空于途上下文选择。
8. 刷新后画板和 Session 历史仍存在。

#### NSY 旅程

1. NSY 使用自己的配对码建立与 ZZH 隔离的服务端会话并进入真实画板。
2. 默认 Agent 是 Jarvis。
3. 选择器只显示 Jarvis、乔晶晶。
4. 选择乔晶晶并完成真实对话。
5. 验证当前项目记忆和高级 Session 选择。
6. 验证无法访问于途。
7. 刷新和重启后状态恢复。

#### 管理员旅程

1. 管理员通过独立配对会话进入画板，并可看到三个 Agent。
2. 管理员可以检查状态和能力摘要。
3. 管理员不能在普通产品界面看到密钥或原始 Runtime ref。

### 9.5 视觉和可用性

- 桌面宽屏完成三条旅程并保存关键截图。
- 窄屏完成 Agent 选择、记忆模式、Session 选择、发送和错误恢复。
- 下拉框、状态、记忆说明和恢复按钮使用普通用户文案。
- 不要求用户理解 Runtime、ACP、profile、Binding、ContextRef 或 reconciliation。

### 9.6 运行证据

完成声明必须附带：

- 测试命令、退出码和通过数量；
- 生产构建结果；
- 监听地址和 HTTP 健康结果；
- 服务、容器、日志和数据库证据；
- 真实画板桌面/窄屏截图；
- Jarvis、zzh、nsy 的安全路由证据；
- 重启前后证据；
- 未测试边界。

## 10. 上线与回滚

### 10.1 分阶段

1. Registry、Binding kind 和通用 provisioning。
2. Jarvis Gateway Adapter。
3. Hermes profile ACP Adapter。
4. Agent grants/default Agent 和真实画板选择器。
5. Session/Run 接入真实画板。
6. Agent × Project 记忆策略和请求级 Hermes 控制。
7. 产品体验、重启和故障验收。

每阶段使用独立开关，但生产界面不得把未通过能力闸门的模式标为可用。

### 10.2 立即回滚条件

出现以下任一情况立即停止上线：

- 跨账号 Agent 越权；
- 跨 Agent、跨 profile 或跨项目记忆泄漏；
- Agent 切换后复用旧 Runtime Session；
- 结果不确定时产生重复 Run 或重复工具执行；
- 真实 Agent 失败后静默回退 Fake；
- “仅当前对话”仍读取长期记忆；
- 重启后 Agent、Session 或记忆策略错绑；
- 密钥进入浏览器、日志或数据库事件。

回滚后保留已持久化的 Canvas 历史，禁用新真实 Run，不删除用户数据，也不改写 Jarvis、zzh 或 nsy 的现有 profile。

## 11. 运维文档

实现涉及 Jarvis 现有本机接口和 Hermes 架构，交付时必须同步：

- `/home/youran/data/agent-architecture.md`
- `/home/youran/data/service-ports.md`
- `/home/youran/data/service-ports.json`

本设计不新增浏览器可访问的 Hermes 端口。ACP 使用 stdio。Canvas 和 Jarvis 均保持 loopback，未经访问控制评估不得改绑 `0.0.0.0`。

## 12. 非目标

- 本次不实现管理后台。
- 不在 Canvas 中逐条编辑或删除 Hermes 原始 memory 文件。
- 不复制 Jarvis、zzh、nsy 的 SOUL、`.env`、skill 或私人 memory 到 Canvas。
- 不改变 Jarvis、于途或乔晶晶的主模型。
- 不把 Family AI Gateway 或旧 Agent Control Center 作为 Canvas Runtime 数据面。
- 不把 `/control-plane-test` 包装成正式产品页面。
- 不用 Fake Runtime 的成功证明真实 Agent 可用。

## 13. Definition of Done

只有同时满足以下条件，才可以对用户说“现在能用”：

1. Jarvis、于途、乔晶晶都由真实画板完成真实运行。
2. ZZH、NSY 和管理员的选择器与权限符合设计。
3. 三种记忆模式和高级 Session 选择真实生效。
4. 跨 Agent、跨账号、跨项目和跨 profile 隔离全部通过。
5. Agent 切换、新 Session、刷新和重启恢复全部通过。
6. 失败与未知结果提供可理解且不会重复执行的恢复路径。
7. 桌面和窄屏产品旅程有截图和运行证据。
8. 后台/API/数据库测试全部通过。
9. 运维文档和端口清单同步。
10. 未测试边界、回滚条件和当前限制明确记录。

局部后台完成、单个 Adapter 通过、HTTP 返回成功、数据库有记录、Agent 自报身份或 `/control-plane-test` 可操作，均不能单独满足 Definition of Done。

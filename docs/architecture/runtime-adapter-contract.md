# RuntimeAdapter 契约

状态：Accepted
版本：1.0
日期：2026-07-15

## 1. 目的

`RuntimeAdapter` 是 Canvas 控制面和 Hermes/Letta/LangGraph/未来原生 Runtime 之间唯一允许的执行边界。产品服务不得直接 import Hermes 内部模块、Letta SDK 对象或供应商事件类型。

契约目标：

- 同一套 Session/Run 领域服务可替换 Runtime；
- Runtime 特有能力通过 capability negotiation 暴露；
- 所有事件归一化后再进入 Canvas 数据库和 UI；
- Canvas ID、幂等、权限和审计不依赖 Runtime；
- 支持断线重连、取消、工具审批、模型切换和锚点 fork。

## 2. TypeScript 契约

以下代码是实施时的规范接口，不是伪代码：

```ts
export type RuntimeKind =
  | 'fake'
  | 'hermes-acp'
  | 'letta'
  | 'langgraph'
  | 'canvas-native';

export type CapabilitySupport = 'native' | 'adapter' | 'unsupported';

export interface RuntimeCapabilities {
  persistentSessions: CapabilitySupport;
  completedTurnPersistence: CapabilitySupport;
  inFlightResume: CapabilitySupport;
  concurrentSessions: CapabilitySupport;
  forkSession: CapabilitySupport;
  forkAtMessage: CapabilitySupport;
  eventReplay: CapabilitySupport;
  streamingText: CapabilitySupport;
  streamingToolOutput: CapabilitySupport;
  typedFailures: CapabilitySupport;
  cancellation: CapabilitySupport;
  toolApproval: CapabilitySupport;
  sessionModelSwitch: CapabilitySupport;
  sessionToolPolicy: CapabilitySupport;
  perSessionMcpPolicy: CapabilitySupport;
  clientIdempotency: CapabilitySupport;
  exactlyOneTerminalEvent: CapabilitySupport;
  snapshotRestore: CapabilitySupport;
  runtimeModelCatalog: CapabilitySupport;
}

export interface RuntimeDescriptor {
  kind: RuntimeKind;
  runtimeVersion: string;
  adapterVersion: string;
  capabilities: RuntimeCapabilities;
}

export interface RuntimeBindingContext {
  canvasAgentBindingId: string;
  isolationKey: string;
  endpointRef?: string;
  secretRef?: string;
}

export interface RuntimeModelSelection {
  providerKey: string;
  modelKey: string;
}

export interface RuntimeToolPolicy {
  allowedToolKeys: string[];
  deniedToolKeys: string[];
  approvalRequiredToolKeys: string[];
}

export interface RuntimeContextItem {
  canvasContextRefId: string;
  scope: 'account' | 'agent' | 'workflow' | 'session' | 'run';
  visibility: 'private' | 'workspace';
  content: unknown;
  provenance: Record<string, unknown>;
}

export interface RuntimeTranscriptMessage {
  canvasMessageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
}

export interface RuntimeSessionRef {
  externalSessionRef: string;
  runtimeVersion: string;
  replayStatus: 'complete' | 'partial' | 'unknown';
  historyDigest?: string;
  lineage?: {
    parentCanvasSessionId: string;
    atCanvasMessageId: string;
    sourceRevisionId: string;
    transcriptPrefixDigest: string;
  };
  metadata: Record<string, unknown>;
}

export interface CreateRuntimeSessionInput {
  commandId: string;
  binding: RuntimeBindingContext;
  canvasSessionId: string;
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: RuntimeContextItem[];
}

export interface LoadRuntimeSessionInput {
  commandId: string;
  binding: RuntimeBindingContext;
  canvasSessionId: string;
  externalSessionRef: string;
}

export interface ForkRuntimeSessionInput {
  commandId: string;
  binding: RuntimeBindingContext;
  parentCanvasSessionId: string;
  parentExternalSessionRef: string;
  childCanvasSessionId: string;
  atCanvasMessageId: string;
  sourceRevisionId: string;
  expectedParentHistoryDigest: string;
  transcriptPrefixDigest: string;
  transcriptPrefix: RuntimeTranscriptMessage[];
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: RuntimeContextItem[];
}

export interface StartRuntimeRunInput {
  commandId: string;
  idempotencyKey: string;
  binding: RuntimeBindingContext;
  canvasRunId: string;
  canvasSessionId: string;
  externalSessionRef: string;
  expectedHistoryDigest: string;
  prompt: RuntimeTranscriptMessage;
  model: RuntimeModelSelection;
  toolPolicy: RuntimeToolPolicy;
  context: RuntimeContextItem[];
}

export interface RuntimeRunRef {
  externalRunRef?: string;
  acceptedAt: string;
}

export type RuntimeEvent =
  | RuntimeRunAccepted
  | RuntimeRunStarted
  | RuntimeModelOutputDelta
  | RuntimeMessageCompleted
  | RuntimeToolRequested
  | RuntimeApprovalRequired
  | RuntimeToolStarted
  | RuntimeToolOutputDelta
  | RuntimeToolCompleted
  | RuntimeArtifactUpdated
  | RuntimeRunCompleted
  | RuntimeRunFailed
  | RuntimeRunCancelled
  | RuntimeWarning;

interface RuntimeEventBase {
  eventId: string; // Adapter 在同一 Run 重放时必须稳定；不是 payload 内容 hash
  externalSequence?: number;
  canvasSessionId: string;
  canvasRunId: string;
  externalEventRef?: string;
  occurredAt: string;
}

export interface RuntimeRunAccepted extends RuntimeEventBase {
  type: 'run.accepted';
  externalRunRef?: string;
}

export interface RuntimeRunStarted extends RuntimeEventBase {
  type: 'run.started';
}

export interface RuntimeModelOutputDelta extends RuntimeEventBase {
  type: 'model.output.delta';
  text: string;
}

export interface RuntimeMessageCompleted extends RuntimeEventBase {
  type: 'message.completed';
  role: 'assistant' | 'tool';
  content: unknown;
  externalMessageRef?: string;
}

export interface RuntimeToolRequested extends RuntimeEventBase {
  type: 'tool.requested';
  toolCallRef: string;
  toolKey: string;
  input: unknown;
}

export interface RuntimeApprovalRequired extends RuntimeEventBase {
  type: 'approval.required';
  approvalRef: string;
  toolCallRef: string;
  toolKey: string;
  risk: 'low' | 'medium' | 'high';
  choices: Array<'allow-once' | 'allow-session' | 'deny'>;
}

export interface RuntimeToolStarted extends RuntimeEventBase {
  type: 'tool.started';
  toolCallRef: string;
}

export interface RuntimeToolOutputDelta extends RuntimeEventBase {
  type: 'tool.output.delta';
  toolCallRef: string;
  content: unknown;
}

export interface RuntimeToolCompleted extends RuntimeEventBase {
  type: 'tool.completed';
  toolCallRef: string;
  output: unknown;
  isError: boolean;
}

export interface RuntimeArtifactUpdated extends RuntimeEventBase {
  type: 'artifact.updated';
  artifactKind: string;
  title: string;
  content: unknown;
}

export interface RuntimeRunCompleted extends RuntimeEventBase {
  type: 'run.completed';
  usage?: { inputTokens?: number; outputTokens?: number; costMicros?: number };
}

export interface RuntimeRunFailed extends RuntimeEventBase {
  type: 'run.failed';
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
}

export interface RuntimeRunCancelled extends RuntimeEventBase {
  type: 'run.cancelled';
  reason: 'user' | 'timeout' | 'shutdown' | 'policy';
}

export interface RuntimeWarning extends RuntimeEventBase {
  type: 'runtime.warning';
  code: string;
  message: string;
}

export type RuntimeErrorCode =
  | 'runtime_unavailable'
  | 'binding_not_found'
  | 'session_not_found'
  | 'session_ownership_mismatch'
  | 'session_busy'
  | 'run_not_found'
  | 'model_not_available'
  | 'tool_not_allowed'
  | 'approval_expired'
  | 'context_rejected'
  | 'transcript_conflict'
  | 'history_diverged'
  | 'replay_incomplete'
  | 'rate_limited'
  | 'cancelled'
  | 'protocol_error'
  | 'internal_error';

export type RuntimeOperationEffect = 'not-applied' | 'unknown';

export class RuntimeAdapterError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly retryable = false,
    readonly operationEffect: RuntimeOperationEffect = 'unknown',
  ) {
    super(message);
    this.name = 'RuntimeAdapterError';
  }
}

export class RuntimeCapabilityError extends RuntimeAdapterError {
  constructor(readonly capability: keyof RuntimeCapabilities) {
    super('protocol_error', `Runtime capability is not available: ${capability}`, false, 'not-applied');
    this.name = 'RuntimeCapabilityError';
  }
}

export interface RuntimeApprovalDecision {
  commandId: string;
  binding: RuntimeBindingContext;
  canvasRunId: string;
  externalRunRef?: string;
  approvalRef: string;
  decision: 'allow-once' | 'allow-session' | 'deny';
}

export interface RuntimeSnapshot {
  format: string;
  version: string;
  payload: unknown;
}

export interface RuntimeModelEntry {
  providerKey: string;
  modelKey: string;
  displayName: string;
  capabilities: Record<string, unknown>;
}

export interface RuntimeHealth {
  status: 'ready' | 'degraded' | 'unavailable';
  checkedAt: string;
  details: Record<string, unknown>;
}

export interface RuntimeCancelAck {
  outcome: 'accepted' | 'already-terminal' | 'not-active' | 'unknown';
  externalRunRef?: string;
  observedTerminal?: 'succeeded' | 'failed' | 'cancelled';
  acknowledgedAt: string;
}

export interface RuntimeAdapter {
  describe(binding: RuntimeBindingContext): Promise<RuntimeDescriptor>;
  health(binding: RuntimeBindingContext): Promise<RuntimeHealth>;
  listModels(binding: RuntimeBindingContext): Promise<RuntimeModelEntry[]>;
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSessionRef>;
  loadSession(input: LoadRuntimeSessionInput): Promise<RuntimeSessionRef>;
  listSessions(input: {
    binding: RuntimeBindingContext;
    cursor?: string;
  }): Promise<{ sessions: RuntimeSessionRef[]; nextCursor?: string }>;
  forkSession(input: ForkRuntimeSessionInput): Promise<RuntimeSessionRef>;
  startRun(input: StartRuntimeRunInput): Promise<RuntimeRunRef>;
  streamRunEvents(input: {
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
    afterExternalEventRef?: string;
  }): AsyncIterable<RuntimeEvent>;
  cancelRun(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasRunId: string;
    externalRunRef?: string;
  }): Promise<RuntimeCancelAck>;
  respondToApproval(input: RuntimeApprovalDecision): Promise<void>;
  setSessionModel(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasSessionId: string;
    externalSessionRef: string;
    model: RuntimeModelSelection;
    expectedIdle: true;
  }): Promise<void>;
  setSessionToolPolicy(input: {
    commandId: string;
    binding: RuntimeBindingContext;
    canvasSessionId: string;
    externalSessionRef: string;
    toolPolicy: RuntimeToolPolicy;
    expectedIdle: true;
  }): Promise<void>;
  exportSnapshot(input: LoadRuntimeSessionInput): Promise<RuntimeSnapshot>;
  restoreSnapshot(input: CreateRuntimeSessionInput & {
    snapshot: RuntimeSnapshot;
  }): Promise<RuntimeSessionRef>;
  shutdown(input: {
    binding: RuntimeBindingContext;
    reason: 'test' | 'deploy' | 'idle' | 'failure';
  }): Promise<void>;
}
```

## 3. Capability negotiation

每项能力必须声明为：`native`（Runtime 原生满足）、`adapter`（Adapter 在边界内补齐并通过契约测试）或 `unsupported`。Adapter 对不支持的操作必须抛出上文定义的结构化 `RuntimeCapabilityError`：`capability` 指明缺失能力，`operationEffect = not-applied` 明确未产生外部副作用；同时必须在 `describe()` 中提前如实声明。控制面按以下规则降级：

| 能力缺失 | 允许降级 | 处理 |
|---|---|---|
| `forkAtMessage` | 有条件 | 只有 Adapter 能安全导入精确 transcript prefix 且通过 digest/lineage 测试时才声明 `adapter`；否则返回 unsupported |
| `eventReplay` | Gate 0 可 | Canvas 维持连接；断线后对账 transcript，生产前必须补齐 |
| `sessionModelSwitch` | 是 | fork 新 Session 使用新模型；UI 明示 |
| `toolApproval` | 否 | 有风险工具必须禁用，不得自动放行 |
| `cancellation` | 否 | 不进入正式运行时主线 |
| `persistentSessions` | 否 | 只能作为测试 Fake Runtime |
| `concurrentSessions` | 否 | 不适合“一 Agent 多 Chat 块”主线 |

`forkAtMessage` 的补齐只能由 Canvas Adapter 完成，不能把复杂性暴露给页面组件，也不能把非 HEAD fork 静默改成 HEAD fork 或空 Session。无法证明精确语义时必须阻断该操作。

## 4. 事件规范化

Runtime 事件进入 Canvas 时执行：

1. 解析 Runtime 原生事件；
2. 删除或遮盖 secret、Authorization、cookie 和工具敏感字段；
3. 映射为规范 `RuntimeEvent`；
4. 优先使用 Runtime durable event ref/sequence；否则使用 Adapter 持久 ledger 分配、并在重放时复用 `eventId`；
5. 在单一 `ingestRuntimeEvent` 事务中锁 Run、按稳定事件 key 去重并分配 Canvas `sequence`；
6. 在该事务内追加 RunEvent；
7. 在同一事务对 `message.completed`、`artifact.updated` 和终态事件幂等更新投影；
8. 提交成功后才推送给 SSE/WebSocket 消费者。

Runtime 的 delta 不是最终 Message。只有 `message.completed` 或控制面根据终态合并并校验后的内容才能写 `completed` Message。

禁止用 payload 内容 hash 去重 delta：连续两个相同字符、空格或相同工具进度都是合法独立事件。Runtime 既没有 durable identity、Adapter 也无法持久映射时，必须把 `eventReplay` 声明为 unsupported，并在断线后进入 transcript reconciliation。

## 5. 幂等与补偿

- `commandId`：跨控制面与 Runtime 的操作 ID；重试同一命令不得创建第二个资源。
- `idempotencyKey`：同一 Session 开始 Run 的业务键。
- Runtime 不支持幂等时，Adapter 维护 command ledger，并在未知结果时进入 reconciliation，不盲目重试。
- Canvas `command_receipts` 还必须保存编排 phase 和已知 external ref：`attached` 直接返回原结果，`runtime_dispatched/runtime_known/reconciling` 只能 adopt/reconcile。数据库去重本身不能证明外部副作用幂等。
- Canvas 事务成功、Runtime 创建明确以 `operationEffect=not-applied` 失败：receipt 记录 retryable/terminal failure；只有 retryable 才允许原 command 再次 dispatch。
- Runtime 明确证明副作用未发生时，receipt 才能回到可安全重试；transport/进程异常默认是 outcome unknown。
- Runtime 创建成功、Canvas 更新失败：先将 external ref 写入持久 `runtime_compensations`；若 external ref 也未知，则保存 commandId/canvasSessionId lookup metadata，再查回、adopt 或销毁孤儿资源；进程内日志不算补偿记录。
- `cancelRun` 返回 accepted 只说明 Runtime 接受请求，不是终态；Canvas 只有收到 `run.cancelled` 或 `observedTerminal` 才写终态。`unknown/not-active` 且无法证明终态时进入 `reconciling`。

## 6. Hermes ACP 映射

| Canvas 契约 | Hermes ACP | Adapter 责任 |
|---|---|---|
| `createSession` | `SessionManager.create_session` / ACP `new_session` | 设置 profile-scoped HERMES_HOME，记录 external ref |
| `loadSession` | `get_session` / ACP `load_session` | 验证 Session 属于当前 Binding |
| `listSessions` | `SessionManager.list_sessions` / ACP list | 只用于 reconciliation；Canvas 列表仍来自产品数据库 |
| `forkSession` | 原生 `fork_session` 只复制全历史 | HEAD fork 可适配；精确 forkAt 只有在安全 prefix 导入通过测试后才能声明支持 |
| `startRun` | ACP `prompt` | 将 ACP session updates 归一化为 RuntimeEvent |
| `streamRunEvents` | ACP connection callbacks | 建立顺序、去重和断线处理 |
| `cancelRun` | ACP `cancel` 只面向当前 Session turn，没有原生 run-id/确认持久化 | Adapter 校验当前 Canvas run；返回明确 `RuntimeCancelAck`，无法确认时用 `unknown` 并标记 reconciling，不能声称 exactly-once cancel |
| `respondToApproval` | ACP permission response | 再次检查 Canvas ToolGrant |
| `setSessionModel` | ACP `set_session_model` | 更新后探测实际 provider/model 并写 Run 快照 |
| `setSessionToolPolicy` | 无完整 per-session Tool/MCP ACL | Canvas deny-first；Worker 启动时限制 toolsets；缺口未通过前禁高风险工具 |
| `shutdown` | 结束独立 ACP 子进程 | Worker Supervisor 等待退出并记录 active Run 的中断/对账事件 |

初期每个 `AgentBinding + Workspace execution scope` 使用独立 Worker 或等价的 OS/container 隔离边界；同一隔离范围内可承载多个 Session。不能仅靠请求字段在多个账号或 Workspace 之间切换 HERMES_HOME、cwd、MCP registry 和 secret。

## 7. Letta 和 LangGraph 映射原则

- Letta Agent 对应 AgentBinding，Conversation 对应 Runtime Session；Letta memory block 仍是 Runtime 私有实现。
- LangGraph Thread 对应 Runtime Session，Run/checkpoint 对应 Runtime 执行状态；Graph/Assistant 不成为 Canvas Workflow 或 AgentIdentity 的事实源。
- Adapter 可以保存 vendor metadata，但领域服务和数据库外键不得依赖 vendor 类型名称。

## 8. 契约测试

每个正式 Adapter 和测试 Fake 必须通过同一套能力驱动测试；每一项声明为 `native/adapter` 的 capability 都必须有正向、失败和重放/幂等用例，不能只测一条 happy path：

共享 runner 接受 Adapter 专属的 `RuntimeContractHarnessFactory`，而不是只接受一个已构造实例。每次 factory 调用都创建隔离的 Adapter/Worker/存储夹具；Harness 暴露当前 `adapter`、保留耐久状态的 `restartRuntime()`、模拟非优雅退出的 `crashRuntime()`，以及等待进程、流、端口和临时资源完全释放的幂等 `dispose()`。进程控制只存在于测试 Harness，不进入产品 `RuntimeAdapter`。声明跨重启能力却没有非空 restart/crash Harness 的 Adapter 直接判失败。

1. `describe()` 的每个 `native/adapter` 声明都有注册测试；缺测试立即失败；
2. 创建、加载、列举两个 Session，external ref 不同；只有声明 persistentSessions 时才执行 Worker 重启加载，否则验证明确 unsupported；
3. 同一 AgentBinding 的并发 Session 不串 transcript，不同 Binding 的人格、记忆、工具和 secret 不串用；
4. 只有声明 clientIdempotency 时才要求重复 `commandId/idempotencyKey` 不重复执行；否则验证 Canvas command ledger 接管且 Runtime 不虚报；
5. 声明 forkAtMessage 时，中间 Message fork 只含精确 prefix、校验 digest/lineage，父 Session 仍 active；
6. 文本 delta 顺序稳定，两个相同 delta 仍有不同 eventId，completed Message 等于累计 delta；同 eventId 重放只入库一次；
7. 声明 toolApproval/tool policy 时，工具请求、审批、拒绝和继续运行状态完整，deny 无法被 auto-approval 绕过；
8. 声明 cancellation 时，accepted/terminal/unknown 分离，重复取消不产生第二个终态，迟到 completed 不复活 Run；
9. Binding 不匹配时 load/list/stream/cancel/model/tool 操作全部失败；
10. 声明 eventReplay/inFlightResume 时分别验证断线或 Harness 强制 Worker 崩溃、再以新 Adapter 连接后的顺序、完整性与对账；
11. 声明模型切换时，下一 Run 实际快照生效，旧 Run 不回写；
12. 所有事件、错误和日志经过 secret 泄漏测试；`shutdown` 后资源释放，active Run 进入中断/对账路径。

Fake、Hermes、Letta 必须运行同一测试包；禁止为某个 Adapter 修改领域预期，只能在明确 capability 降级处改变预期。

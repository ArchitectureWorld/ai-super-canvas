# Agent-Session PostgreSQL 数据库草图

状态：Accepted for implementation planning
日期：2026-07-15
数据库：PostgreSQL 18 + Drizzle ORM

## 1. 设计原则

- Canvas UUID 是产品主键；Runtime ID 只保存为 external reference。
- 业务关系使用外键和唯一约束，事件 payload、选择器和快照使用 JSONB。
- Message、RunEvent、TrunkRevision 采用追加写；不原地重写历史。
- 所有时间使用 `timestamptz`；所有 ID 由应用生成 UUID。
- 所有用户可见资源都能追溯到 Workspace 和授权成员。
- 不把 API key、OAuth token、Hermes `.env` 内容写入业务表，只保存 secret reference。
- v1 使用关系表表达 Session 图，不引入图数据库。

## 2. 枚举

```text
runtime_kind             fake | hermes-acp | letta | langgraph | canvas-native
binding_status           provisioning | ready | degraded | disabled | error
workflow_status          active | dormant | archived
session_status           provisioning | active | dormant | closed | archived | error
growth_state             active | dormant | metabolized
session_edge_kind        derives | references | supports | contradicts | depends_on
run_status               queued | running | waiting_approval | reconciling | succeeded | failed | cancelled
message_role             user | assistant | system | tool
artifact_status          draft | ready | accepted | rejected | superseded
proposal_status          pending | accepted | rejected | stale
tool_grant_effect        allow | deny | require_approval
tool_grant_scope         account | agent | workflow | session | run
context_scope            account | agent | workflow | session | run
context_visibility       private | workspace
```

## 3. Identity 与授权表

### `accounts`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `auth_subject` | text | NOT NULL, unique；登录提供方的稳定主体，local-alpha 也使用该列 |
| `email` | text | nullable, unique on `lower(email)` when non-null |
| `display_name` | text | NOT NULL |
| `default_agent_id` | uuid | nullable FK → agents.id，延迟添加；必须通过下述授权约束 |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

### `workspaces`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `owner_account_id` | uuid | FK → accounts.id, NOT NULL |
| `name` | text | NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

索引：`workspaces(owner_account_id, updated_at desc)`。

### `workspace_members`

| 列 | 类型 | 约束 |
|---|---|---|
| `workspace_id` | uuid | FK → workspaces.id, ON DELETE CASCADE |
| `account_id` | uuid | FK → accounts.id, ON DELETE CASCADE |
| `role` | text | CHECK in `owner, editor, runner, viewer` |
| `created_at` | timestamptz | NOT NULL |

主键：`(workspace_id, account_id)`。

### `agents`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `owner_account_id` | uuid | FK → accounts.id, NOT NULL |
| `name` | text | NOT NULL |
| `status` | text | CHECK in `active, disabled, archived` |
| `default_model_key` | text | nullable |
| `memory_policy` | jsonb | NOT NULL default `{}` |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

索引：`agents(owner_account_id, status)`。

另加 unique `(owner_account_id, id)`，供账号所有权复合外键使用。

### `agent_access_grants`

共享 Agent 不靠前端传入 ID 或 Workspace 成员关系隐式授权：

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `agent_id` | uuid | FK → agents.id, NOT NULL |
| `account_id` | uuid | FK → accounts.id, NOT NULL |
| `role` | text | CHECK in `use, admin` |
| `granted_by_account_id` | uuid | FK → accounts.id, NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `revoked_at` | timestamptz | nullable |

partial unique：`(agent_id, account_id) WHERE revoked_at IS NULL`。延迟约束触发器验证 `accounts.default_agent_id` 对应 Agent 要么由该账号拥有，要么存在有效 `use/admin` Grant；Grant 撤销事务也必须同时清空受影响 default 指针，否则提交失败。S1 bootstrap 只创建账号自有默认 Agent；共享 Agent 的 UI 和管理 API 在 S5 开放。

### `agent_bindings`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `agent_id` | uuid | FK → agents.id, NOT NULL |
| `runtime_kind` | runtime_kind | NOT NULL |
| `external_agent_ref` | text | nullable |
| `isolation_key` | text | NOT NULL |
| `endpoint_ref` | text | nullable；配置引用，不保存凭证 |
| `secret_ref` | text | nullable |
| `runtime_version` | text | nullable |
| `capabilities` | jsonb | NOT NULL default `{}` |
| `status` | binding_status | NOT NULL |
| `is_primary` | boolean | NOT NULL default false |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

约束和索引：

- partial unique：每个 Agent 最多一个 `is_primary = true` 的 ready/degraded Binding；
- partial unique：`(runtime_kind, external_agent_ref)` where external ref is not null and status != disabled；
- unique：`(runtime_kind, isolation_key)` where status != disabled；
- index：`agent_bindings(agent_id, status)`。

## 4. Workflow 与生长图表

### `workflows`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK → workspaces.id, NOT NULL |
| `title` | text | NOT NULL |
| `status` | workflow_status | NOT NULL |
| `current_trunk_revision_id` | uuid | nullable；创建首 revision 后设置 FK |
| `created_by_account_id` | uuid | FK → accounts.id, NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

索引：`workflows(workspace_id, updated_at desc)`。首个 revision 建立后添加 `(id,current_trunk_revision_id) → trunk_revisions(workflow_id,id)` 延迟复合 FK，current 指针不能指向其它 Workflow。

### `trunk_revisions`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | FK → workflows.id, ON DELETE CASCADE |
| `parent_revision_id` | uuid | self FK, nullable |
| `revision_number` | integer | NOT NULL, CHECK > 0 |
| `content` | jsonb | NOT NULL |
| `content_hash` | text | NOT NULL |
| `created_by_account_id` | uuid | FK → accounts.id, NOT NULL |
| `created_from_proposal_id` | uuid | nullable，延迟 FK |
| `created_at` | timestamptz | NOT NULL |

唯一：`(workflow_id, revision_number)`、`(workflow_id, id)`；`parent_revision_id` 使用 `(workflow_id, parent_revision_id) → trunk_revisions(workflow_id, id)` 复合外键，禁止跨 Workflow revision 链；索引：`(workflow_id, created_at desc)`。

### `branch_anchors`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | FK → workflows.id, ON DELETE CASCADE |
| `source_kind` | text | CHECK in `trunk_revision, message, artifact` |
| `context_trunk_revision_id` | uuid | NOT NULL；与 workflow_id 组成复合 FK → trunk_revisions |
| `source_trunk_revision_id` | uuid | nullable；复合 FK → trunk_revisions(workflow_id,id) |
| `source_message_id` | uuid | nullable；复合 FK → messages(workflow_id,id)，延迟添加 |
| `source_artifact_id` | uuid | nullable；复合 FK → artifacts(workflow_id,id)，延迟添加 |
| `selector` | jsonb | NOT NULL；text quote/region/node selector |
| `quote` | text | nullable |
| `created_by_account_id` | uuid | FK → accounts.id, NOT NULL |
| `created_at` | timestamptz | NOT NULL |

约束：unique `(workflow_id,id)`；`source_kind` 与三个 source FK 必须严格一一对应，使用 `num_nonnulls(...) = 1` 加 kind-specific CHECK，不能只由服务层判断。索引：`branch_anchors(workflow_id, source_kind)` 以及三个 source partial index。

分阶段迁移：S1 CHECK 只允许 `trunk_revision,message`，`source_artifact_id` 为保留空列；S4 创建 Artifact/ArtifactRevision 后，在同一 migration 添加复合 FK 并开放 `artifact`。因此 S1 不会产生无法验证 lineage 的 Artifact anchor。

### `sessions`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | FK → workflows.id, ON DELETE CASCADE |
| `agent_binding_id` | uuid | FK → agent_bindings.id, NOT NULL |
| `parent_session_id` | uuid | self FK, nullable |
| `fork_anchor_id` | uuid | FK → branch_anchors.id, nullable |
| `status` | session_status | NOT NULL |
| `transcript_version` | integer | NOT NULL default 0 |
| `created_by_account_id` | uuid | FK → accounts.id, NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |
| `closed_at` | timestamptz | nullable |

约束和索引：

- CHECK：mainline Session 没有 `parent_session_id/fork_anchor_id`；从 Trunk Anchor 创建的 Session 没有 parent 但有 anchor；从 Message fork 的 Session 同时具有 parent 和 anchor；
- unique：`(workflow_id,id)`、`(id,agent_binding_id)`；
- 复合 FK：`(workflow_id,parent_session_id) → sessions(workflow_id,id)` 与 `(workflow_id,fork_anchor_id) → branch_anchors(workflow_id,id)`，禁止跨 Workflow parent/anchor；
- 延迟授权触发器：`created_by_account_id` 必须是 Workflow 所属 Workspace 的 runner/editor/owner，且对 AgentBinding 所属 Agent 有 owner 或有效 AgentAccessGrant；
- index：`sessions(workflow_id, updated_at desc)`；
- index：`sessions(agent_binding_id, status)`。

### `session_runtime_refs`

Runtime reference 独立成表，允许 Session 保留重建、旋转或迁移产生的历史 Binding/ref。当前 Session 的 active primary ref 必须匹配 `sessions.agent_binding_id`；正式切换 Agent/Runtime 执行语义时创建或 fork 新 Session，不在原 Session 中静默换绑：

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `session_id` | uuid | FK → sessions.id, ON DELETE CASCADE |
| `agent_binding_id` | uuid | FK → agent_bindings.id, NOT NULL |
| `external_session_ref` | text | NOT NULL |
| `is_primary` | boolean | NOT NULL default true |
| `status` | text | CHECK in `active, historical, error` |
| `sync_cursor` | jsonb | NOT NULL default `{}` |
| `metadata` | jsonb | NOT NULL default `{}` |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

约束：unique `(agent_binding_id, external_session_ref)`；复合 FK `(session_id,agent_binding_id) → sessions(id,agent_binding_id)`，保证 active/historical ref 都属于 Session 的绑定；每个 Session 最多一个 `is_primary = true AND status = active` 的 ref；索引 `(session_id, status)`。

### `session_nodes`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | FK → workflows.id, ON DELETE CASCADE |
| `session_id` | uuid | NOT NULL；与 workflow_id 组成复合 FK → sessions(workflow_id,id) |
| `title` | text | NOT NULL |
| `node_kind` | text | CHECK in `mainline, branch, review` |
| `growth_state` | growth_state | NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

约束：unique `(workflow_id,id)`、unique `(session_id)`、unique `(workflow_id,session_id)`。Workflow 一致性由复合外键强制，不依赖服务层约定。

### `session_edges`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | FK → workflows.id, ON DELETE CASCADE |
| `source_session_node_id` | uuid | nullable；与 workflow_id 组成复合 FK → session_nodes；Trunk Anchor 生长的首层枝允许为空 |
| `target_session_node_id` | uuid | NOT NULL；与 workflow_id 组成复合 FK → session_nodes |
| `kind` | session_edge_kind | NOT NULL |
| `anchor_id` | uuid | FK → branch_anchors.id, nullable |
| `metadata` | jsonb | NOT NULL default `{}` |
| `created_at` | timestamptz | NOT NULL |

约束：

- unique partial：source 非空时 `(source_session_node_id, target_session_node_id, kind)`；
- CHECK：source 为空或 source != target；
- CHECK：`kind = derives` 时 anchor_id NOT NULL，其它 kind 时 anchor_id NULL；
- 复合 FK：`(workflow_id,anchor_id) → branch_anchors(workflow_id,id)`；
- index：`session_edges(workflow_id, source_session_node_id)` 和 `(workflow_id, target_session_node_id)`；
- 每个 target SessionNode 最多一条 birth `derives` 边；source 非空的 derives 子图无环，由事务内 recursive CTE 校验。

延迟一致性触发器在提交时把重复 lineage 表达锁成同一个事实：对于 derives Edge，target Node 对应 Session 的 `fork_anchor_id = edge.anchor_id`；source 非空时 target Session 的 `parent_session_id = source Node.session_id`，且 Message anchor 的 source Message 属于该父 Session；source 为空时 target Session parent 必须为空且 Anchor 必须来自 TrunkRevision。任何不一致整笔事务失败，不能让 Session parent/anchor 与图边各说各话。

### `canvas_node_layouts`

布局与领域拓扑分离：

| 列 | 类型 | 约束 |
|---|---|---|
| `workspace_id` | uuid | FK → workspaces.id |
| `workflow_id` | uuid | FK → workflows.id |
| `account_id` | uuid | FK → accounts.id |
| `session_node_id` | uuid | FK → session_nodes.id |
| `x` / `y` | double precision | NOT NULL |
| `pinned` | boolean | NOT NULL default false |
| `updated_at` | timestamptz | NOT NULL |

主键：`(account_id, session_node_id)`。`(workflow_id,session_node_id)` 使用复合 FK 指向 SessionNode；`workspace_id/workflow_id` 也用复合关系或约束触发器保证 Workflow 属于该 Workspace。视窗 pan/zoom 另存 `canvas_viewports(account_id, workflow_id, x, y, zoom)`。

## 5. Session、Run 与事件表

### `model_catalog_entries`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `runtime_kind` | runtime_kind | NOT NULL |
| `provider_key` | text | NOT NULL |
| `model_key` | text | NOT NULL |
| `display_name` | text | NOT NULL |
| `capabilities` | jsonb | NOT NULL default `{}` |
| `availability` | text | CHECK in `available, degraded, disabled` |
| `discovery_source` | text | NOT NULL |
| `observed_at` | timestamptz | NOT NULL |

唯一：`(runtime_kind, provider_key, model_key)`。

### `session_config_revisions`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `session_id` | uuid | FK → sessions.id, ON DELETE CASCADE |
| `version` | integer | NOT NULL, CHECK > 0 |
| `model_entry_id` | uuid | nullable FK → model_catalog_entries.id |
| `instructions_overlay` | text | nullable |
| `tool_policy` | jsonb | NOT NULL default `{}` |
| `context_policy` | jsonb | NOT NULL default `{}` |
| `created_by_account_id` | uuid | FK → accounts.id, NOT NULL |
| `created_at` | timestamptz | NOT NULL |

唯一：`(session_id, version)`、`(session_id,id)`。

### `messages`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | NOT NULL；与 session_id 组成复合 FK → sessions(workflow_id,id) |
| `session_id` | uuid | FK → sessions.id, ON DELETE CASCADE |
| `run_id` | uuid | nullable，延迟 FK → runs.id |
| `ordinal` | bigint | NOT NULL, CHECK >= 0 |
| `role` | message_role | NOT NULL |
| `actor_account_id` | uuid | nullable FK → accounts.id |
| `actor_agent_id` | uuid | nullable FK → agents.id |
| `content` | jsonb | NOT NULL |
| `status` | text | CHECK in `partial, completed, failed` |
| `external_message_ref` | text | nullable |
| `source_runtime_event_key` | text | nullable；只用于 Runtime 完成消息投影 |
| `created_at` | timestamptz | NOT NULL |

唯一：`(session_id, ordinal)`、`(session_id,id)`、`(workflow_id,id)`；partial unique：`(run_id,source_runtime_event_key)` where source key is not null，保证同一 `message.completed` 重放不会重复投影；可空 `(session_id,run_id) → runs(session_id,id)` 延迟复合 FK，禁止 Message 指向其它 Session 的 Run；CHECK：user 只允许 actor_account，assistant 只允许 actor_agent，`source_runtime_event_key` 非空时 run_id 必须非空；索引：`messages(session_id, created_at)`。

### `runs`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `session_id` | uuid | FK → sessions.id, ON DELETE CASCADE |
| `agent_binding_id` | uuid | FK → agent_bindings.id, NOT NULL |
| `config_revision_id` | uuid | FK → session_config_revisions.id, NOT NULL |
| `trigger_message_id` | uuid | FK → messages.id, NOT NULL |
| `idempotency_key` | text | NOT NULL |
| `status` | run_status | NOT NULL |
| `runtime_run_ref` | text | nullable |
| `model_snapshot` | jsonb | NOT NULL |
| `tool_policy_snapshot` | jsonb | NOT NULL |
| `context_policy_snapshot` | jsonb | NOT NULL |
| `error_code` / `error_message` | text | nullable |
| `started_at` / `completed_at` | timestamptz | nullable |
| `created_at` | timestamptz | NOT NULL |

约束：unique `(session_id, idempotency_key)`、`(session_id,id)`；`(session_id,agent_binding_id) → sessions(id,agent_binding_id)`、`(session_id,config_revision_id) → session_config_revisions(session_id,id)`、`(session_id,trigger_message_id) → messages(session_id,id)`，保证实际 Binding、配置和触发消息属于同一 Session。partial unique：一个 Session 最多一个 status in `queued,running,waiting_approval,reconciling` 的非并行 Run；索引：`runs(session_id, created_at desc)`。

### `run_events`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `run_id` | uuid | FK → runs.id, ON DELETE CASCADE |
| `sequence` | bigint | NOT NULL, CHECK >= 0 |
| `event_type` | text | NOT NULL |
| `payload` | jsonb | NOT NULL |
| `external_event_ref` | text | nullable |
| `runtime_event_key` | text | NOT NULL；Adapter 提供的稳定事件身份，不得使用内容 hash 充当唯一性 |
| `occurred_at` | timestamptz | NOT NULL |
| `ingested_at` | timestamptz | NOT NULL |

唯一：`(run_id, sequence)`、`(run_id,runtime_event_key)`；partial unique：`(run_id, external_event_ref)` where external ref is not null；索引：`run_events(run_id, sequence)`。

### `tool_grants`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `account_id` | uuid | FK → accounts.id, NOT NULL；授权所属租户/主体 |
| `scope` | tool_grant_scope | NOT NULL |
| `agent_id` | uuid | nullable FK → agents.id |
| `workflow_id` | uuid | nullable FK → workflows.id |
| `session_id` | uuid | nullable FK → sessions.id |
| `run_id` | uuid | nullable FK → runs.id |
| `tool_key` | text | NOT NULL |
| `effect` | tool_grant_effect | NOT NULL |
| `constraints` | jsonb | NOT NULL default `{}` |
| `expires_at` | timestamptz | nullable |
| `revoked_at` | timestamptz | nullable |
| `issued_by_account_id` | uuid | FK → accounts.id, NOT NULL |
| `source_approval_id` | uuid | nullable，延迟 FK → tool_approval_decisions.id |
| `created_at` | timestamptz | NOT NULL |

CHECK 按 `scope` 精确限定列：account 不填其它 scope FK；agent 只填 agent；workflow 填 workflow；session 填 workflow+session；run 填 workflow+session+run。Session/Run 通过复合 FK 保证层级一致。只读取 `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` 的规则；任何适用 deny 覆盖 allow，再选择最具体的 require-approval/allow。

### `tool_approval_decisions`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `run_id` | uuid | FK → runs.id, NOT NULL |
| `tool_call_ref` | text | NOT NULL |
| `approval_ref` | text | NOT NULL |
| `reviewer_account_id` | uuid | FK → accounts.id, NOT NULL |
| `decision` | text | CHECK in `allow_once, allow_session, deny` |
| `created_grant_id` | uuid | nullable FK → tool_grants.id |
| `created_at` | timestamptz | NOT NULL |

唯一：`(run_id, approval_ref)`。`allow_session` 可在同一事务创建 Session-scope ToolGrant；`allow_once` 不创建长期 Grant。

### `context_refs`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `account_id` | uuid | FK → accounts.id, NOT NULL |
| `agent_id` | uuid | nullable FK → agents.id |
| `workflow_id` | uuid | nullable FK → workflows.id |
| `session_id` | uuid | nullable FK → sessions.id |
| `run_id` | uuid | nullable FK → runs.id |
| `scope` | context_scope | NOT NULL |
| `visibility` | context_visibility | NOT NULL |
| `source_kind` | text | NOT NULL |
| `source_ref` | text | NOT NULL |
| `snapshot` | jsonb | nullable |
| `provenance` | jsonb | NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `expires_at` | timestamptz | nullable |

ContextRef 只保存获准的引用/摘要；`source_ref` 指向 Hermes 私有记忆时不得把原文放入 workspace 可见 snapshot。

CHECK 按 `scope` 精确限定：account 不填 agent/workflow/session/run；agent 只填 agent；workflow 填 workflow；session 填 workflow+session；run 填 workflow+session+run。复合 FK 保证 Session/Run 属于声明的 Workflow。`visibility = workspace` 只允许 workflow/session/run scope；account/agent 私有引用不能伪装成 Workspace snapshot。

### `command_receipts`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | FK → workflows.id, NOT NULL |
| `account_id` | uuid | FK → accounts.id, NOT NULL |
| `command_key` | text | NOT NULL |
| `command_type` | text | NOT NULL |
| `payload_hash` | text | NOT NULL |
| `orchestration_phase` | text | CHECK in `canvas_prepared,runtime_dispatched,runtime_known,attached,reconciling,retryable_failure,terminal_failure` |
| `external_resource_kind` / `external_resource_ref` | text | nullable；known 后同时设置 |
| `result_type` / `result_id` | text / uuid | nullable，完成后同时设置 |
| `result_payload` | jsonb | nullable；只保存稳定 Canvas ID/状态，不保存 secret |
| `last_error` | text | nullable，必须脱敏 |
| `created_at` / `completed_at` | timestamptz | completed nullable |

唯一：`(workflow_id, command_key)`。同 command key 但 payload hash 不同必须返回冲突，不能复用旧结果。`attached` receipt 的重试直接返回持久化结果，不再次调用 Runtime；`runtime_dispatched/runtime_known/reconciling` 的重试只进入 adopt/reconcile，不得再次发出创建副作用。phase 只能按数据库状态机前进；external ref 和 SessionRuntimeRef attach 必须在同一事务把 phase 置为 `attached`。

### `bootstrap_receipts`

Bootstrap 在 Account/Workflow 尚不存在时就需要并发幂等，因此不能借用强制 `workflow_id/account_id` 的业务命令收据。

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `auth_subject` | text | NOT NULL |
| `command_key` | text | NOT NULL |
| `payload_hash` | text | NOT NULL |
| `status` | text | CHECK in `pending,completed` |
| `account_id` / `agent_id` / `agent_binding_id` | uuid | nullable FK；完成后非空 |
| `workspace_id` / `workflow_id` | uuid | nullable FK；完成后非空 |
| `result_payload` | jsonb | nullable；稳定 Canvas ID 集合 |
| `created_at` / `completed_at` | timestamptz | completed nullable |

唯一：`(auth_subject,command_key)`。`bootstrapLocalAlpha` 在一个数据库事务内先插入该收据，再创建/加载整套默认资源并完成收据；并发相同 key 由唯一键串行化后读取同一结果。相同 key 但 payload hash 不同返回冲突。事务失败时 pending 行随事务回滚，不留下半套资源。

### `domain_events`

非 Run 事件与事务 outbox 共用一张 append-only ledger，避免把 `session.forked`、`proposal.applied` 等伪装成 RunEvent：

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `account_id` / `workspace_id` | uuid | FK，NOT NULL |
| `workflow_id` / `session_id` / `run_id` | uuid | nullable；按 aggregate 类型使用复合 FK |
| `aggregate_type` / `aggregate_id` | text / uuid | NOT NULL |
| `aggregate_sequence` | bigint | NOT NULL, CHECK > 0 |
| `event_type` / `event_version` | text / integer | NOT NULL |
| `payload` | jsonb | NOT NULL |
| `occurred_at` / `recorded_at` | timestamptz | NOT NULL |
| `published_at` | timestamptz | nullable |
| `publish_attempts` | integer | NOT NULL default 0 |

唯一：`(aggregate_type,aggregate_id,aggregate_sequence)`。表禁止 UPDATE/DELETE，只有 outbox 发布字段可由受限数据库函数更新。

### `runtime_compensations`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `command_receipt_id` | uuid | FK → command_receipts.id, NOT NULL |
| `agent_binding_id` | uuid | FK → agent_bindings.id, NOT NULL |
| `canvas_session_id` / `canvas_run_id` | uuid | nullable FK |
| `external_resource_kind` | text | NOT NULL |
| `external_resource_ref` | text | nullable；transport outcome unknown 时尚不可知 |
| `lookup_metadata` | jsonb | NOT NULL；至少含 commandId/canvasSessionId 或 canvasRunId |
| `dedupe_key` | text | NOT NULL；external ref 或 canonical lookup metadata 的稳定摘要 |
| `action` | text | CHECK in `adopt, destroy, reconcile` |
| `status` | text | CHECK in `pending, running, succeeded, failed` |
| `attempts` | integer | NOT NULL default 0 |
| `last_error` | text | nullable，必须脱敏 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

唯一：`(command_receipt_id,external_resource_kind,dedupe_key,action)`。控制面数据库提交失败但 Runtime 已创建资源时，必须先写入独立补偿 ledger，再允许返回；transport 结果未知且尚无 external ref 时，用 lookup metadata 对账，不能把 Session 标记 error 后盲目重试。对账只允许三种结果：唯一匹配则 adopt；证明不存在则把 receipt 退回可安全重试；多匹配或仍未知则保持 reconciling 并报警。

## 6. 产物与回流表

### `artifacts`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | FK → workflows.id, NOT NULL |
| `session_id` | uuid | FK → sessions.id, NOT NULL |
| `run_id` | uuid | nullable FK → runs.id；仅 `provenance_mode = legacy_import` 可空 |
| `provenance_mode` | text | CHECK in `run,legacy_import`, NOT NULL |
| `kind` | text | CHECK in `conclusion, document, code, image, task, rule, metabolism` |
| `status` | artifact_status | NOT NULL |
| `title` | text | NOT NULL |
| `current_revision_id` | uuid | nullable，创建首 revision 后设置延迟 FK |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

唯一：`(workflow_id,id)`；`(workflow_id,session_id)` 和 `(session_id,run_id)` 使用复合 FK 保证 provenance 不跨 Workflow/Session；CHECK 要求 `provenance_mode = run` 时 `run_id IS NOT NULL`，只有显式 legacy/import 适配器可写入 `legacy_import + NULL run_id`；该路径的首个 ArtifactRevision `provenance` 必须包含 importer 版本、来源引用与内容摘要，常规产物 API 不得伪造该模式。首个 revision 写入后添加 `(id,current_revision_id) → artifact_revisions(artifact_id,id)` 延迟复合 FK；索引：`artifacts(workflow_id, status, updated_at desc)`。

### `artifact_revisions`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `artifact_id` | uuid | FK → artifacts.id, ON DELETE CASCADE |
| `revision_number` | integer | NOT NULL, CHECK > 0 |
| `content` | jsonb | NOT NULL |
| `content_hash` | text | NOT NULL |
| `provenance` | jsonb | NOT NULL |
| `created_by_run_id` | uuid | nullable FK → runs.id |
| `created_at` | timestamptz | NOT NULL |

唯一：`(artifact_id,revision_number)`、`(artifact_id,id)`。Artifact 内容不可变；更新意味着追加 revision 并原子更新 `current_revision_id`。

### `proposals`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `workflow_id` | uuid | FK → workflows.id, NOT NULL |
| `artifact_id` | uuid | FK → artifacts.id, NOT NULL |
| `artifact_revision_id` | uuid | NOT NULL；与 artifact_id 组成复合 FK → artifact_revisions(artifact_id,id) |
| `base_trunk_revision_id` | uuid | FK → trunk_revisions.id, NOT NULL |
| `operation` | text | CHECK in `append, replace_range, create_linked_artifact` |
| `patch` | jsonb | NOT NULL |
| `status` | proposal_status | NOT NULL |
| `reviewed_by_account_id` | uuid | nullable FK → accounts.id |
| `applied_trunk_revision_id` | uuid | nullable FK → trunk_revisions.id |
| `created_at` / `reviewed_at` | timestamptz | reviewed_at nullable |

索引：`proposals(workflow_id, status, created_at)`。

复合 FK 同时约束 `(workflow_id,artifact_id)`、`(artifact_id,artifact_revision_id)`、`(workflow_id,base_trunk_revision_id)` 和可空的 `(workflow_id,applied_trunk_revision_id)`，禁止把其它 Workflow 的 Artifact/revision 应用到当前主干。

## 7. 关键事务

### 创建分枝 Session

同一事务写入：Anchor、Session(provisioning)、SessionNode、derives Edge、初始 SessionConfigRevision、`domain_events(session.forked)`。Runtime 创建在事务外执行；成功后写 external ref 并激活。若 Runtime 已成功而 Canvas attach 失败，必须把 external ref 写入 `runtime_compensations`；不得只记录内存日志。

### 开始 Run

同一事务验证成员权限、Session 状态和 active Run，写用户 Message、Run(queued) 和 `run.accepted`。调用 Runtime 后，每个规范事件只能通过一个 `ingestRuntimeEvent` 事务进入：锁 Run、按 `(run_id,runtime_event_key)` 去重、分配 sequence、插入 RunEvent；若是 `message.completed`，用同一 key 幂等写 Message 投影；若是终态，用条件更新推进 Run；然后一次提交。任何一步失败都整体回滚，重放同一事件可恢复完整投影。命令结果未知时转 `reconciling` 并继续占用 active 槽位，迟到事件不得复活终态 Run。

### 接受 Proposal

锁定 Workflow 行，比较 `current_trunk_revision_id == base_trunk_revision_id`；一致时创建新 TrunkRevision、更新 Workflow 指针、接受 Artifact/Proposal 并写审计事件。不一致时只将 Proposal 标为 stale。

## 8. Drizzle 文件拆分

```text
packages/db/src/schema/
├── enums.ts
├── identity.ts
├── workflows.ts
├── execution.ts
├── authorization.ts
├── audit.ts
├── outcomes.ts
├── relations.ts
└── index.ts
packages/db/src/repositories/
├── agent-repository.ts
├── workflow-repository.ts
├── session-repository.ts
├── run-repository.ts
└── proposal-repository.ts
```

现有 `packages/db/src/schema.ts` 只做兼容导出，避免后续把全部表继续堆入单文件。

## 9. WorkspaceState v1 迁移

迁移作业使用 `legacy_imports(account_id, source_key, source_version, imported_at, mapping jsonb)` 保存幂等映射。`source_key` 使用 localStorage 导出内容的稳定 hash，唯一约束 `(account_id, source_key)`。

步骤：

1. 创建 Workspace、Workflow 和首个 TrunkRevision；
2. 逐个 TextAnchor 创建 BranchAnchor；
3. 每个 Branch 创建一个 Session、SessionNode 和 derives Edge；
4. BranchMessage 按时间和稳定原数组顺序生成 Message ordinal；
5. ready Card 生成 Artifact/Proposal；integrated Card 同时关联对应 TrunkRevision；
6. 写入 legacy import mapping；
7. 重新执行时返回原 mapping，不重复写入；
8. 用户完成服务器校验前，不删除浏览器原数据。

## 10. 必测数据库约束

- Account 默认 Agent 不形成强 1:1；
- 默认/共享 Agent 必须有 owner 或有效 AgentAccessGrant，撤销后不可继续新建 Session；
- Runtime external session ref 只能在 Binding 内唯一；
- SessionNode 与 Session 一一对应；
- Parent、Anchor、Node、Edge、Config、Message、Run 和 Artifact 的复合 FK 拒绝跨 Workflow/Session 引用；
- derives Edge 必须有 Anchor 且不能形成环；
- fork Session 同时具有 parent 和 anchor；
- Message ordinal、Run idempotency key、RunEvent sequence 去重；
- 同一 Runtime event 的 RunEvent、completed Message 投影和 Run 终态原子提交；故障重放不产生半投影；
- 同一 Session 默认不允许两个 active Run；`reconciling` 仍算 active；
- Runtime event key 去重不依赖 delta 内容 hash；
- attached command receipt 重试不再次 dispatch；unknown external outcome 保持 reconciling；
- 同一 authSubject/commandKey 的并发 bootstrap 只产生一套默认资源；
- `session.forked` 等非 Run 事件进入 DomainEvent/outbox，孤儿 Runtime 资源进入补偿 ledger；
- Artifact revision 追加且 Proposal 固定引用一个 revision；
- deny ToolGrant 覆盖 allow；
- stale Proposal 不创建 TrunkRevision；
- WorkspaceState v1 重复导入不重复建数据；
- 删除 Workspace 后级联业务数据，但不删除 Account/Agent；
- 日志与 JSONB payload 不包含 `api_key`、`token`、`secret` 原值。

# Real Agent Product Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已确认的真实 Agent、账号隔离、可选记忆设计完整交付到真实画板 `/`，并通过 ZZH、NSY、管理员三套真实浏览器会话完成产品体验验收。

**Architecture:** PostgreSQL 继续作为 Canvas 控制面唯一事实源；Web 容器通过受权限保护的 Unix Socket 调用宿主 Runtime Worker，Worker 再连接 loopback Jarvis Gateway 或启动 profile-scoped Hermes ACP；服务端身份解析、Agent 授权、记忆策略和不可变 Run 快照位于 Runtime 之前；真实画板只消费安全产品 DTO，不接触 Binding、endpoint、secret、profile 或外部 Session ref。

**Tech Stack:** TypeScript 6.0.3、Node.js 24.18.0、Next.js 16.2.11、React 19.2.7、PostgreSQL 18、Drizzle ORM 0.45.2、Vitest 4.1.10、Playwright 1.61.1、Python/Hermes 现有 venv、aiohttp、ACP 0.9.0、Docker Compose、systemd --user。

---

## 0. 权威输入与交付边界

- 权威设计：
  `docs/superpowers/specs/2026-07-27-real-agent-memory-product-experience-design.md`
- 设计基线：
  `main` 必须包含 `54ae702164fac02d8ff58712c5b7410c0c9224e1`
  和本计划提交；实现从执行时的干净 `main` 创建。
- 产品入口：`/`
- 诊断入口：`/control-plane-test`
- 当前真实 Runtime：
  - Jarvis：`hermes-gateway.service`，loopback `127.0.0.1:8642`
  - 于途：`/home/youran/hermes-personal-assistants` 下 `zzh` profile
  - 乔晶晶：同一 home 下 `nsy` profile
- 当前部署：`ai-super-canvas.service` 通过 Docker Compose 启动 Web 和 PostgreSQL。
- 本次不实现管理后台；只实现以后可由管理后台调用的数据与服务边界。
- Fake Runtime 只能用于自动测试和显式开发，不能作为生产失败回退。
- 任一阶段完成都不能单独宣称“现在能用”；只有本计划最终产品验收全部通过才可以。

## 1. 为什么必须增加宿主 Runtime Worker

当前 Web 在纯 Node Docker 容器内：

- 容器的 `127.0.0.1` 不是宿主 Jarvis 的 `127.0.0.1`；
- Jarvis 只监听 loopback，不能从 Docker bridge 直接访问；
- Web 镜像没有 Hermes Python/ACP 环境；
- Web 容器没有、也不应该挂载 Jarvis API key、profile home 或原始 memory 文件。

因此采用以下固定边界：

```text
Web 容器
  -> /run/canvas-runtime/runtime-worker.sock
  -> ai-super-canvas-runtime-worker.service
       -> 127.0.0.1:8642（Jarvis）
       -> HERMES_HOME=.../profiles/zzh python -m hermes_cli.main acp（于途）
       -> HERMES_HOME=.../profiles/nsy python -m hermes_cli.main acp（乔晶晶）
```

约束：

- Worker 只监听 Unix Socket，不新增 TCP 监听。
- Socket 目录由 `systemd --user` 的 `RuntimeDirectory` 创建。
- Socket 为 `0660`，Web 容器只通过补充 GID 获得访问权。
- Worker 使用逻辑 `secretRef` 解析 Jarvis key；Web 容器和浏览器不持有 raw key。
- Worker 显式设置 personal-assistants home 和小写 profile；不依赖进程默认值。
- Worker 持久化命令/事件账本，Canvas 重启后可按游标恢复，未知结果仍 fail closed。
- 即使多个账号共享 Workflow/Jarvis grant，每个 Session 仍只属于创建账号；
  管理员不会自动看到 ZZH/NSY 的历史。

## 2. 子计划与严格执行顺序

| 顺序 | 子计划 | 交付闸门 |
| --- | --- | --- |
| 1 | `2026-07-27-real-agent-runtime-foundation.md` | Registry、Unix Socket Worker、Jarvis/ACP 真实适配、无 Fake 回退、可恢复事件 |
| 2 | `2026-07-27-device-identity-and-agent-access.md` | 设备配对、可信账号、三 Agent provisioning、服务端 Agent 授权 |
| 3 | `2026-07-27-agent-memory-policy.md` | 三种记忆、Agent × Workflow 隔离、Session 选择、写入提案、不可变快照 |
| 4 | `2026-07-27-real-canvas-product-experience.md` | `/` 的真实画板闭环、窄屏、重启、三账号/三 Agent 产品验收 |

四个子计划必须在同一功能分支按顺序执行。只有明确标为可并行的单元测试/组件任务可以并行；数据库 migration、公共 Runtime contract 和 Composition Root 不并行修改。

## 3. 工作区与分支

### Task 0: 创建隔离工作树并确认基线

**Files:**

- Verify only: repository root

- [ ] **Step 1: 确认主工作树没有未提交业务改动**

```bash
cd /home/youran/Development/AI-Super-Canvas
git status --short
git rev-parse HEAD
```

Expected:

- `git status --short` 为空；
- HEAD 是 `54ae702164fac02d8ff58712c5b7410c0c9224e1` 或包含该提交的更新后代。

- [ ] **Step 2: 创建实现工作树**

```bash
cd /home/youran/Development/AI-Super-Canvas
git worktree add \
  -b codex/real-agent-product-experience \
  .worktrees/real-agent-product-experience \
  main
cd .worktrees/real-agent-product-experience
git status --short --branch
```

Expected: 当前分支为 `codex/real-agent-product-experience`，工作树为空，
四份子计划均存在，且 `git merge-base --is-ancestor 54ae702 HEAD` 成功。

- [ ] **Step 3: 用仓库规定版本建立可重复测试环境**

```bash
node --version
corepack pnpm install --frozen-lockfile
docker build --target test \
  --tag ai-super-canvas:real-agent-baseline .
docker run --rm ai-super-canvas:real-agent-baseline \
  vitest run --passWithNoTests
```

Expected: host Node 和镜像 Node 均为允许的 24.x，工作树依赖安装完成，
现有单元/契约测试通过。

## 4. 阶段执行

### Task 1: 执行 Runtime Foundation 子计划

**Plan:** `docs/superpowers/plans/2026-07-27-real-agent-runtime-foundation.md`

- [ ] 逐项完成该计划全部 RED → GREEN → REFACTOR 步骤。
- [ ] 证明生产 Composition Root 不再构造单一 `DeterministicFakeRuntime`。
- [ ] 证明 Worker Socket 未新增 TCP listener。
- [ ] 证明 Jarvis、`zzh`、`nsy` 的 Runtime descriptor 与实际协议一致。
- [ ] 证明运行中的 Jarvis 已加载审核 worktree，Gateway 可回滚，且 Worker
  停止不会连带停止 Canvas。
- [ ] 证明明确失败不回退 Fake，未知结果进入 reconciling。
- [ ] 保存该子计划要求的测试输出和提交。

### Task 2: 执行 Device Identity and Agent Access 子计划

**Plan:** `docs/superpowers/plans/2026-07-27-device-identity-and-agent-access.md`

- [ ] 逐项完成该计划全部 RED → GREEN → REFACTOR 步骤。
- [ ] 证明浏览器不能通过 account/header/body 冒充身份。
- [ ] 证明 ZZH、NSY、管理员获得互相隔离的 Host-only HttpOnly Cookie。
- [ ] 证明创建 Session 只接收 `agentId`，Binding 由服务端事务内选择。
- [ ] 证明可见 Agent 分别为 `Jarvis+于途`、`Jarvis+乔晶晶`、三个 Agent。
- [ ] 证明三个 Binding 经 live probe 后原子激活；离线但仍授权的 Agent
  留在列表中，而不是消失。
- [ ] 证明共享 Jarvis/Workspace 不会让账号读取彼此 Session。
- [ ] 保存该子计划要求的测试输出和提交。

### Task 3: 执行 Agent Memory Policy 子计划

**Plan:** `docs/superpowers/plans/2026-07-27-agent-memory-policy.md`

- [ ] 逐项完成该计划全部 RED → GREEN → REFACTOR 步骤。
- [ ] 证明 `session_only` 不读取 Hermes 长期记忆。
- [ ] 证明 `agent_project` 只读取当前 Agent × Workflow。
- [ ] 证明 `agent_global` 只读取当前 Agent 的长期记忆和获准 Canvas 上下文。
- [ ] 证明被取消选择的历史 Session 不进入下一次 Run。
- [ ] 证明策略收窄会轮换 external Runtime Session，只重放 Canvas 历史。
- [ ] 证明记忆写入先生成 Canvas 提案，批准前不产生长期 ContextRef。
- [ ] 证明版本化 live handshake 通过前能力保持 unsupported，通过后才原子启用。
- [ ] 保存该子计划要求的测试输出和提交。

### Task 4: 执行 Real Canvas Product Experience 子计划

**Plan:** `docs/superpowers/plans/2026-07-27-real-canvas-product-experience.md`

- [ ] 逐项完成该计划全部 RED → GREEN → REFACTOR 步骤。
- [ ] `/` 从 PostgreSQL hydration 恢复，不再以 Demo localStorage 为事实源。
- [ ] 新账号从空画板经“新建对话”创建并 attach 第一条真实 Session。
- [ ] 节点面板显示 Agent、状态、记忆、历史 Session 和写入策略。
- [ ] 模型选择只在 Runtime 真正支持时显示。
- [ ] 已 attach 后切换 Agent 生成新 SessionNode，旧节点保持只读可追溯。
- [ ] 390×844 下使用底部抽屉完成完整旅程。
- [ ] `CANVAS_REAL_RUNS_ENABLED=0` 在任何 Message/Run/Runtime 副作用前
  fail closed，同时 `/` 与历史仍可读。
- [ ] 保存该子计划要求的测试输出和提交。

## 5. 唯一执行权威与最终核验

### Task 5: 锁死执行边界，避免重复部署

Task 1 到 Task 4 按顺序完整执行四份子计划，各步骤只执行一次。最终真实构建、`0011 -> 0012` 迁移、3000 持久产品验收、3100 隔离矩阵、运维文档和证据提交，唯一以 Real Canvas Product Experience 子计划 Task 11 到 Task 13 为执行权威。

本总计划从这里开始只做只读汇总核验，不再重新 build、迁移、seed、配对、创建 Session/Run、重启或部署。若最终证据后任何 Runtime-affecting 文件变化，现有 release manifest 立即失效，回到对应子计划生成新 SHA、镜像和整套证据，不能在这里补跑局部命令。

### Task 6: 对最终证据和当前运行态做只读审计

**Files:** none

- [ ] **Step 1: 验证机器可读 release manifest**

```bash
cd /home/youran/Development/AI-Super-Canvas/.worktrees/real-agent-product-experience
test -z "$(git status --short)"
MANIFEST=artifacts/acceptance/real-canvas/release-manifest.json
REPORT=docs/acceptance/2026-07-27-real-canvas-product-acceptance.md
test -s "$MANIFEST"
test -s "$REPORT"
jq -e ".releaseSha | type == \"string\" and length == 40" "$MANIFEST"
jq -e ".webImageId | startswith(\"sha256:\")" "$MANIFEST"
jq -e ".operatorImageId | startswith(\"sha256:\")" "$MANIFEST"
jq -e ".migration.phase == \"sealed\" and .migration.from == \"0011\" and .migration.to == \"0012\"" "$MANIFEST"
jq -e ".gates == {realRuntime:true,memoryPolicy:true,realRuns:true,fakeRuntime:false}" "$MANIFEST"
RELEASE_SHA="$(jq -r .releaseSha "$MANIFEST")"
git diff --quiet "$RELEASE_SHA"..HEAD -- \
  apps packages services deploy Dockerfile compose.yaml package.json pnpm-lock.yaml
```

Expected: manifest schema、最终 gate、迁移终态和 Runtime 路径一致；证据提交可以晚于 `RELEASE_SHA`，但 Runtime 代码不能漂移。

- [ ] **Step 2: 核对 live provenance，不触发任何产品写入**

```bash
systemctl --user is-active hermes-gateway.service
systemctl --user is-active ai-super-canvas-runtime-worker.service
systemctl --user is-active ai-super-canvas.service
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/ready
APP_CONTAINER="$(
  docker ps \
    --filter label=com.docker.compose.project=ai-super-canvas \
    --filter label=com.docker.compose.service=app \
    --format "{{.ID}}"
)"
test -n "$APP_CONTAINER"
test "$(docker inspect --format "{{.Image}}" "$APP_CONTAINER")" \
  = "$(jq -r .webImageId "$MANIFEST")"
test "$(docker image inspect --format "{{.Id}}" \
  "ai-super-canvas:real-agent-operator-$RELEASE_SHA")" \
  = "$(jq -r .operatorImageId "$MANIFEST")"
GATEWAY_MAIN_PID="$(
  systemctl --user show hermes-gateway.service -p MainPID --value
)"
test "$(git -C "/proc/$GATEWAY_MAIN_PID/cwd" rev-parse HEAD)" \
  = "$(jq -r .hermesReleaseSha "$MANIFEST")"
ss -ltnp
```

Expected: 3000 与 8642 的 listener、三项 service、Web image、operator image 和 Hermes revision 都与既有证据一致；Runtime Worker 仍只使用 Unix Socket。这里不得启动 operator、生成 pairing code 或发送消息。

- [ ] **Step 3: 核对真实产品体验证据与泄漏边界**

```bash
rg -q "http://127.0.0.1:3000/" "$REPORT"
rg -q "部署验收:" "$REPORT"
rg -q "127.0.0.1:3100" "$REPORT"
rg -q "Jarvis" "$REPORT"
rg -q "于途" "$REPORT"
rg -q "乔晶晶" "$REPORT"
rg -q "session_only" "$REPORT"
rg -q "agent_project" "$REPORT"
rg -q "agent_global" "$REPORT"
test -s artifacts/acceptance/real-canvas/zzh-desktop.png
test -s artifacts/acceptance/real-canvas/nsy-desktop.png
test -s artifacts/acceptance/real-canvas/admin-desktop.png
test -s artifacts/acceptance/real-canvas/mobile-normal.png
test -s artifacts/acceptance/real-canvas/mobile-recovery.png
if rg -n "API_SERVER_KEY=|Authorization: Bearer|Cookie:|pairingCode|externalSessionRef|externalRunRef" \
  "$REPORT" "$MANIFEST" artifacts/acceptance/real-canvas; then
  exit 1
fi
```

Expected: 报告证明持久 3000 上唯一有意的真实 Jarvis 产品 Run、隔离 3100 的三账号/三 Agent/三记忆矩阵、刷新/重启/故障恢复、桌面与 390×844 截图；`/control-plane-test` 只可作为明确排除项，不能充当验收入口。

### Task 7: 给用户一个不含糊的验收结论

只有 Task 6 全部通过且 Product Task 13 报告没有未解决阻断项，才可以回答“现在能用”。结论必须同时说明：

- 产品入口是 `/`，是空间画板，不是卡片列表或后台测试页；
- 默认 Jarvis；ZZH 可选 Jarvis/于途，NSY 可选 Jarvis/乔晶晶，管理员可选三者；
- Agent 之间记忆和 Session 严格隔离，同一 Agent 可选 `session_only`、`agent_project`、`agent_global` 和明确勾选的历史 Session；
- 当前持久 3000 已完成一条可见 Jarvis Run，完整空画板矩阵在同 revision 的 disposable 3100 上通过；
- 模型切换、Runtime 工具审批/停止和后台统一 Agent 配置仍不属于本版。

若任一 live provenance 或证据不一致，结论只能是“计划已完成，但产品当前未验收可用”，并回到对应子计划修复，不能用旧截图或旧报告兜底。

## 6. 回滚引用

真正的回滚步骤唯一以 Product 子计划的 Rollback procedure 为准。发生跨账号/跨 Agent 读取、错误 Runtime Session 复用、重复副作用、Fake fallback、secret 泄漏或 revision 漂移时，先用 `scripts/set-deployment-gates.sh` 原子恢复 `1,0,0,0`，再按该子计划验证历史只读、备份/迁移兼容和镜像恢复。不得直接手改两个 env、删除 PostgreSQL volume、清空 Canvas 历史或改写 Jarvis/zzh/nsy profile。

## 7. 完成定义

只有以下全部为真，本计划才完成：

- 四份子计划按顺序各执行一次，最终 build/deploy/acceptance 没有重复执行；
- `/` 完成真实空间画板产品旅程，且不是 `/control-plane-test`；
- Jarvis、于途、乔晶晶、三套账号授权与三种记忆全部通过真实隔离验收；
- Agent 切换、刷新、Canvas/Worker/Gateway 重启和未知结果恢复通过；
- 持久 3000 的最小真实 Run 与 disposable 3100 的完整矩阵均有同 revision 证据；
- Web/operator/Hermes/数据库迁移 provenance 和安全 release manifest 一致；
- 桌面、390×844 截图、测试计数、未测试边界和回滚条件齐全；
- `agent-architecture.md`、`service-ports.md`、`service-ports.json` 与 live listener 一致；
- Task 6 的只读最终审计全部通过。

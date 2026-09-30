# Device Identity and Agent Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可撤销的设备配对会话替换单一固定账号，并把 Jarvis、于途、乔晶晶按服务端授权安全地提供给 ZZH、NSY 和管理员。

**Architecture:** PostgreSQL 保存账号、配对码摘要、设备 Session 摘要、Agent grant 和一次性 seed receipt；浏览器只持有 Host-only HttpOnly Cookie；Route Handler 每次从可信 Resolver 获取 `ActorContext`；浏览器创建 Session 时只提交 `agentId`，Repository 在同一事务内完成授权和 primary Binding 选择。

**Tech Stack:** TypeScript 6.0.3、Node.js 24.18.0 `node:crypto`、Next.js 16.2.11、PostgreSQL 18、Drizzle ORM 0.45.2、Zod、Vitest 4.1.10、Playwright 1.61.1。

---

## Global constraints

- 在 Runtime Foundation 的 migration `0009` 和全部门禁通过后执行。
- 本计划使用 migration `0010_device_identity_agent_access`。
- 管理员平台角色不绕过 Agent grant；管理员看到三个 Agent，是因为有三条显式 grant。
- 配对码和设备 token 只在进程内短暂出现，数据库只保存 SHA-256 hex。
- 任何日志、错误、JSON DTO 和审计 metadata 都不得包含 raw code/token、Cookie、`secretRef`、`endpointRef`、`externalAgentRef`、`isolationKey` 或 `agentBindingId`。
- 当前产品只监听 loopback HTTP，因此 Cookie 暂不设置 `Secure`；`CANVAS_COOKIE_SECURE=1` 时强制 `Secure`，未来开放 TLS 前必须开启。
- `/api/control-plane/bootstrap` 只能保留为 `NODE_ENV=test` 的测试入口；生产请求必须返回 404。
- Seed 只负责第一次建立稳定对象，不能在后续启动时恢复已撤销 grant、覆盖名称或重设默认值。

## File map

### Database identity and sessions

- Modify: `packages/db/src/schema/identity.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/schema/schema-constraints.integration.test.ts`
- Modify: `packages/db/src/testing/disposable-test-database.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Create: `packages/db/migrations/0010_device_identity_agent_access.sql`
- Create: `packages/db/migrations/meta/0010_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

### Account session and provisioning services

- Create: `packages/control-plane/src/account-session-types.ts`
- Create: `packages/control-plane/src/account-session-service.ts`
- Create: `packages/control-plane/src/account-session-service.test.ts`
- Create: `packages/control-plane/src/local-product-provisioner.ts`
- Create: `packages/control-plane/src/local-product-provisioner.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Modify: `packages/control-plane/src/index.ts`

### Web authentication and API

- Create: `apps/web/src/server/authenticated-account.ts`
- Create: `apps/web/src/server/authenticated-account.test.ts`
- Create: `apps/web/src/app/api/auth/pair/handlers.ts`
- Create: `apps/web/src/app/api/auth/pair/route.ts`
- Create: `apps/web/src/app/api/auth/pair/route-contract.test.ts`
- Create: `apps/web/src/app/api/auth/session/handlers.ts`
- Create: `apps/web/src/app/api/auth/session/route.ts`
- Create: `apps/web/src/app/api/auth/session/route-contract.test.ts`
- Create: `apps/web/src/app/pair/page.tsx`
- Create: `apps/web/src/app/pair/pair-form.tsx`
- Create: `apps/web/src/app/api/control-plane/agents/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`
- Modify: `apps/web/src/app/api/control-plane/bootstrap/route.ts`
- Modify: `apps/web/src/app/api/control-plane/sessions/route.ts`
- Modify: `apps/web/src/app/api/control-plane/sessions/[sessionId]/runs/route.ts`
- Modify:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/transcript/route.ts`
- Modify: `apps/web/src/app/api/control-plane/runs/[runId]/events/route.ts`
- Modify: `apps/web/src/server/control-plane.ts`
- Modify: `apps/web/src/server/control-plane.test.ts`

### Operator command and configuration

- Create: `packages/control-plane/src/local-operator-account-session.ts`
- Create: `packages/control-plane/src/local-operator-account-session.test.ts`
- Create: `packages/db/src/database-url.ts`
- Modify: `packages/db/src/index.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Create: `scripts/account-session-admin.ts`
- Create: `scripts/acceptance-operator-server.ts`
- Create: `scripts/acceptance-operator-client.ts`
- Create: `scripts/acceptance-operator-channel.test.ts`
- Modify: `tsconfig.operator.json`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `Dockerfile`

---

### Task 1: Add platform role, pairing code, device session, and seed receipt schema

**Files:**

- Modify: `packages/db/src/schema/identity.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/schema/schema-constraints.integration.test.ts`
- Modify: `packages/db/src/testing/disposable-test-database.ts`
- Create: `packages/db/migrations/0010_device_identity_agent_access.sql`
- Create: `packages/db/migrations/meta/0010_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Write RED schema contract tests**

Assert the following exact database model:

```ts
accounts.platformRole: 'member' | 'admin'
agents.agentType: 'family' | 'personal'

accountPairingCodes = {
  id,
  accountId,
  codeHash,
  expiresAt,
  createdAt,
  createdByKind,       // 'account' | 'local_operator'
  createdByAccountId,  // nullable only for local_operator
  consumedAt,
  revokedAt,
  revokedByKind,
  revokedByAccountId,
}

accountSessions = {
  id,
  accountId,
  pairingCodeId,
  tokenHash,
  expiresAt,
  createdAt,
  revokedAt,
  revokedByKind,       // 'account' | 'local_operator', null until revoked
  revokedByAccountId,  // nullable for local_operator
}

systemSeedReceipts = {
  seedKey,
  version,
  payloadDigest,
  result,
  completedAt,
}
```

Tests must assert:

- `platform_role` defaults to `member` and only accepts `member|admin`;
- `agent_type` only accepts `family|personal`; existing pre-product rows migrate
  to `personal`, while provisioning explicitly sets Jarvis to `family`;
- `created_by_kind='account'` requires `created_by_account_id`; the
  `local_operator` path requires that column to be null and is available only
  to the local OS/DB-protected operator command;
- both hash columns match `^[0-9a-f]{64}$` and are unique;
- `account_sessions.pairing_code_id` is unique;
- `expires_at > created_at`;
- consumed/revoked timestamps cannot precede creation;
- pairing-code revocation audit follows the same Account/local-operator
  nullability rule as creation and Session revocation;
- revocation audit fields are all null while active; an Account revoker
  requires `revoked_by_account_id`, while `local_operator` requires it null;
- seed key is the primary key, version is positive, and `result` contains only
  safe Canvas Account/Agent/Workspace/Workflow IDs;
- reset/truncate helpers include all three new tables in foreign-key-safe order.

Run:

```bash
docker run --rm ai-super-canvas:runtime-worker-final \
  vitest run packages/db/src/schema/schema-contract.test.ts
```

Expected: FAIL because the columns and tables do not exist.

- [ ] **Step 2: Add Drizzle schema and generate migration**

Use `text` plus check constraints for platform role. Store all hashes as
lowercase 64-character hex. Use a host shell whose Node satisfies
`>=24.18.0 <25`; do not mount the worktree over a container's installed
`node_modules`. Generate:

```bash
node --version
DATABASE_URL=postgres://migration:unused@127.0.0.1:1/canvas_s1_test \
  corepack pnpm --filter @ai-super-canvas/db exec \
  drizzle-kit generate --name device_identity_agent_access
```

Expected:

- Node reports `v24.18.0` or another allowed 24.x version;
- migration number is exactly `0010`;
- no existing table or column is dropped;
- all new foreign keys and checks are present.

Build the identity schema tag before any later command first references it:

```bash
docker build --target test --tag ai-super-canvas:identity-schema .
docker image inspect ai-super-canvas:identity-schema >/dev/null
```

- [ ] **Step 3: Add real constraint tests and commit**

Cover expired timestamps, malformed hashes, duplicate pairing consumption and
invalid roles against disposable PostgreSQL.

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-identity-schema \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db/src/schema packages/db/src/testing packages/db/migrations
git commit -m "feat(db): add paired device identity"
```

Expected: schema and all database integration tests pass.

---

### Task 2: Define an atomic Account Session repository contract

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`

- [ ] **Step 1: Write RED integration tests for repository semantics**

Add tests for:

1. platform admin issues a code for an existing target Account;
2. member cannot issue a code;
3. exchange atomically marks the code consumed and inserts one Session;
4. two concurrent exchanges produce exactly one Session;
5. expired/revoked/consumed code is indistinguishably rejected;
6. resolving active token returns stored Account identity and role;
7. expired/revoked token is rejected;
8. revoking one Session leaves the Account's other Session active;
9. revoking all Account Sessions invalidates all of them;
10. local operator can revoke an unconsumed pairing code by safe ID, with
    honest audit origin; consumed/unknown code is indistinguishable;
11. no return value contains a raw credential.

Run:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-identity-repository \
  bash ./scripts/test-integration.sh
```

Expected: FAIL because the repository methods are missing.

- [ ] **Step 2: Add the minimal repository API**

Add neutral methods with already-hashed values:

```ts
issueAccountPairingCode(input: {
  issuer:
    | { kind: 'account'; actor: ActorContext }
    | { kind: 'local_operator'; operatorId: 'local-cli' };
  pairingCodeId: string;
  targetAccountId: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
}): Promise<void>;

exchangeAccountPairingCode(input: {
  codeHash: string;
  sessionId: string;
  tokenHash: string;
  now: string;
  expiresAt: string;
}): Promise<{ accountId: string; pairingCodeId: string }>;

resolveAccountSession(input: {
  tokenHash: string;
  now: string;
}): Promise<{
  sessionId: string;
  accountId: string;
  authSubject: string;
  displayName: string;
  platformRole: 'member' | 'admin';
  expiresAt: string;
} | null>;

revokeAccountSession(input: {
  tokenHash: string;
  now: string;
}): Promise<boolean>;

revokeAccountPairingCode(input: {
  issuer:
    | { kind: 'account'; actor: ActorContext }
    | { kind: 'local_operator'; operatorId: 'local-cli' };
  pairingCodeId: string;
  now: string;
}): Promise<boolean>;

revokeAllAccountSessions(input: {
  issuer:
    | { kind: 'account'; actor: ActorContext }
    | { kind: 'local_operator'; operatorId: 'local-cli' };
  targetAccountId: string;
  now: string;
}): Promise<number>;
```

Single-session revocation is self-revocation: the locked token row supplies the
Account audit identity. It never accepts a caller-supplied Account ID.
Pairing-code revocation only affects an unconsumed, unrevoked code; unknown,
already consumed or already revoked returns the same safe result and never
reveals account ownership. It records the real issuer union.

`exchangeAccountPairingCode` must use one transaction and a locked eligible
row. `issuer.kind='account'` requires a platform admin;
`issuer.kind='local_operator'` is only callable from the local CLI composition
root and stores an honest local-operator audit origin rather than impersonating
an Account. The same issuer union applies to revoke-all; local CLI revocation
records `local_operator`, while an Account issuer must be platform admin. Do
not distinguish unknown, expired, consumed, or revoked codes in the public
error.

- [ ] **Step 3: Run GREEN and commit**

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-identity-repository \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db/src/repositories
git commit -m "feat(db): persist revocable account sessions"
```

Expected: all repository integration tests pass, including the concurrent
exchange case.

---

### Task 3: Build AccountSessionService with injected clock and randomness

**Files:**

- Create: `packages/control-plane/src/account-session-types.ts`
- Create: `packages/control-plane/src/account-session-service.ts`
- Create: `packages/control-plane/src/account-session-service.test.ts`
- Modify: `packages/control-plane/src/index.ts`

- [ ] **Step 1: Write deterministic RED tests**

Inject:

```ts
interface AccountSessionClock {
  now(): Date;
}

interface CredentialGenerator {
  bytes(length: number): Uint8Array;
}
```

Test exact policies:

- pairing code: 16 random bytes, base64url, ten-minute expiry;
- device token: 32 random bytes, base64url, thirty-day expiry;
- SHA-256 lower hex reaches the Repository, raw values do not;
- account-issued `issuePairingCode()` requires a platform admin, while the
  separate `issueLocalOperatorPairingCode()` accepts only the fixed
  `local-cli` issuer injected by the CLI composition root;
- exchange returns raw token exactly once;
- public failures use `invalid_or_expired_pairing_code`;
- `resolveSessionToken()` returns `ActorContext` plus display name, role and
  expiry;
- error objects and logger arguments never contain raw credentials.

Run:

```bash
docker run --rm ai-super-canvas:identity-schema \
  vitest run packages/control-plane/src/account-session-service.test.ts
```

Expected: FAIL because the service is absent.

- [ ] **Step 2: Implement service and safe types**

Use `crypto.createHash('sha256')`, `crypto.randomBytes`, and base64url encoding.
Keep hashing in the service so the Repository never receives raw credentials.
Make the production clock/generator explicit constructor defaults and tests
fully injected.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:account-session .
docker run --rm ai-super-canvas:account-session \
  vitest run packages/control-plane/src/account-session-service.test.ts
git diff --check
git add packages/control-plane
git commit -m "feat(auth): add paired account sessions"
```

Expected: focused tests pass.

---

### Task 4: Replace fixed local identity with a trusted request resolver

**Files:**

- Create: `apps/web/src/server/authenticated-account.ts`
- Create: `apps/web/src/server/authenticated-account.test.ts`
- Modify: `apps/web/src/server/control-plane.ts`
- Modify: `apps/web/src/server/control-plane.test.ts`
- Modify: `apps/web/src/app/api/control-plane/sessions/route.ts`
- Modify: `apps/web/src/app/api/control-plane/sessions/[sessionId]/runs/route.ts`
- Modify:
  `apps/web/src/app/api/control-plane/sessions/[sessionId]/transcript/route.ts`
- Modify: `apps/web/src/app/api/control-plane/runs/[runId]/events/route.ts`

- [ ] **Step 1: Write RED resolver and route tests**

Use this result:

```ts
export interface AuthenticatedAccount {
  actor: ActorContext;
  displayName: string;
  platformRole: 'member' | 'admin';
  expiresAt: string;
}
```

Tests must prove:

- no `canvas_session` Cookie returns 401;
- unknown, expired and revoked tokens return the same 401 response;
- ZZH Cookie plus forged `X-Account-Id`, `X-Auth-Subject`, or admin header still
  resolves to ZZH;
- each existing Route passes its actual `Request` to the resolver;
- no route calls `getLocalActorContext()`;
- auth errors are `Cache-Control: no-store` and do not echo the token.

Run:

```bash
docker run --rm ai-super-canvas:account-session \
  vitest run \
  apps/web/src/server/authenticated-account.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
```

Expected: FAIL because all routes still use the fixed local Actor.

- [ ] **Step 2: Implement the Resolver and composition root**

Parse only the `canvas_session` Cookie. Hash its value and call
`AccountSessionService.resolveSessionToken()`. Reuse the singleton
PostgreSQL pool and Repository already owned by `getControlPlane()`; do not
open a per-request pool.

Remove production exports for `localAuthSubject`,
`resolveLocalActorContext`, and `getLocalActorContext`. Keep any fixed actor
helper inside tests only.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:trusted-identity .
docker run --rm ai-super-canvas:trusted-identity \
  vitest run \
  apps/web/src/server/authenticated-account.test.ts \
  apps/web/src/server/control-plane.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
git diff --check
git add apps/web/src/server apps/web/src/app/api/control-plane
git commit -m "refactor(web): resolve actors from device sessions"
```

Expected: focused tests pass and production source contains no fixed local
subject path.

---

### Task 5: Add the real `/pair` journey and Session revocation API

**Files:**

- Create: `apps/web/src/app/api/auth/pair/handlers.ts`
- Create: `apps/web/src/app/api/auth/pair/route.ts`
- Create: `apps/web/src/app/api/auth/pair/route-contract.test.ts`
- Create: `apps/web/src/app/api/auth/session/handlers.ts`
- Create: `apps/web/src/app/api/auth/session/route.ts`
- Create: `apps/web/src/app/api/auth/session/route-contract.test.ts`
- Create: `apps/web/src/app/pair/page.tsx`
- Create: `apps/web/src/app/pair/pair-form.tsx`

- [ ] **Step 1: Write RED API contract tests**

Contract:

```text
POST /api/auth/pair       body {"code":"..."} -> 204 + Set-Cookie
GET  /api/auth/session                         -> safe account summary
DELETE /api/auth/session                       -> 204 + expired Cookie
```

Assert:

- body schemas are strict;
- all writes pass the existing same-origin/content-type checks;
- Set-Cookie contains `canvas_session`, `HttpOnly`, `SameSite=Strict`,
  `Path=/`, `Max-Age`, and no `Domain`;
- `Secure` exactly follows `CANVAS_COOKIE_SECURE`;
- raw token never appears in body;
- GET omits `authSubject`, token hash, pairing code and internal IDs;
- DELETE revokes before clearing Cookie.

Run:

```bash
docker run --rm ai-super-canvas:trusted-identity \
  vitest run \
  apps/web/src/app/api/auth/pair/route-contract.test.ts \
  apps/web/src/app/api/auth/session/route-contract.test.ts
```

Expected: FAIL because the routes are absent.

- [ ] **Step 2: Implement `/pair` in ordinary user language**

The page has one labeled code input, submit button, inline validation, expiry
message, and success redirect to `/`. It must never render a development
account selector. Do not persist the code in localStorage or URL parameters.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:pair-page .
docker run --rm ai-super-canvas:pair-page \
  vitest run \
  apps/web/src/app/api/auth/pair/route-contract.test.ts \
  apps/web/src/app/api/auth/session/route-contract.test.ts
git diff --check
git add apps/web/src/app/api/auth apps/web/src/app/pair
git commit -m "feat(web): add device pairing journey"
```

Expected: all pairing route tests pass.

---

### Task 6: Provision three stable accounts and Agents exactly once

**Files:**

- Create: `packages/control-plane/src/local-product-provisioner.ts`
- Create: `packages/control-plane/src/local-product-provisioner.test.ts`
- Modify: `packages/control-plane/src/index.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`

- [ ] **Step 1: Write RED provisioning tests**

Use the stable seed key `local-real-agent-product-v1` and stable subjects:

| Subject | Display name | Platform role | Default Agent |
| --- | --- | --- | --- |
| `canvas:admin` | 管理员 | admin | Jarvis |
| `canvas:zzh` | ZZH | member | Jarvis |
| `canvas:nsy` | NSY | member | Jarvis |

Provision:

| Agent | Owner | Runtime kind | External ref | Isolation key | Endpoint ref | Secret ref |
| --- | --- | --- | --- | --- | --- | --- |
| Jarvis (`family`) | admin | hermes-gateway | `jarvis-local` | `gateway:jarvis-local` | `worker:jarvis` | `worker-secret:jarvis-api` |
| 于途 (`personal`) | ZZH | hermes-acp | `zzh` | `profile:zzh` | `worker:profile:zzh` | null |
| 乔晶晶 (`personal`) | NSY | hermes-acp | `nsy` | `profile:nsy` | `worker:profile:nsy` | null |

Grant matrix:

- ZZH: Jarvis `use`, 于途 `admin`;
- NSY: Jarvis `use`, 乔晶晶 `admin`;
- admin: all three `admin`.

Create one shared product Workspace and initial Workflow; admin is owner,
ZZH/NSY are editor. Tests must prove a second call is a no-op and, after an
admin revokes a grant or renames an Agent, a later call does not restore or
overwrite it.

Seed each Agent's default `memoryPolicy` as version 1,
`mode='agent_project'`, `writePolicy='confirm_each'`. The Memory Policy
subplan becomes the only parser/authorizer for that JSON before the product is
enabled.

Tests also prove the two-phase Binding activation:

1. stable objects and the three Bindings are inserted idempotently as
   `status='provisioning'`, `isPrimary=false`;
2. Registry routes by explicit kind and calls `describe`, `health` and
   `listModels` for each Binding through the Worker;
3. one transaction validates descriptor kind and atomically writes
   `runtimeVersion`, truthful capabilities, safe model catalog/default model,
   `status='ready'|'degraded'` and `isPrimary=true` for all three;
4. only after all three activations succeed is the seed receipt inserted.

A failed probe leaves the affected Binding `provisioning` or `error`, writes no
seed receipt and is safely resumable. It must never mark an unprobed Binding
ready.

The successful receipt also stores a generated non-secret
`databaseInstanceId` (UUID) and the exact PostgreSQL database name. The ID is
created once through injected randomness, returned unchanged on idempotent
seed, and never changes on restart. Tests prove a copied receipt payload from a
different disposable database or a caller-supplied instance ID is rejected.

Run:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-product-seed \
  bash ./scripts/test-integration.sh
```

Expected: FAIL because provisioning and receipt methods are missing.

- [ ] **Step 2: Implement resumable provisioning and atomic activation**

Resolve Agents by stable `(runtimeKind, isolationKey)`, never editable name.
The first transaction inserts stable DB objects and provisioning Bindings, then
commits before external probes. After all probes succeed, a second transaction
locks all three Bindings, verifies the probe inputs still match, activates all
three and inserts the receipt. Its `result` stores the safe created
Account/Agent/Binding/Workspace/Workflow IDs so the product projection can
locate the intended Workflow without matching editable names, plus the
server-generated `databaseInstanceId` and observed database name used by the
acceptance operator-channel binding.
If the receipt exists with a different version or payload digest, stop with an
operator-facing error; do not partially “repair” production state.

- [ ] **Step 3: Run GREEN and commit**

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-product-seed \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/control-plane packages/db/src/repositories
git commit -m "feat(control-plane): provision real local agents"
```

Expected: provisioning, idempotency and non-restoration tests pass.

---

### Task 7: Expose only the authorized Agent product DTO

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`
- Create: `apps/web/src/app/api/control-plane/agents/route.ts`
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`

- [ ] **Step 1: Write RED authorization and DTO tests**

The response shape is:

```ts
interface AuthorizedAgentListDto {
  effectiveDefaultAgentId: string | null;
  agents: Array<{
    agentId: string;
    name: string;
    type: 'family' | 'personal';
    accessRole: 'use' | 'admin';
    isDefault: boolean;
    availability: 'available' | 'degraded' | 'offline' | 'confirming';
    capabilities: {
      memoryModes: Array<'session_only' | 'agent_project' | 'agent_global'>;
      modelSelection: boolean;
    };
  }>;
}
```

Prove exact visible names:

- ZZH: Jarvis, 于途;
- NSY: Jarvis, 乔晶晶;
- admin: Jarvis, 于途, 乔晶晶.

`effectiveDefaultAgentId` equals the stored Account default only while that
Agent still has an active grant. If the default grant is revoked it becomes
null rather than pointing outside `agents` or silently selecting another
Agent; with zero grants, `agents=[]` and the default is null. `isDefault` is
true only for the effective default.

Assert serialized output does not contain:
`secretRef`, `endpointRef`, `externalAgentRef`, `isolationKey`,
`agentBindingId`, `runtimeKind`, `profile`, or filesystem paths.

Authorization and availability are separate: an active grant returns the Agent
even if its Binding is missing, disabled or unhealthy, with
`availability='offline'` and truthful empty/unsupported capabilities. Only
grant revocation removes it. Before the Memory Policy plan's final live
handshake, `memoryModes` is empty rather than optimistically listing modes.

- [ ] **Step 2: Implement `GET /api/control-plane/agents`**

Repository filters by active grant and Agent identity, then left-joins the
primary Binding instead of filtering it away. Service converts Binding/runtime
health into the four product states. A missing or disabled Binding remains
visible as offline, is not usable, and cannot be returned as `available`.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:authorized-agents .
docker run --rm ai-super-canvas:authorized-agents \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-authorized-agents \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db/src/repositories packages/control-plane apps/web/src/app/api/control-plane
git commit -m "feat(api): list authorized product agents"
```

Expected: unit, route and database authorization tests pass.

---

### Task 8: Make the server choose the Binding for Session creation

**Files:**

- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`

- [ ] **Step 1: Write RED anti-forgery tests**

Change the request contract to:

```ts
{
  commandId: UUID;
  workflowId: UUID;
  agentId: UUID;
  title: string;
}
```

Tests must prove:

- `agentBindingId`, account, auth subject, Runtime kind and endpoint are rejected
  as extra fields;
- Repository authorizes Workspace membership and Agent grant, locks the Agent,
  and selects its single primary `ready|degraded` Binding inside the creation
  transaction;
- a disabled Agent, revoked grant, missing Binding, or ambiguous Binding fails
  before any Runtime operation;
- selecting another account's personal Agent returns the same public 404 as an
  unknown Agent;
- receipt payload identity uses `agentId`, while the persisted Session contains
  the server-selected Binding.
- every created Session stores `createdByAccountId=actor.accountId`;
- ZZH and NSY can each create a Jarvis Session in the shared Workflow, but
  listing, hydration, transcript, events, config, context selection and Run
  endpoints for the other Account's Session return the same 404 as nonexistent;
- platform admin and a shared Jarvis grant do not bypass Session ownership;
- after an Agent grant is revoked, the Session creator may still read persisted
  history, but new Run, config, context and memory-decision operations fail
  before any write/Runtime call.

Run:

```bash
docker run --rm ai-super-canvas:authorized-agents \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-server-binding \
  bash ./scripts/test-integration.sh
```

Expected: FAIL while `agentBindingId` is still accepted.

- [ ] **Step 2: Replace Binding input end to end**

Rename `CreateRootSessionInput.agentBindingId` to `agentId` and update handler,
service, Repository, receipt hash inputs and tests in one commit. Do not expose
the chosen Binding in the HTTP response. Centralize
`authorizeOwnedSession(actor, sessionId, action)` and use it in all Session,
Run, transcript, event, context and product hydration paths; do not rely on
Workspace membership alone. v1 has no Session-sharing table, so creator
ownership is the only historical-read rule.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:server-binding .
docker run --rm ai-super-canvas:server-binding \
  vitest run \
  packages/control-plane/src/session-service.test.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-server-binding \
  bash ./scripts/test-integration.sh
git diff --check
git add packages/db packages/control-plane apps/web/src/app/api/control-plane
git commit -m "fix(auth): select agent bindings on the server"
```

Expected: all focused and database tests pass.

---

### Task 9: Add a safe operator command and remove production local auth

**Files:**

- Create: `packages/control-plane/src/local-operator-account-session.ts`
- Create: `packages/control-plane/src/local-operator-account-session.test.ts`
- Create: `scripts/account-session-admin.ts`
- Create: `scripts/acceptance-operator-server.ts`
- Create: `scripts/acceptance-operator-client.ts`
- Create: `scripts/acceptance-operator-channel.test.ts`
- Modify: `tsconfig.operator.json`
- Modify: `Dockerfile`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `apps/web/src/app/api/control-plane/bootstrap/route.ts`
- Modify: `apps/web/src/server/control-plane.test.ts`

- [ ] **Step 1: Write RED command and configuration tests**

The CLI supports only:

```bash
pnpm auth:seed
pnpm auth:pair -- --account canvas:zzh
pnpm auth:pair -- --account canvas:nsy
pnpm auth:pair -- --account canvas:admin
pnpm auth:revoke-code -- --pairing-code-id <uuid>
pnpm auth:revoke -- --account canvas:zzh --all
```

These package commands define the operator-image implementation and are used
directly only in disposable subprocess tests. A deployed database has no host
port: formal local operation is
`scripts/run-database-operation.sh --operation pair|revoke-code|revoke-sessions`
with exact release/operator image ID and `databaseInstanceId`. Interactive
pairing requires a real TTY and prints the one-use code once; automated
acceptance calls the same implementation through the private UDS and never
prints it.

Add subprocess tests with a disposable database proving:

- `auth:seed` applies the one-time seed and returns the receipt's safe
  `databaseInstanceId`; repeat calls return the same ID, never a caller value;
- interactive `auth:pair` prints exactly one raw code to its TTY;
  `--allow-non-tty` emits exactly one JSON object containing raw code, safe
  pairing-code ID and expiry to the caller's private stdout pipe, and nothing
  else writes that object to logs/stderr;
- the local command records `createdByKind='local_operator'` with
  `operatorId='local-cli'`; it never invents or impersonates an Account issuer;
- any remote/API attempt to claim `local_operator` fails;
- the local-operator issuance entry is not exported from the normal
  `packages/control-plane` public index and is absent from the production Web
  route bundle; only the repository-local CLI imports it through an explicit
  script-only export;
- `auth:revoke --all` revokes all active device Sessions;
- CLI revoke-all records `revokedByKind='local_operator'` and never fabricates
  an Account actor;
- `auth:revoke-code` revokes only an unconsumed code by safe ID and records the
  local operator issuer, enabling unconditional E2E cleanup;
- command errors do not print hashes or database URLs.

Assert production Compose no longer has `AUTH_MODE` or `APP_OWNER_SUBJECT`.
Assert production `POST /api/control-plane/bootstrap` returns 404.

- [ ] **Step 2: Implement with Node 24 type stripping**

Use `scripts/account-session-admin.ts` and execute it with:

```bash
node --experimental-strip-types scripts/account-session-admin.ts
```

Keep the CLI and its imported operator composition path compatible with
erasable TypeScript syntax and add a subprocess smoke test for every package
script; do not claim the workspace already emits runnable JS and do not add
`tsx`. `tsconfig.operator.json` enables `erasableSyntaxOnly` and
`allowImportingTsExtensions`, and includes the CLI plus its exact transitive
source import closure. Runtime imports in that closure use explicit `.ts`
extensions; type-only package imports are erased. In particular, refactor the
`PostgresControlPlaneRepository` constructor parameter properties into
ordinary declared fields and update its two local Repository imports, plus the
local import in `control-plane-run-types.ts`, to explicit `.ts` paths. This is
a syntax/import-only change with existing Repository tests as regression
coverage.

Extend the Runtime Foundation's dedicated `operator` Docker target to include
this CLI, the strict private-Socket acceptance operator server/client protocol
and their exact dependencies. Implement and test the channel here, before the
identity release is locked. Keep the target profile-only, unexposed and
separate from the production Web final stage; prove the Web image/route bundle
does not contain the account-session or acceptance operator entrypoints.

Move `requireDatabaseUrl` without behavior change to
`packages/db/src/database-url.ts`, re-export it from the normal DB index, and
have the CLI import that exact source file rather than evaluating the DB barrel.
The CLI imports the script-only local-operator module and
`PostgresControlPlaneRepository` by their exact source paths;
`packages/control-plane/src/index.ts` must not export the local operator.
Refuse to print a
pairing code when stdout is redirected unless `--allow-non-tty` is explicitly
supplied for controlled automation.

Run the exact runtime command—not only a Vitest import—during RED/GREEN:

```bash
corepack pnpm exec tsc -p tsconfig.operator.json
node --experimental-strip-types scripts/account-session-admin.ts --help
```

Every `pnpm auth:*` subprocess test invokes the same Node command. A module
resolution error, non-erasable TypeScript construct, missing build artifact or
implicit `tsx` dependency fails the task.

- [ ] **Step 3: Run GREEN and commit**

```bash
docker build --target test --tag ai-super-canvas:identity-final .
docker run --rm ai-super-canvas:identity-final test
docker run --rm ai-super-canvas:identity-final \
  vitest run scripts/acceptance-operator-channel.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-identity-final \
  bash ./scripts/test-integration.sh
git diff --check
git add \
  packages/control-plane/src/local-operator-account-session.ts \
  packages/control-plane/src/local-operator-account-session.test.ts \
  packages/db/src/database-url.ts \
  packages/db/src/index.ts \
  packages/db/src/repositories/postgres-control-plane-repository.ts \
  packages/db/src/repositories/control-plane-run-types.ts \
  scripts tsconfig.operator.json package.json .env.example compose.yaml Dockerfile \
  apps/web/src
git commit -m "chore(auth): operate paired product accounts"
```

Expected: full unit and database integration suites pass.

---

### Task 10: Prove three genuinely isolated browser identities

**Files:**

- Create: `tests/e2e/device-identity.real.spec.ts`
- Create: `playwright.identity.config.ts`
- Create: `compose.identity-acceptance.yaml`
- Create: `scripts/start-identity-e2e-stack.sh`
- Modify: `/home/youran/data/agent-architecture.md`
- Modify: `/home/youran/data/service-ports.md`
- Modify: `/home/youran/data/service-ports.json`

- [ ] **Step 1: Create three one-use codes**

Lock the clean identity Runtime source and build both images from an isolated
checkout before creating the remaining wrapper/Playwright files:

```bash
test -z "$(git status --short)"
IDENTITY_RELEASE_SHA="$(git rev-parse HEAD)"
test "${#IDENTITY_RELEASE_SHA}" -eq 40
bash scripts/install-runtime-release.sh \
  --sha "$IDENTITY_RELEASE_SHA" \
  --release-root /home/youran/.local/share/ai-super-canvas-identity-acceptance
IDENTITY_RELEASE_DIR="/home/youran/.local/share/ai-super-canvas-identity-acceptance/releases/$IDENTITY_RELEASE_SHA"
docker build \
  --build-arg APP_REVISION="$IDENTITY_RELEASE_SHA" \
  --label "org.opencontainers.image.revision=$IDENTITY_RELEASE_SHA" \
  --tag "ai-super-canvas:identity-product-$IDENTITY_RELEASE_SHA" \
  "$IDENTITY_RELEASE_DIR"
IDENTITY_IMAGE_ID="$(
  docker image inspect --format '{{.Id}}' \
    "ai-super-canvas:identity-product-$IDENTITY_RELEASE_SHA"
)"
test -n "$IDENTITY_IMAGE_ID"
docker build \
  --target operator \
  --build-arg APP_REVISION="$IDENTITY_RELEASE_SHA" \
  --label "org.opencontainers.image.revision=$IDENTITY_RELEASE_SHA" \
  --tag "ai-super-canvas:identity-operator-$IDENTITY_RELEASE_SHA" \
  "$IDENTITY_RELEASE_DIR"
IDENTITY_OPERATOR_IMAGE_ID="$(
  docker image inspect --format '{{.Id}}' \
    "ai-super-canvas:identity-operator-$IDENTITY_RELEASE_SHA"
)"
test -n "$IDENTITY_OPERATOR_IMAGE_ID"
HERMES_RELEASE_SHA="$(
  git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy rev-parse HEAD
)"
test "${#HERMES_RELEASE_SHA}" -eq 40
test -z "$(
  git -C /home/youran/.hermes/.worktrees/canvas-runtime-policy \
    status --short
)"
GATEWAY_MAIN_PID="$(
  systemctl --user show hermes-gateway.service -p MainPID --value
)"
test "$GATEWAY_MAIN_PID" -gt 1
test "$(readlink -f "/proc/$GATEWAY_MAIN_PID/cwd")" \
  = /home/youran/.hermes/.worktrees/canvas-runtime-policy
```

The separate release root cannot repoint the persistent Worker's `current`
symlink. Record `IDENTITY_RELEASE_SHA`, both immutable image IDs and
`HERMES_RELEASE_SHA` in the acceptance runner state; a resumed run repeats
this lock/build/live-process proof. The wrapper's authenticated Jarvis
capability probe and zzh/nsy ACP initialize metadata must equal the expected
Hermes revision; reading the currently running value without comparing it to
this independent lock is not evidence.

`scripts/start-identity-e2e-stack.sh` binds the disposable production image
only to `127.0.0.1:3100`, uses a nonce Compose project/fresh PostgreSQL plus an
acceptance-scoped Worker with private UDS/ledger from
`IDENTITY_RELEASE_SHA`, and records the exact image/Worker revision. It never
mounts the persistent Canvas database or persistent Worker Socket. Before it
starts, update both service-port
inventories together to mark 3100 as a non-boot, nonce-scoped identity
acceptance listener with its start/cleanup commands; after teardown record
listener-closed evidence. Read/update `agent-architecture.md` for the
Web→protected UDS→Jarvis/profile ACP path without recording secrets.

The wrapper requires `--expected-hermes-revision` and rejects inherited
feature-gate values. It supplies exactly
`CANVAS_REAL_RUNTIME_ENABLED=1`, `CANVAS_MEMORY_POLICY_ENABLED=0`,
`CANVAS_REAL_RUNS_ENABLED=1`, `CANVAS_FAKE_RUNTIME_ENABLED=0` to both
disposable Web and Worker, then asserts the same booleans plus both locked
revisions through health/readiness before creating a code or Session. It also
requires the operator tag and independently captured image ID; the running
one-shot/operator server container label, image ID and source revision must
match before any database or pairing action.

The wrapper never publishes PostgreSQL or exports `DATABASE_URL` to the host
Playwright child. `compose.identity-acceptance.yaml` starts the independently
ID-verified operator image on the nonce Compose private network, with no
published port and `--log-driver=none`. Only that container receives the nonce
DB URL. It first proves
the exact Compose labels, nonce database name and fresh empty/no-journal state,
runs the pinned migrator through exactly `0010`, then runs `auth:seed` to
create the random non-secret `databaseInstanceId` and verifies migration head,
journal and receipt. Only then does it start
`acceptance-operator-server.ts`, the acceptance Worker and Web; before that,
only PostgreSQL and the one-shot operator may run. An owner-only host directory is bind-mounted
only for its Unix Socket (`0700`, Socket `0600`). The wrapper removes any
inherited DB/operator/acceptance variables before the child and proves the
production Web image does not contain these operator entrypoints.

The strict one-request-per-connection channel accepts only
`seed_status`, `pair`, `record_command`, `record_native_marker`,
`revoke_code` and `revoke_sessions`; every request must carry the expected
`databaseInstanceId`, and the server rechecks the seed receipt in the same
transaction as the operator action. `record_command` appends only a UUID and
operation kind to the wrapper-owned manifest before browser dispatch; the
optional `record_native_marker` accepts only an exact allowlisted
test-fixture locator plus digest, never arbitrary content/path. The child never
writes the manifest directly. Audit receipts include the database
instance ID. A mismatch, missing seed receipt, non-nonce database name,
unknown field or inherited persistent database URL fails closed. The child
receives only `CANVAS_ACCEPTANCE_OPERATOR_SOCKET` and the safe instance ID.

Playwright uses `acceptance-operator-client.ts` to request one
`pair --allow-non-tty` operation per account. The server spawns the real CLI
with its private DB environment and piped stdout; only the requesting
Playwright parent receives the one JSON/code response in memory.
Do not expose these as copy/paste shell commands.
Do not place codes in environment variables, files, reporters, traces or test
attachments. The wrapper creates the shared durable manifest under its private
acceptance state directory with owner-only `0600` permissions and installs the
Foundation outer trap before starting the child. Cleanup changes the manifest
to `cleaning`; before deleting PostgreSQL it resolves only this manifest's
receipts to their exact external Runtime Session refs,
generation keys and Binding owner, closes those exact synthetic Jarvis/ACP
Sessions through the acceptance-only Worker
`cleanup_acceptance_session` operation, and verifies no receipt from another
command was touched. It never
uses a Session-key prefix, profile-wide cleanup or list-and-delete.
It then revokes every created Account Session and unused pairing code, proves
the manifest is empty, seals it, and only then stops the Worker and deletes the
disposable database/stack. The wrapper resumes an unsealed owned manifest
before a later run.

- [ ] **Step 2: Run the real browser test**

Use three independent `browser.newContext()` instances. Each context must visit
`/pair`, enter its own code, then call the real Session and Agent endpoints.
Assert:

- Cookies differ and are HttpOnly;
- codes cannot be reused;
- visible Agents match the exact matrix;
- forged headers do not change identity;
- ZZH cannot create a Session for 乔晶晶;
- NSY cannot create a Session for 于途;
- admin can create Sessions for all three;
- browser responses contain no internal Runtime refs.
- teardown closes exactly the three admin-created external Sessions and leaves
  a pre-existing control fixture untouched, then proves the disposable command
  manifest has no unclosed external ref before database removal.

`playwright.identity.config.ts` must target the exact production image started
by `scripts/start-identity-e2e-stack.sh`, verify its health revision first, use
no `pnpm dev` server and no existing-server reuse, and disable trace, video and
network-body retention so real HttpOnly Cookies cannot become artifacts.

```bash
bash scripts/start-identity-e2e-stack.sh \
  --release-sha "$IDENTITY_RELEASE_SHA" \
  --image "ai-super-canvas:identity-product-$IDENTITY_RELEASE_SHA" \
  --expected-image-id "$IDENTITY_IMAGE_ID" \
  --operator-image "ai-super-canvas:identity-operator-$IDENTITY_RELEASE_SHA" \
  --expected-operator-image-id "$IDENTITY_OPERATOR_IMAGE_ID" \
  --expected-hermes-revision "$HERMES_RELEASE_SHA" \
  --port 3100 \
  -- corepack pnpm exec playwright test \
  --config=playwright.identity.config.ts \
  tests/e2e/device-identity.real.spec.ts \
  --project=chromium \
  --workers=1
```

`playwright.identity.config.ts` has no `webServer`; it accepts only the
wrapper-provided `http://127.0.0.1:3100`, rejects the persistent port 3000,
and checks the exact image/health revision before pairing.

Expected: all tests pass using real PostgreSQL and real cookies.

- [ ] **Step 3: Run final identity gates and commit**

```bash
docker build --target test --tag ai-super-canvas:identity-final .
docker run --rm ai-super-canvas:identity-final lint
docker run --rm ai-super-canvas:identity-final typecheck
docker run --rm ai-super-canvas:identity-final test
COMPOSE_PROJECT_NAME=ai-super-canvas-identity-final \
  bash ./scripts/test-integration.sh
git diff --check
git add \
  tests/e2e/device-identity.real.spec.ts \
  playwright.identity.config.ts \
  compose.identity-acceptance.yaml \
  scripts/start-identity-e2e-stack.sh
git commit -m "test(e2e): prove isolated product accounts"
```

Expected: every identity gate exits 0. This completes the identity precondition
only; it does not yet make `/` a finished product.

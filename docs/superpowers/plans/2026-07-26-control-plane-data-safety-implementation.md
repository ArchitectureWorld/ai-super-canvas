# Control Plane Data Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复旧库 Message ordinal 计数器、补齐 Runtime Run adoption，并让终态 history sync 精确命中 Run 捕获的 Runtime Session ref。

**Architecture:** 数据迁移先修复旧库状态；Repository 用 receipt/Run 行锁在同一事务内提交 Run、receipt 和 compensation；`SessionService` 只在事务返回后启动事件泵；事件泵将不可变 `externalSessionRef` 传给 Repository 做 compare-and-set。

**Tech Stack:** TypeScript 6.0.3、Node.js 24.18.0、pnpm 11.15.1、Vitest 4.1.10、PostgreSQL 18、postgres.js、Drizzle ORM/Kit。

---

## Global constraints

- 权威设计：`docs/superpowers/specs/2026-07-26-control-plane-data-safety-design.md`。
- 工作目录：`.worktrees/control-plane-data-safety`；分支：
  `codex/control-plane-data-safety`。
- 每项行为严格执行 RED → GREEN → REFACTOR；必须保存 RED 和 GREEN 的命令输出。
- 每个任务独立提交；不得修改 `apps/web`、API、Hermes、服务端口或部署服务。
- 主机 Node.js 22 不满足仓库 engine；所有 Node 质量门禁在
  `node:24.18.0` Docker target 中运行。
- 数据库测试只允许连接 Compose 的
  `postgres-test/canvas_s1_test`，临时升级数据库必须由测试内部生成名称并在
  `finally` 删除。

## File map

### Legacy migration

- Create: `packages/db/migrations/0008_transcript_version_backfill.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create:
  `packages/db/src/schema/transcript-version-migration.integration.test.ts`

### Run adoption

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`

### Application handoff

- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`

### Terminal history CAS

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/run-event-pump.ts`
- Modify: `packages/control-plane/src/run-event-pump.test.ts`

---

### Task 1: Backfill legacy transcript counters through a real upgrade

**Files:**

- Create:
  `packages/db/src/schema/transcript-version-migration.integration.test.ts`
- Create: `packages/db/migrations/0008_transcript_version_backfill.sql`
- Modify: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Write the failing migration-journey integration test**

Create a standalone integration test. The helpers must use a temporary database,
apply actual migration folders, and never reset or drop the shared base database:

```ts
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, it } from 'vitest';

import { createPostgresControlPlaneRepository } from '../repositories/postgres-control-plane-repository';
import { assertDisposableTestDatabase } from '../testing/disposable-test-database';

const migrationsFolder = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

async function createLegacyMigrationFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'canvas-legacy-migrations-'));
  const metaFolder = join(folder, 'meta');
  await mkdir(metaFolder);
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string } & Record<string, unknown>>;
  };
  const legacyEntries = journal.entries.filter((entry) => entry.idx <= 7);
  for (const entry of legacyEntries) {
    await copyFile(
      join(migrationsFolder, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    join(metaFolder, '_journal.json'),
    JSON.stringify({ ...journal, entries: legacyEntries }, null, 2),
  );
  return folder;
}

function databaseUrlFor(base: string, databaseName: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

it('backfills legacy transcript counters before the current allocator writes', async () => {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  if (!baseDatabaseUrl) throw new Error('DATABASE_URL is required');
  assertDisposableTestDatabase(baseDatabaseUrl);

  const databaseName = `canvas_s1_upgrade_${randomUUID().replaceAll('-', '')}`;
  const legacyFolder = await createLegacyMigrationFolder();
  const admin = postgres(baseDatabaseUrl, { max: 1 });
  const databaseUrl = databaseUrlFor(baseDatabaseUrl, databaseName);
  let database: ReturnType<typeof postgres> | undefined;
  let repository:
    | ReturnType<typeof createPostgresControlPlaneRepository>
    | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    database = postgres(databaseUrl, { max: 4 });
    await migrate(drizzle(database), { migrationsFolder: legacyFolder });

    repository = createPostgresControlPlaneRepository(databaseUrl);
    const bootstrap = await repository.bootstrapLocalAlpha({
      commandId: randomUUID(),
      authSubject: `local:upgrade-${databaseName}`,
      displayName: 'Upgrade fixture',
      availableModels: [{
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
        displayName: 'Deterministic Fake v1',
        capabilities: { text: true, tools: false },
      }],
      defaultModelProviderKey: 'fake',
      defaultModelKey: 'deterministic-v1',
    });
    const actor = await repository.resolveActorContext({
      authSubject: `local:upgrade-${databaseName}`,
    });
    if (!actor) throw new Error('Upgrade fixture actor was not created');

    const legacySession = await repository.createRootSession({
      actor,
      commandId: randomUUID(),
      workflowId: bootstrap.workflowId,
      agentBindingId: bootstrap.agentBindingId,
      title: 'Legacy messages',
    });
    await repository.beginRuntimeDispatch({
      actor,
      commandReceiptId: legacySession.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor,
      commandReceiptId: legacySession.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session:upgrade',
    });
    await repository.attachRuntimeSession({
      actor,
      commandReceiptId: legacySession.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session:upgrade',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'sha256:legacy-upgrade',
        metadata: {},
      },
    });

    for (const content of ['legacy-0', 'legacy-1']) {
      await database`
        INSERT INTO messages (
          id, workflow_id, session_id, ordinal, role,
          actor_account_id, content, status
        )
        SELECT ${randomUUID()}, ${bootstrap.workflowId}, ${legacySession.sessionId},
          COALESCE(MAX(ordinal), -1) + 1, 'user', ${actor.accountId},
          ${database.json(content)}, 'completed'
        FROM messages
        WHERE session_id = ${legacySession.sessionId}
      `;
    }

    const emptySession = await repository.createRootSession({
      actor,
      commandId: randomUUID(),
      workflowId: bootstrap.workflowId,
      agentBindingId: bootstrap.agentBindingId,
      title: 'Empty counter',
    });
    const aheadSession = await repository.createRootSession({
      actor,
      commandId: randomUUID(),
      workflowId: bootstrap.workflowId,
      agentBindingId: bootstrap.agentBindingId,
      title: 'Ahead counter',
    });
    await database`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role,
        actor_account_id, content, status
      ) VALUES (
        ${randomUUID()}, ${bootstrap.workflowId}, ${aheadSession.sessionId}, 0,
        'user', ${actor.accountId}, ${database.json('ahead-0')}, 'completed'
      )
    `;
    await database`
      UPDATE sessions SET transcript_version = 7
      WHERE id = ${aheadSession.sessionId}
    `;

    await migrate(drizzle(database), { migrationsFolder });

    const counters = await database<{ id: string; transcript_version: number }[]>`
      SELECT id, transcript_version
      FROM sessions
      WHERE id IN (
        ${legacySession.sessionId}, ${emptySession.sessionId}, ${aheadSession.sessionId}
      )
      ORDER BY id
    `;
    expect(Object.fromEntries(
      counters.map((row) => [row.id, row.transcript_version]),
    )).toEqual({
      [legacySession.sessionId]: 2,
      [emptySession.sessionId]: 0,
      [aheadSession.sessionId]: 7,
    });

    const prepared = await repository.prepareRun({
      actor,
      commandId: randomUUID(),
      idempotencyKey: 'post-upgrade-run',
      sessionId: legacySession.sessionId,
      content: 'post-upgrade',
    });
    const [state] = await database<{
      ordinal: string;
      transcript_version: number;
    }[]>`
      SELECT message.ordinal::text AS ordinal, session.transcript_version
      FROM messages message
      JOIN sessions session ON session.id = message.session_id
      WHERE message.id = ${prepared.prompt.canvasMessageId}
    `;
    expect(state).toEqual({ ordinal: '2', transcript_version: 3 });

    await migrate(drizzle(database), { migrationsFolder });
    const [replayed] = await database<{ transcript_version: number }[]>`
      SELECT transcript_version FROM sessions WHERE id = ${legacySession.sessionId}
    `;
    expect(replayed?.transcript_version).toBe(3);
  } finally {
    await repository?.close();
    await database?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    await rm(legacyFolder, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-safety-migration-red \
  bash ./scripts/test-integration.sh
```

Expected: the new test fails because applying the current full migration set
leaves the legacy Session counter at `0` instead of `2`. Existing integration
tests remain green.

- [ ] **Step 3: Generate the custom migration and add the backfill**

Generate Drizzle's journal entry without using the host Node.js:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e DATABASE_URL=postgres://migration:unused@127.0.0.1:1/canvas_s1_test \
  -v "$PWD/packages/db/migrations:/workspace/packages/db/migrations" \
  ai-super-canvas-data-safety-baseline \
  pnpm --filter @ai-super-canvas/db exec drizzle-kit generate \
    --custom --name transcript_version_backfill
```

Put this exact SQL in the generated `0008` file:

```sql
LOCK TABLE "sessions" IN EXCLUSIVE MODE;--> statement-breakpoint

WITH "message_frontiers" AS (
  SELECT
    "session_id",
    MAX("ordinal") + 1 AS "next_transcript_version"
  FROM "messages"
  GROUP BY "session_id"
)
UPDATE "sessions" AS "session"
SET "transcript_version" =
  "frontier"."next_transcript_version"::integer
FROM "message_frontiers" AS "frontier"
WHERE "session"."id" = "frontier"."session_id"
  AND "session"."transcript_version"::bigint
    < "frontier"."next_transcript_version";
```

- [ ] **Step 4: Run GREEN and commit**

Run:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-safety-migration-green \
  bash ./scripts/test-integration.sh
git diff --check
```

Expected: all integration tests pass, including the new real-upgrade journey.

Commit:

```bash
git add packages/db/migrations \
  packages/db/src/schema/transcript-version-migration.integration.test.ts
git commit -m "fix(db): backfill legacy session transcript versions"
```

---

### Task 2: Atomically adopt a reconciled Runtime Run

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`

- [ ] **Step 1: Add RED integration coverage**

Add a test after the existing absent-Run reconciliation test. It must create a
prepared but unattached Run, mark its exact Runtime ref reconciling, resolve it
twice concurrently, and assert one final ledger:

```ts
it('atomically adopts a reconciled Runtime Run and replays idempotently', async () => {
  const { fixture, prepared, externalRunRef } = await prepareRuntimeRun({
    suffix: 'run-adopt',
    attachRun: false,
  });
  await repository.markRuntimeCommandReconciling({
    actor: fixture.actor,
    commandReceiptId: prepared.commandReceiptId,
    externalResourceKind: 'run',
    externalResourceRef: externalRunRef,
    error: 'attach response lost',
  });
  const input = {
    actor: fixture.actor,
    commandReceiptId: prepared.commandReceiptId,
    resolution: {
      kind: 'adopt-run' as const,
      runtimeRun: {
        externalRunRef,
        acceptedAt: '2026-07-18T04:40:00.000Z',
      },
      evidence: { lookup: 'single-match' },
    },
  };

  const [first, replay] = await Promise.all([
    repository.resolveRuntimeReconciliation(input),
    repository.resolveRuntimeReconciliation({ ...input }),
  ]);
  expect(first).toEqual({
    phase: 'attached',
    outcome: 'adopted',
    resource: {
      kind: 'run',
      runId: prepared.runId,
      status: 'running',
    },
  });
  expect(replay).toEqual(first);

  const [state] = await sql<{
    phase: string;
    receipt_ref: string;
    run_status: string;
    run_ref: string;
    compensation_count: number;
    compensation_status: string;
    compensation_attempts: number;
  }[]>`
    SELECT receipt.orchestration_phase::text AS phase,
      receipt.external_resource_ref AS receipt_ref,
      run.status::text AS run_status, run.runtime_run_ref AS run_ref,
      count(compensation.id)::integer AS compensation_count,
      max(compensation.status)::text AS compensation_status,
      max(compensation.attempts)::integer AS compensation_attempts
    FROM command_receipts receipt
    JOIN runs run ON run.id = receipt.run_id
    JOIN runtime_compensations compensation
      ON compensation.command_receipt_id = receipt.id
    WHERE receipt.id = ${prepared.commandReceiptId}
    GROUP BY receipt.id, run.id
  `;
  expect(state).toMatchObject({
    phase: 'attached',
    receipt_ref: externalRunRef,
    run_status: 'running',
    run_ref: externalRunRef,
    compensation_count: 1,
    compensation_status: 'succeeded',
    compensation_attempts: 1,
  });
});
```

Add two adjacent tests:

- attached replay with a different `externalRunRef` rejects and leaves all three
  rows unchanged;
- `evidence: { invalid: 1n }` rejects JSON serialization and rolls back Run,
  receipt, and compensation to reconciling/pending.

Before extending the union, cast only the test input at the call boundary so the
test executes. Remove the cast during GREEN.

- [ ] **Step 2: Run RED**

Run:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-safety-adopt-red \
  bash ./scripts/test-integration.sh
```

Expected: the new resolution falls through to `unresolved`; the attached result
assertion fails.

- [ ] **Step 3: Extend the exact contracts**

In `control-plane-repository.ts`, add `adopt-run` and replace the loose result
interface with:

```ts
export type RuntimeReconciliationResult =
  | {
      phase: 'attached';
      outcome: 'adopted';
      resource:
        | { kind: 'session'; sessionId: string }
        | { kind: 'run'; runId: string; status: StoredRunStatus };
    }
  | {
      phase: 'retryable_failure';
      outcome: 'absent';
    }
  | {
      phase: 'reconciling';
      outcome: 'unresolved';
    };
```

Return a Session resource from both first Session adoption and its attached
replay. Return the exact Run ID and current persisted status for Run adoption.

- [ ] **Step 4: Extract and reuse the transactional Run attach**

Extract the body of `attachRuntimeRun` into:

```ts
private async attachRuntimeRunInTransaction(
  tx: postgres.TransactionSql,
  receipt: ReceiptAuthorizationRow,
  runtimeRun: RuntimeRunAttachment,
  evidence: Record<string, unknown>,
): Promise<{ runId: string; status: StoredRunStatus }>
```

The Run update must use:

```sql
SET runtime_run_ref = COALESCE(runtime_run_ref, ${runtimeRun.externalRunRef}),
  status = CASE
    WHEN status IN ('queued', 'reconciling')
      THEN 'running'::run_status
    ELSE status
  END,
  started_at = COALESCE(started_at, ${acceptedAt}),
  error_code = CASE
    WHEN status IN ('queued', 'reconciling') THEN NULL
    ELSE error_code
  END,
  error_message = CASE
    WHEN status IN ('queued', 'reconciling') THEN NULL
    ELSE error_message
  END,
  completed_at = CASE
    WHEN status IN ('queued', 'reconciling') THEN NULL
    ELSE completed_at
  END
```

The helper must lock the Run, reject a conflicting ref, update receipt and the
single adopt compensation in the same transaction, preserve first evidence on
attached replay, and return the persisted Run status. Normal
`attachRuntimeRun` passes evidence:

```ts
{
  outcome: 'adopted',
  path: 'normal-command',
  externalRunRef: input.runtimeRun.externalRunRef,
}
```

The `adopt-run` resolver passes caller evidence, defaulting to
`{ outcome: 'adopted' }` only when it is empty.

- [ ] **Step 5: Run GREEN and commit**

Run:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-safety-adopt-green \
  bash ./scripts/test-integration.sh
docker build --target test -t ai-super-canvas-data-safety-test .
docker run --rm ai-super-canvas-data-safety-test \
  pnpm --filter @ai-super-canvas/db typecheck
git diff --check
```

Commit:

```bash
git add packages/db/src/repositories
git commit -m "feat(db): adopt reconciled Runtime Runs"
```

---

### Task 3: Start the event pump after adopted Run commit

**Files:**

- Modify: `packages/control-plane/src/session-service.ts`
- Modify: `packages/control-plane/src/session-service.test.ts`

- [ ] **Step 1: Write RED service tests**

Extend the Run-start harness with
`resolveRuntimeReconciliation: vi.fn()`. Add:

```ts
it('starts the pump only after an active Runtime Run adoption commits', async () => {
  const repository = createRunRepository();
  const adopted = {
    phase: 'attached',
    outcome: 'adopted',
    resource: {
      kind: 'run',
      runId: preparedRun().runId,
      status: 'running',
    },
  } as const;
  repository.resolveRuntimeReconciliation.mockResolvedValueOnce(adopted);
  const eventPump = { start: vi.fn().mockReturnValue('started' as const) };
  const service = new SessionService(
    repository as unknown as ControlPlaneRepository,
    {} as RuntimeAdapter,
    eventPump,
  );
  const input = {
    actor,
    commandReceiptId: ids.receiptId,
    resolution: {
      kind: 'adopt-run' as const,
      runtimeRun: {
        externalRunRef: 'fake-run-1',
        acceptedAt: new Date(0).toISOString(),
      },
      evidence: { lookup: 'single-match' },
    },
  };

  await expect(service.resolveRuntimeReconciliation(input)).resolves.toEqual(adopted);
  expect(repository.resolveRuntimeReconciliation.mock.invocationCallOrder[0])
    .toBeLessThan(eventPump.start.mock.invocationCallOrder[0]!);
  expect(eventPump.start).toHaveBeenCalledWith({
    actor,
    runId: preparedRun().runId,
  });
});
```

Add table-driven negative cases for `absent`, `unresolved`, adopted Session, and
adopted terminal Run; each must leave `eventPump.start` untouched. Add a
Repository rejection case and prove the pump is not started.

- [ ] **Step 2: Run RED**

Run:

```bash
docker build --target test -t ai-super-canvas-data-safety-test .
docker run --rm ai-super-canvas-data-safety-test \
  pnpm exec vitest run packages/control-plane/src/session-service.test.ts
```

Expected: `SessionService.resolveRuntimeReconciliation is not a function`.

- [ ] **Step 3: Implement post-commit handoff**

Import `ResolveRuntimeReconciliationInput` and
`RuntimeReconciliationResult`, then add:

```ts
async resolveRuntimeReconciliation(
  input: ResolveRuntimeReconciliationInput,
): Promise<RuntimeReconciliationResult> {
  const result = await this.repository.resolveRuntimeReconciliation(input);
  if (
    result.outcome === 'adopted'
    && result.resource.kind === 'run'
    && (
      result.resource.status === 'queued'
      || result.resource.status === 'running'
      || result.resource.status === 'waiting_approval'
    )
  ) {
    this.eventPump.start({
      actor: input.actor,
      runId: result.resource.runId,
    });
  }
  return result;
}
```

- [ ] **Step 4: Run GREEN and commit**

Run:

```bash
docker build --target test -t ai-super-canvas-data-safety-test .
docker run --rm ai-super-canvas-data-safety-test \
  pnpm exec vitest run packages/control-plane/src/session-service.test.ts
docker run --rm ai-super-canvas-data-safety-test \
  pnpm --filter @ai-super-canvas/control-plane typecheck
git diff --check
```

Commit:

```bash
git add packages/control-plane/src/session-service.ts \
  packages/control-plane/src/session-service.test.ts
git commit -m "feat(control-plane): resume pumps for adopted Runs"
```

---

### Task 4: CAS terminal history by immutable Runtime Session ref

**Files:**

- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify:
  `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/control-plane/src/run-event-pump.ts`
- Modify: `packages/control-plane/src/run-event-pump.test.ts`

- [ ] **Step 1: Write RED pump tests**

Add `externalSessionRef: context.externalSessionRef` to the existing success
expectation. Add:

```ts
it('reconciles instead of terminalizing when terminal history CAS rejects', async () => {
  const harness = createHarness(terminalEvents());
  harness.repository.syncRuntimeSessionHistory.mockRejectedValueOnce(
    new Error('Session active primary Runtime reference changed before history sync'),
  );

  harness.pump.start({ actor, runId: context.runId });
  await harness.pump.waitForIdle(context.runId);

  expect(harness.repository.syncRuntimeSessionHistory).toHaveBeenCalledWith({
    actor,
    sessionId: context.sessionId,
    externalSessionRef: context.externalSessionRef,
    historyDigest: 'sha256:after-run',
  });
  expect(harness.repository.ingestRuntimeEvent).toHaveBeenCalledTimes(1);
  expect(harness.repository.markRunReconciling).toHaveBeenCalledWith({
    actor,
    runId: context.runId,
    error: 'runtime_event_pump_failed',
  });
});
```

- [ ] **Step 2: Write the RED Repository rotation test**

Using `prepareRuntimeRun`, capture the Run's original ref, rotate the active
primary ref in one SQL transaction, then call
`syncRuntimeSessionHistory` with the original ref. Assert rejection and query
both rows to prove neither history digest changed.

The test input must be:

```ts
const staleSyncInput = {
  actor: fixture.actor,
  sessionId: session.sessionId,
  externalSessionRef: runContext.externalSessionRef,
  historyDigest: 'history-from-stale-run',
};
```

On current code this structurally compiles, resolves unexpectedly, and mutates
the replacement row.

- [ ] **Step 3: Run RED**

Run unit RED:

```bash
docker build --target test -t ai-super-canvas-data-safety-test .
docker run --rm ai-super-canvas-data-safety-test \
  pnpm exec vitest run packages/control-plane/src/run-event-pump.test.ts
```

Run integration RED:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-safety-history-red \
  bash ./scripts/test-integration.sh
```

Expected: unit call-shape assertion fails and the integration Promise resolves
instead of rejecting.

- [ ] **Step 4: Implement the exact-ref CAS**

Add `externalSessionRef: string` to the Repository interface and implementation.
Pass `context.externalSessionRef` from `RunEventPump`. Update SQL:

```sql
WHERE session_id = ${input.sessionId}
  AND is_primary = true
  AND status = 'active'
  AND external_session_ref = ${input.externalSessionRef}
```

When no row returns, throw:

```ts
throw new Error(
  'Session active primary Runtime reference changed before history sync',
);
```

Update existing integration-test calls to pass the exact ref they created.

- [ ] **Step 5: Run GREEN and commit**

Run:

```bash
docker build --target test -t ai-super-canvas-data-safety-test .
docker run --rm ai-super-canvas-data-safety-test \
  pnpm exec vitest run packages/control-plane/src/run-event-pump.test.ts
COMPOSE_PROJECT_NAME=ai-super-canvas-safety-history-green \
  bash ./scripts/test-integration.sh
docker run --rm ai-super-canvas-data-safety-test pnpm typecheck
git diff --check
```

Commit:

```bash
git add packages/db/src/repositories \
  packages/control-plane/src/run-event-pump.ts \
  packages/control-plane/src/run-event-pump.test.ts
git commit -m "fix(control-plane): CAS terminal history sync by Runtime ref"
```

---

### Task 5: Final verification and delivery review

**Files:**

- Verify all files changed by Tasks 1–4.
- No new production file is expected.

- [ ] **Step 1: Inspect scope and migration journal**

Run:

```bash
git status --short
git diff main...HEAD --stat
git diff main...HEAD -- packages/db/migrations/meta/_journal.json
git diff --check main...HEAD
```

Expected: only design/plan plus the scoped migration, Repository,
control-plane, and test files.

- [ ] **Step 2: Run all Node.js quality gates on Node 24**

Run:

```bash
docker build --target test -t ai-super-canvas-data-safety-final .
docker run --rm ai-super-canvas-data-safety-final pnpm test
docker run --rm ai-super-canvas-data-safety-final pnpm lint
docker run --rm ai-super-canvas-data-safety-final pnpm typecheck
docker run --rm ai-super-canvas-data-safety-final pnpm build
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run the full disposable-Postgres gate**

Run:

```bash
COMPOSE_PROJECT_NAME=ai-super-canvas-data-safety-final \
  bash ./scripts/test-integration.sh
```

Expected: all migrations apply from zero and all integration tests pass,
including the temporary `0007 → 0008` upgrade journey.

- [ ] **Step 4: Independent review**

Run a spec-compliance review first, then a code-quality review. Any Important or
higher finding returns to the responsible task's implementer and is re-reviewed
after its focused tests pass.

- [ ] **Step 5: Record final branch state**

Run:

```bash
git status --short --branch
git log --oneline main..HEAD
```

Expected: clean `codex/control-plane-data-safety` with one documentation commit
and four implementation commits. Do not merge, push, deploy, or modify the
separate API worktree without a new delivery decision.

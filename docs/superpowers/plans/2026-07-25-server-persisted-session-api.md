# Server-Persisted Session API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the already-implemented persisted Session application layer through server-owned Next.js Route Handlers, including database readiness, without adding a browser page or changing the existing canvas.

**Architecture:** Thin Route Handlers validate transport input, resolve a server-owned ActorContext, call `SessionService`, and map stable errors. A `globalThis`-backed server-only composition root owns one PostgreSQL repository, one `DeterministicFakeRuntime`, one `RunEventPump`, and one `SessionService` per web process. Event reads use short-polling JSON through `SessionService.getRunEvents`; no Route consumes Runtime streams or duplicates application state machines.

**Tech Stack:** TypeScript 6.0.3, Next.js 16.2.11 App Router, React 19.2.7, Zod 4.4.3, PostgreSQL 18, postgres.js 3.4.9, Vitest 4.1.10, Node.js 24.18.0, pnpm 11.15.1, Docker Compose.

## Global Constraints

- Start from `origin/main` commit `edc20750beac2bb6b1954410ab1ff48a4e915827` or a verified newer descendant, using a new branch and isolated Linux worktree.
- This is the **API PR only**: add server composition, Route Handlers, database readiness, and Route contract tests. Do not add `/control-plane-test`, browser state, Playwright E2E, Golden Path claims, existing `/` canvas changes, Hermes, a real model provider, a new port, or a new service.
- Migration `0007_motionless_black_queen.sql` is already on `main` and is a mandatory rollout prerequisite. This PR adds no schema migration.
- This API PR does not claim that the current production Compose database owner is a restricted application role. Readiness integration uses `APP_DATABASE_URL`; restricted production grants and role wiring are a deployment hard gate before LAN exposure.
- `PostgresControlPlaneRepository.checkReadiness` is a concrete infrastructure capability exposed to web through a narrow `DatabaseReadinessProbe`; it does not expand the application-facing `ControlPlaneRepository` interface.
- The web package may depend on `@ai-super-canvas/control-plane`, `@ai-super-canvas/core`, `@ai-super-canvas/db`, `zod@4.4.3`, and `server-only@0.0.1`. Route code must not import `postgres`, Drizzle, or internal control-plane modules.
- `AUTH_MODE=local` and server-owned `APP_OWNER_SUBJECT` are the only local-alpha identity inputs. Request JSON must not supply `accountId`, `authSubject`, model selection, binding policy, or tool policy; all body schemas are strict.
- Every non-bootstrap request resolves `ActorContext` from the current Repository with `APP_OWNER_SUBJECT`. Missing/disabled local identity and invisible resources return the same sanitized `404`.
- The composition root uses one shared Repository, Runtime, event pump, and service per process. Initialization waits for `reconcileAfterRestart()`, closes the Repository after failed initialization, and clears a rejected singleton Promise so a later request can retry.
- `GET /api/control-plane/runs/:runId/events` calls `SessionService.getRunEvents` and returns short-polling JSON. It must not call `ControlPlaneRepository.listRunEvents` or `RuntimeAdapter.streamRunEvents` directly and must not emit SSE.
- All ordinary error responses use `{ error: { code, message, retryable }, commandReceiptId? }`. Never return or raw-log stack traces, SQL, connection strings, external Runtime refs, ActorContext, private context, or exception objects.
- `command_requires_reconciliation` and `command_persistence_unconfirmed` return `202` with `Retry-After: 2`; conflicts return `409`; `runtime_session_unavailable` returns `409`; `runtime_operation_failed` returns the approved internal-error status `500` while preserving its stable `retryable` field.
- `GET /api/ready` reuses the process's single PostgreSQL pool through a repository-only loader, applies both finite connect timeout and transaction-local PostgreSQL `statement_timeout`, never constructs or calls Runtime/Pump/Service, returns the approved `200/503` bodies, and always disables caching.
- Dynamic Next.js route params are Promises and must be awaited. Every control-plane Route exports `runtime = 'nodejs'`; GET routes also export `dynamic = 'force-dynamic'` and return `Cache-Control: no-store`.
- All development and verification run on Linux through SSH. Use Node.js 24.18.0 and pnpm 11.15.1, preferably through the repository Dockerfile.
- Follow strict TDD: add one behavioral test, observe the intended failure, write the smallest implementation, observe green, then refactor. Do not write production behavior before its failing test.

---

### Task 0: Land the approved plan and specification amendment before code

**Files:**
- Create: `docs/superpowers/plans/2026-07-25-server-persisted-session-api.md`
- Modify: `docs/superpowers/specs/2026-07-23-server-persisted-session-vertical-slice-design.md`

**Interfaces:**
- Consumes: the reviewed UTF-8 plan file and `api-spec-amendment.patch`.
- Produces: a committed documentation baseline that Tasks 1-6 are required to follow.

- [ ] **Step 1: Stage the reviewed artifacts in the Linux API worktree**

From Windows, copy the reviewed plan to its final path and the amendment to a temporary Linux path:

```powershell
scp -i C:\Users\YR\.ssh\id_ed25519_codex_admin_yr `
  .\server-persisted-session-api-plan.md `
  youran@192.168.110.84:/home/youran/Development/AI-Super-Canvas/.worktrees/server-persisted-session-api/docs/superpowers/plans/2026-07-25-server-persisted-session-api.md
scp -i C:\Users\YR\.ssh\id_ed25519_codex_admin_yr `
  .\api-spec-amendment.patch `
  youran@192.168.110.84:/tmp/api-spec-amendment.patch
```

- [ ] **Step 2: Apply and verify the UTF-8 specification amendment**

```bash
cd /home/youran/Development/AI-Super-Canvas/.worktrees/server-persisted-session-api
test -s docs/superpowers/plans/2026-07-25-server-persisted-session-api.md
test -s /tmp/api-spec-amendment.patch
git apply --check --unidiff-zero /tmp/api-spec-amendment.patch
git apply --unidiff-zero /tmp/api-spec-amendment.patch
git diff --check
git diff -- docs/superpowers
```

Expected: the plan exists at its final path; the design records readiness timeout/cancellation, transcript `status`, stable application error statuses, validation coverage, and the restricted-role deployment boundary.

- [ ] **Step 3: Commit the documentation baseline**

```bash
git add \
  docs/superpowers/plans/2026-07-25-server-persisted-session-api.md \
  docs/superpowers/specs/2026-07-23-server-persisted-session-vertical-slice-design.md
git commit -m "docs(plan): define persisted session API"
git status --short
```

Expected: the commit succeeds and the API worktree is clean before Task 1.

---

### Task 1: Establish the strict HTTP and stable error boundary

**Files:**
- Create: `apps/web/src/app/api/control-plane/http.ts`
- Create: `apps/web/src/app/api/control-plane/http.test.ts`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `ControlPlaneApplicationError`, `AuthorizationError`, `CommandPayloadConflictError`, `ActiveRunConflictError`, `RunIdempotencyConflictError`, `RunStateConflictError`, and Zod schemas. `SessionConfigVersionConflictError` is intentionally excluded because none of the six API methods update Session config.
- Produces:
  - `HttpError(status, code, message, retryable)`
  - `parseJson<T>(request, schema): Promise<T>`
  - `parseUuid(value): string`
  - `parseAfter(request): number`
  - `errorResponse(reason, logger?): Response`
  - `noStoreJson(body, init?): Response`

- [ ] **Step 1: Add explicit web dependencies and refresh only the lockfile**

Add these exact dependencies to `apps/web/package.json`:

```json
"@ai-super-canvas/control-plane": "workspace:*",
"server-only": "0.0.1",
"zod": "4.4.3"
```

Run in the API worktree:

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$PWD:/workspace" \
  -w /workspace \
  node:24.18.0-bookworm-slim \
  sh -lc 'npm install --global pnpm@11.15.1 && pnpm install --lockfile-only'
```

Expected: only the `apps/web` importer and required package snapshots change in `pnpm-lock.yaml`.

- [ ] **Step 2: Write failing HTTP-boundary tests**

Create `http.test.ts` with literal requests and responses. Each test names the production mutation it catches:

```ts
import {
  ControlPlaneApplicationError,
} from '@ai-super-canvas/control-plane';
import {
  ActiveRunConflictError,
  AuthorizationError,
  CommandPayloadConflictError,
  RunIdempotencyConflictError,
  RunStateConflictError,
} from '@ai-super-canvas/db';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  errorResponse,
  parseAfter,
  parseJson,
  parseUuid,
  noStoreJson,
} from './http';

const StrictBody = z.object({
  commandId: z.uuid(),
}).strict();

describe('control-plane HTTP boundary', () => {
  it('rejects malformed JSON without echoing parser details', async () => {
    const request = new Request('http://localhost/api/control-plane/bootstrap', {
      method: 'POST',
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    const response = errorResponse(
      await parseJson(request, StrictBody).catch((reason: unknown) => reason),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'malformed_json',
        message: 'Request body must be valid JSON',
        retryable: false,
      },
    });
  });

  it('rejects forged server-owned fields through a strict schema', async () => {
    const request = new Request('http://localhost/api/control-plane/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        commandId: '23232323-2323-4323-8323-232323232323',
        authSubject: 'attacker',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const response = errorResponse(
      await parseJson(request, StrictBody).catch((reason: unknown) => reason),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'Request validation failed',
        retryable: false,
      },
    });
  });

  it.each([
    [new CommandPayloadConflictError('receipt'), 'command_payload_conflict'],
    [new ActiveRunConflictError('11111111-1111-4111-8111-111111111111'), 'active_run_conflict'],
    [new RunIdempotencyConflictError('key'), 'run_idempotency_conflict'],
    [new RunStateConflictError('terminal Run'), 'run_state_conflict'],
  ])('maps %s to a sanitized 409', async (reason, code) => {
    const response = errorResponse(reason);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code,
        message: 'Request conflicts with current state',
        retryable: false,
      },
    });
  });

  it('hides authorization failures behind not-found', async () => {
    const response = errorResponse(new AuthorizationError());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'Resource not found',
        retryable: false,
      },
    });
  });

  it.each([
    'command_requires_reconciliation',
    'command_persistence_unconfirmed',
  ] as const)('maps %s to an observed 202 response', async (code) => {
    const response = errorResponse(new ControlPlaneApplicationError(
      code,
      'safe application message',
      true,
      'receipt-1',
    ));
    expect(response.status).toBe(202);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({
      error: { code, message: 'safe application message', retryable: true },
      commandReceiptId: 'receipt-1',
    });
  });

  it.each([
    ['runtime_session_unavailable', 409],
    ['runtime_operation_failed', 500],
  ] as const)('maps %s to its approved stable status', async (code, status) => {
    const response = errorResponse(new ControlPlaneApplicationError(
      code,
      'safe application message',
      false,
      'receipt-2',
    ));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: { code, message: 'safe application message', retryable: false },
      commandReceiptId: 'receipt-2',
    });
  });

  it('does not leak an unknown exception or raw-log it', async () => {
    const logger = { error: vi.fn() };
    const response = errorResponse(
      new Error('postgres://user:secret@db/sql SELECT private'),
      logger,
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledWith(
      'control_plane_request_failed',
      { errorName: 'Error' },
    );
  });

  it.each(['not-a-uuid', '1.5', '-1', '9007199254740992'])(
    'rejects invalid path or cursor input %s',
    (value) => {
      if (value === 'not-a-uuid') {
        expect(() => parseUuid(value)).toThrow();
      } else {
        expect(() => parseAfter(new Request(
          `http://localhost/events?after=${encodeURIComponent(value)}`,
        ))).toThrow();
      }
    },
  );

  it('preserves caller status and headers while forcing no-store', async () => {
    const response = noStoreJson(
      { ok: true },
      {
        status: 202,
        headers: { 'x-request-id': 'request-1', 'cache-control': 'public' },
      },
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('x-request-id')).toBe('request-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run the focused test and verify RED**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test \
  vitest run apps/web/src/app/api/control-plane/http.test.ts
```

Expected: FAIL because `./http` does not exist. Dependency resolution must succeed; a missing dependency is not the intended RED.

- [ ] **Step 4: Implement the minimal HTTP boundary**

Implement `http.ts` with these fixed rules:

```ts
import {
  ControlPlaneApplicationError,
} from '@ai-super-canvas/control-plane';
import {
  ActiveRunConflictError,
  AuthorizationError,
  CommandPayloadConflictError,
  RunIdempotencyConflictError,
  RunStateConflictError,
} from '@ai-super-canvas/db';
import { ZodError, z, type ZodType } from 'zod';

export interface SafeErrorLogger {
  error(event: string, context: { errorName: string }): void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const defaultLogger: SafeErrorLogger = {
  error(event, context) {
    console.error(event, context);
  },
};

export async function parseJson<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(
      400,
      'malformed_json',
      'Request body must be valid JSON',
    );
  }
  return schema.parse(value);
}

export function parseUuid(value: string): string {
  return z.uuid().parse(value);
}

const CursorSchema = z.string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .refine(Number.isSafeInteger);

export function parseAfter(request: Request): number {
  return CursorSchema.parse(
    new URL(request.url).searchParams.get('after') ?? '0',
  );
}
```

Use one private `jsonError(...)` helper backed by `noStoreJson(...)`, so every error response also carries `Cache-Control: no-store`. Map:

- `HttpError` and `ZodError` to `400`;
- `AuthorizationError` to sanitized `404`;
- `CommandPayloadConflictError`, `ActiveRunConflictError`, `RunIdempotencyConflictError`, and `RunStateConflictError` to distinct sanitized `409` codes tested above;
- application reconciliation/persistence-unconfirmed to `202` and `Retry-After: 2`;
- `runtime_session_unavailable` to `409`;
- `runtime_operation_failed` to `500`;
- unknown failures to sanitized `500`, logging only `{ errorName }`.

`noStoreJson` constructs new `Headers(init.headers)`, overwrites only `Cache-Control` with `no-store`, preserves caller status and other headers, and returns JSON with `content-type: application/json`.

- [ ] **Step 5: Run RED-to-GREEN verification and the web typecheck**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test \
  vitest run apps/web/src/app/api/control-plane/http.test.ts
docker run --rm ai-super-canvas:api-test \
  --filter @ai-super-canvas/web typecheck
```

Expected: HTTP tests pass and the web package typechecks.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/web/package.json pnpm-lock.yaml \
  apps/web/src/app/api/control-plane/http.ts \
  apps/web/src/app/api/control-plane/http.test.ts
git commit -m "feat(web): define control-plane HTTP boundary"
```

---

### Task 2: Add a cancellable PostgreSQL readiness probe on the existing pool

**Files:**
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`

**Interfaces:**
- Consumes: the concrete `PostgresControlPlaneRepository` pool and its existing test-hook object.
- Produces: `PostgresControlPlaneRepository.checkReadiness(timeoutMs?: number): Promise<void>` and `PostgresControlPlaneRepositoryHooks.afterReadinessTimeoutConfigured?(tx)`.
- Does not modify the application-facing `ControlPlaneRepository`; Task 3 exposes only a narrow `DatabaseReadinessProbe`.

- [ ] **Step 1: Write the failing real-PostgreSQL timeout and recovery tests**

Use `APP_DATABASE_URL` for this probe so the test identity is `canvas_s1_app`, not the migrator/owner:

```ts
const appDatabaseUrl = process.env.APP_DATABASE_URL;
if (!appDatabaseUrl) {
  throw new Error('APP_DATABASE_URL is required for readiness integration tests');
}

it('cancels a blocked readiness statement and reuses the recovered connection', async () => {
  let probeCalls = 0;
  const backendPids: number[] = [];
  const readinessRepository = createPostgresControlPlaneRepository(
    appDatabaseUrl,
    {
      afterReadinessTimeoutConfigured: async (tx) => {
        const [row] = await tx<{ pid: number }[]>`
          SELECT pg_backend_pid()::integer AS pid
        `;
        backendPids.push(row!.pid);
        if (probeCalls++ === 0) await tx`SELECT pg_sleep(2)`;
      },
    },
  );
  try {
    await expect(readinessRepository.checkReadiness(100))
      .rejects.toMatchObject({ code: '57014' });
    await expect(readinessRepository.checkReadiness(1_000))
      .resolves.toBeUndefined();
    expect(backendPids).toHaveLength(2);
    expect(backendPids[1]).toBe(backendPids[0]);
  } finally {
    await readinessRepository.close();
  }
});

it.each([0, -1, 1.5, Number.NaN, 10_001])(
  'rejects invalid readiness timeout %s before opening a transaction',
  async (timeoutMs) => {
    await expect(repository.checkReadiness(timeoutMs))
      .rejects.toBeInstanceOf(RangeError);
  },
);
```

The `57014` assertion proves PostgreSQL cancelled the blocking statement. The second success on the same backend PID proves the aborted transaction was rolled back and the pool connection remains usable.

- [ ] **Step 2: Run the focused integration test and verify RED**

```bash
project="ai-super-canvas-api-readiness-$$"
compose=(docker compose -p "$project" -f compose.control-plane-test.yaml)
cleanup() { "${compose[@]}" down --volumes --remove-orphans; }
trap cleanup EXIT
"${compose[@]}" up -d postgres-test
"${compose[@]}" run --rm --build test --filter @ai-super-canvas/db db:migrate
"${compose[@]}" run --rm test vitest run --config vitest.integration.config.ts \
  packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
```

Expected: FAIL because the hook and `checkReadiness` do not exist.

- [ ] **Step 3: Implement database-side cancellation without a JavaScript race**

Extend the hook interface:

```ts
export interface PostgresControlPlaneRepositoryHooks {
  afterHydrateSnapshotEstablished?: () => Promise<void> | void;
  afterReadinessTimeoutConfigured?: (
    tx: postgres.TransactionSql,
  ) => Promise<void> | void;
}
```

Use a finite connection timeout for the existing pool:

```ts
this.sql = postgres(databaseUrl, {
  max: 10,
  connect_timeout: 1,
});
```

Add the concrete method:

```ts
async checkReadiness(timeoutMs = 1_000): Promise<void> {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 10_000
  ) {
    throw new RangeError('Database readiness timeout must be 1..10000ms');
  }

  await this.sql.begin(async (tx) => {
    await tx`
      SELECT set_config(
        'statement_timeout',
        ${`${timeoutMs}ms`},
        true
      )
    `;
    await this.hooks.afterReadinessTimeoutConfigured?.(tx);
    await tx`SELECT 1 AS ready`;
  });
}
```

`set_config(..., true)` is transaction-local and parameter-safe. PostgreSQL cancels an over-budget statement; postgres.js rolls the failed transaction back. Do not add `Promise.race`, a second pool, or a sanitized wrapper here—the HTTP boundary owns client-safe errors.

- [ ] **Step 4: Run the full integration and DB package gates**

```bash
bash scripts/test-integration.sh
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test --filter @ai-super-canvas/db typecheck
docker run --rm ai-super-canvas:api-test --filter @ai-super-canvas/db lint
```

Expected: the cancellation/recovery test, complete PostgreSQL integration suite, typecheck, and lint pass without warnings.

- [ ] **Step 5: Commit Task 2**

```bash
git add \
  packages/db/src/repositories/postgres-control-plane-repository.ts \
  packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts
git commit -m "feat(db): expose cancellable readiness probe"
```

---

### Task 3: Build the server-only, retryable composition root and readiness Route

**Files:**
- Create: `apps/web/src/server/control-plane.ts`
- Create: `apps/web/src/server/control-plane.test.ts`
- Create: `apps/web/src/app/api/ready/handler.ts`
- Create: `apps/web/src/app/api/ready/handler.test.ts`
- Create: `apps/web/src/app/api/ready/route.ts`
- Modify: `.env.example`
- Modify: `compose.yaml`

**Interfaces:**
- Consumes: `createPostgresControlPlaneRepository`, `DeterministicFakeRuntime`, `RunEventPump`, `SessionService`, the readiness method from Task 2, and server environment.
- Produces:
  - `ControlPlaneContext`
  - `DatabaseReadinessProbe`
  - `createControlPlaneContext({ repository, factory })`
  - `createControlPlaneLoader<T>(factory)`
  - `createControlPlaneLoaders({ getDatabaseUrl, factory })`
  - `getRepository()`
  - `getControlPlane()`
  - `localAuthSubject(environment?)`
  - `resolveLocalActorContext(repository, authSubject)`
  - `getLocalActorContext()`
  - `checkDatabaseReadinessWith(getRepository)`
  - `checkDatabaseReadiness()`
  - `makeReadyHandler({ checkDatabase }): () => Promise<Response>`

- [ ] **Step 1: Write failing composition-root tests**

Mock `server-only` only so Vitest can load the server module; keep the composition functions real:

```ts
import { AuthorizationError } from '@ai-super-canvas/db';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  checkDatabaseReadinessWith,
  createControlPlaneContext,
  createControlPlaneLoader,
  createControlPlaneLoaders,
  localAuthSubject,
  resolveLocalActorContext,
} from './control-plane';

describe('control-plane composition', () => {
  it('shares one in-flight context initialization', async () => {
    const context = { service: {} } as never;
    const factory = vi.fn().mockResolvedValue(context);
    const load = createControlPlaneLoader(factory);
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toBe(context);
    expect(second).toBe(context);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('clears a rejected initialization so the next request retries', async () => {
    const context = { service: {} } as never;
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce(context);
    const load = createControlPlaneLoader(factory);
    await expect(load()).rejects.toThrow('first failure');
    await expect(load()).resolves.toBe(context);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('waits for restart reconciliation before returning the context', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const repository = {
      close: vi.fn(),
      resolveActorContext: vi.fn(),
    };
    const eventPump = {
      reconcileAfterRestart: vi.fn().mockReturnValue(gate),
    };
    const pending = createControlPlaneContext({
      repository: repository as never,
      factory: {
        createRuntime: () => ({} as never),
        createEventPump: () => eventPump as never,
        createService: () => ({} as never),
      },
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toMatchObject({ repository, eventPump });
  });

  it('closes the repository if initialization fails', async () => {
    const repository = { close: vi.fn().mockResolvedValue(undefined) };
    await expect(createControlPlaneContext({
      repository: repository as never,
      factory: {
        createRuntime: () => ({} as never),
        createEventPump: () => ({
          reconcileAfterRestart: vi.fn().mockRejectedValue(new Error('reconcile failed')),
        } as never),
        createService: () => ({} as never),
      },
    })).rejects.toThrow('reconcile failed');
    expect(repository.close).toHaveBeenCalledTimes(1);
  });

  it('probes the repository without constructing Runtime and reuses it later', async () => {
    const repository = {
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      resolveActorContext: vi.fn(),
    };
    const runtime = {};
    const eventPump = {
      reconcileAfterRestart: vi.fn().mockResolvedValue(0),
    };
    const service = {};
    const factory = {
      createRepository: vi.fn().mockReturnValue(repository),
      createRuntime: vi.fn().mockReturnValue(runtime),
      createEventPump: vi.fn().mockReturnValue(eventPump),
      createService: vi.fn().mockReturnValue(service),
    };
    const loaders = createControlPlaneLoaders({
      getDatabaseUrl: () => 'postgres://redacted',
      factory: factory as never,
    });

    await checkDatabaseReadinessWith(loaders.getRepository);
    await checkDatabaseReadinessWith(loaders.getRepository);
    expect(factory.createRepository).toHaveBeenCalledTimes(1);
    expect(repository.checkReadiness).toHaveBeenNthCalledWith(1, 1_000);
    expect(repository.checkReadiness).toHaveBeenNthCalledWith(2, 1_000);
    expect(factory.createRuntime).not.toHaveBeenCalled();
    expect(factory.createEventPump).not.toHaveBeenCalled();
    expect(factory.createService).not.toHaveBeenCalled();

    const context = await loaders.getControlPlane();
    expect(context.repository).toBe(repository);
    expect(context.runtime).toBe(runtime);
    expect(context.eventPump).toBe(eventPump);
    expect(context.service).toBe(service);
    expect(factory.createEventPump).toHaveBeenCalledWith(
      repository,
      runtime,
    );
    expect(factory.createService).toHaveBeenCalledWith(
      repository,
      runtime,
      eventPump,
    );
    expect(eventPump.reconcileAfterRestart).toHaveBeenCalledTimes(1);
  });

  it('closes and clears a failed context repository before retrying', async () => {
    const firstFailure = new Error('first reconciliation failed');
    const firstRepository = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const secondRepository = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const factory = {
      createRepository: vi.fn()
        .mockReturnValueOnce(firstRepository)
        .mockReturnValueOnce(secondRepository),
      createRuntime: vi.fn().mockReturnValue({}),
      createEventPump: vi.fn()
        .mockReturnValueOnce({
          reconcileAfterRestart: vi.fn().mockRejectedValue(firstFailure),
        })
        .mockReturnValueOnce({
          reconcileAfterRestart: vi.fn().mockResolvedValue(0),
        }),
      createService: vi.fn().mockReturnValue({}),
    };
    const loaders = createControlPlaneLoaders({
      getDatabaseUrl: () => 'postgres://redacted',
      factory: factory as never,
    });
    await expect(loaders.getControlPlane()).rejects.toBe(firstFailure);
    await expect(loaders.getControlPlane()).resolves.toMatchObject({
      repository: secondRepository,
    });
    expect(firstRepository.close).toHaveBeenCalledTimes(1);
    expect(factory.createRepository).toHaveBeenCalledTimes(2);
  });

  it('does not mask the initialization failure when close also fails', async () => {
    const original = new Error('reconcile failed');
    const repository = {
      close: vi.fn().mockRejectedValue(new Error('close failed')),
    };
    await expect(createControlPlaneContext({
      repository: repository as never,
      factory: {
        createRuntime: () => ({} as never),
        createEventPump: () => ({
          reconcileAfterRestart: vi.fn().mockRejectedValue(original),
        } as never),
        createService: () => ({} as never),
      },
    })).rejects.toBe(original);
  });

  it('uses only the server local auth subject', () => {
    expect(localAuthSubject({
      AUTH_MODE: 'local',
      APP_OWNER_SUBJECT: ' local:test-owner ',
    } as NodeJS.ProcessEnv)).toBe('local:test-owner');
    expect(() => localAuthSubject({
      AUTH_MODE: 'production',
    } as NodeJS.ProcessEnv)).toThrow(AuthorizationError);
  });

  it('fails closed when the current auth subject is not bootstrapped', async () => {
    const repository = { resolveActorContext: vi.fn().mockResolvedValue(null) };
    await expect(resolveLocalActorContext(
      repository as never,
      'local:missing',
    )).rejects.toBeInstanceOf(AuthorizationError);
  });
});
```

- [ ] **Step 2: Write failing readiness-handler tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { makeReadyHandler } from './handler';

describe('GET /api/ready', () => {
  it('returns live database readiness without caching', async () => {
    const checkDatabase = vi.fn().mockResolvedValue(undefined);
    const response = await makeReadyHandler({ checkDatabase })();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'ready',
      database: 'ready',
    });
  });

  it('returns 503 without exposing the database exception', async () => {
    const checkDatabase = vi.fn().mockRejectedValue(
      new Error('postgres://user:secret@db'),
    );
    const response = await makeReadyHandler({ checkDatabase })();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body).toEqual({
      status: 'not-ready',
      database: 'unavailable',
    });
  });
});
```


- [ ] **Step 3: Run focused tests and verify RED**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test vitest run \
  apps/web/src/server/control-plane.test.ts \
  apps/web/src/app/api/ready/handler.test.ts
```

Expected: FAIL because composition and readiness modules do not exist.

- [ ] **Step 4: Implement the composition root**

Create `control-plane.ts` with the following complete composition. Keep every import on a public package export:

```ts
import 'server-only';

import {
  DeterministicFakeRuntime,
  type RuntimeAdapter,
} from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import {
  AuthorizationError,
  createPostgresControlPlaneRepository,
  requireDatabaseUrl,
  type ControlPlaneRepository,
} from '@ai-super-canvas/db';
import {
  RunEventPump,
  SessionService,
} from '@ai-super-canvas/control-plane';

export interface DatabaseReadinessProbe {
  checkReadiness(timeoutMs?: number): Promise<void>;
}

type ReadyRepository =
  ControlPlaneRepository & DatabaseReadinessProbe;

export interface ControlPlaneContext {
  repository: ReadyRepository;
  runtime: RuntimeAdapter;
  eventPump: RunEventPump;
  service: SessionService;
}

export interface ControlPlaneFactory {
  createRepository(databaseUrl: string): ReadyRepository;
  createRuntime(): RuntimeAdapter;
  createEventPump(
    repository: ControlPlaneRepository,
    runtime: RuntimeAdapter,
  ): RunEventPump;
  createService(
    repository: ControlPlaneRepository,
    runtime: RuntimeAdapter,
    eventPump: RunEventPump,
  ): SessionService;
}

const defaultFactory: ControlPlaneFactory = {
  createRepository: createPostgresControlPlaneRepository,
  createRuntime: () => new DeterministicFakeRuntime(),
  createEventPump: (repository, runtime) =>
    new RunEventPump(repository, runtime),
  createService: (repository, runtime, eventPump) =>
    new SessionService(repository, runtime, eventPump),
};

export async function createControlPlaneContext(input: {
  repository: ReadyRepository;
  factory: Omit<ControlPlaneFactory, 'createRepository'>;
}): Promise<ControlPlaneContext> {
  try {
    const runtime = input.factory.createRuntime();
    const eventPump = input.factory.createEventPump(
      input.repository,
      runtime,
    );
    const service = input.factory.createService(
      input.repository,
      runtime,
      eventPump,
    );
    await eventPump.reconcileAfterRestart();
    return {
      repository: input.repository,
      runtime,
      eventPump,
      service,
    };
  } catch (reason) {
    try {
      await input.repository.close();
    } catch {
      // Preserve the initialization error; the closed pool is discarded.
    }
    throw reason;
  }
}

export interface ControlPlaneLoader<T> {
  (): Promise<T>;
  clear(): void;
}

export function createControlPlaneLoader<T>(
  factory: () => Promise<T>,
): ControlPlaneLoader<T> {
  let current: Promise<T> | undefined;
  const load = (async (): Promise<T> => {
    current ??= factory();
    const attempt = current;
    try {
      return await attempt;
    } catch (reason) {
      if (current === attempt) current = undefined;
      throw reason;
    }
  }) as ControlPlaneLoader<T>;
  load.clear = () => {
    current = undefined;
  };
  return load;
}

export function createControlPlaneLoaders(input: {
  getDatabaseUrl: () => string;
  factory?: ControlPlaneFactory;
}): {
  getRepository: ControlPlaneLoader<ReadyRepository>;
  getControlPlane: ControlPlaneLoader<ControlPlaneContext>;
} {
  const factory = input.factory ?? defaultFactory;
  const getRepository = createControlPlaneLoader(async () =>
    factory.createRepository(input.getDatabaseUrl()));
  const getControlPlane = createControlPlaneLoader(async () => {
    const repository = await getRepository();
    try {
      return await createControlPlaneContext({
        repository,
        factory,
      });
    } catch (reason) {
      getRepository.clear();
      throw reason;
    }
  });
  return { getRepository, getControlPlane };
}

export function localAuthSubject(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.AUTH_MODE?.trim() !== 'local') {
    throw new AuthorizationError();
  }
  const authSubject =
    (environment.APP_OWNER_SUBJECT ?? 'local:owner').trim();
  if (!authSubject) throw new AuthorizationError();
  return authSubject;
}

export async function resolveLocalActorContext(
  repository: ControlPlaneRepository,
  authSubject: string,
): Promise<ActorContext> {
  const actor = await repository.resolveActorContext({ authSubject });
  if (!actor) throw new AuthorizationError();
  return actor;
}

const processGlobal = globalThis as typeof globalThis & {
  __aiSuperCanvasControlPlaneLoaders?: ReturnType<
    typeof createControlPlaneLoaders
  >;
};

const productionLoaders =
  processGlobal.__aiSuperCanvasControlPlaneLoaders ??=
    createControlPlaneLoaders({
      getDatabaseUrl: () => requireDatabaseUrl(),
    });

export const getRepository = productionLoaders.getRepository;
export const getControlPlane = productionLoaders.getControlPlane;

export async function getLocalActorContext(): Promise<ActorContext> {
  const authSubject = localAuthSubject();
  const repository = await getRepository();
  return resolveLocalActorContext(repository, authSubject);
}

export async function checkDatabaseReadinessWith(
  loadRepository: () => Promise<DatabaseReadinessProbe>,
): Promise<void> {
  const repository = await loadRepository();
  await repository.checkReadiness(1_000);
}

export function checkDatabaseReadiness(): Promise<void> {
  return checkDatabaseReadinessWith(getRepository);
}
```

The repository loader is shared by readiness and the full context. A readiness request creates only the pool. The first control-plane request reuses that exact repository, creates Runtime/Pump/Service once, waits for restart reconciliation, and clears the closed repository after a failed context initialization.

- [ ] **Step 5: Implement the readiness handler and thin Next.js Route**

Implement `handler.ts` exactly:

```ts
import { noStoreJson } from '../control-plane/http';

export function makeReadyHandler(input: {
  checkDatabase: () => Promise<void>;
}): () => Promise<Response> {
  return async function GET(): Promise<Response> {
    try {
      await input.checkDatabase();
      return noStoreJson({
        status: 'ready',
        database: 'ready',
      });
    } catch {
      return noStoreJson(
        {
          status: 'not-ready',
          database: 'unavailable',
        },
        { status: 503 },
      );
    }
  };
}
```

The handler intentionally does not call `errorResponse`: readiness has its own fixed non-secret `200/503` contract.

`route.ts`:

```ts
import { checkDatabaseReadiness } from '@/server/control-plane';
import { makeReadyHandler } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = makeReadyHandler({
  checkDatabase: checkDatabaseReadiness,
});
```

- [ ] **Step 6: Replace the obsolete local-owner environment contract**

In `.env.example`, replace `APP_OWNER_ID=local-owner` with:

```dotenv
AUTH_MODE=local
APP_OWNER_SUBJECT=local:owner
```

In `compose.yaml`, replace only the obsolete app environment entry:

```yaml
AUTH_MODE: ${AUTH_MODE:-local}
APP_OWNER_SUBJECT: ${APP_OWNER_SUBJECT:-local:owner}
```

Do not change `ports`, service names, images, volumes, or bind defaults.

- [ ] **Step 7: Run focused tests, Compose validation, typecheck, and build**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test vitest run \
  apps/web/src/server/control-plane.test.ts \
  apps/web/src/app/api/ready/handler.test.ts
docker run --rm ai-super-canvas:api-test \
  --filter @ai-super-canvas/web typecheck
docker compose --env-file .env.example config --quiet
docker build --tag ai-super-canvas:api-production .
```

Expected: focused tests, typecheck, Compose validation, and the Next.js production build all pass.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/web/src/server/control-plane.ts \
  apps/web/src/server/control-plane.test.ts \
  apps/web/src/app/api/ready \
  .env.example compose.yaml
git commit -m "feat(web): compose the persisted control plane"
```

---

### Task 4: Expose bootstrap and root Session write Routes

**Files:**
- Create: `apps/web/src/app/api/control-plane/handlers.ts`
- Create: `apps/web/src/app/api/control-plane/route-contract.test.ts`
- Create: `apps/web/src/app/api/control-plane/bootstrap/route.ts`
- Create: `apps/web/src/app/api/control-plane/sessions/route.ts`

**Interfaces:**
- Consumes: Task 1 HTTP helpers, Task 3 composition root, `SessionService.bootstrapLocalAlpha`, and `SessionService.createRootSession`.
- Produces:
  - `makeBootstrapHandler({ service, authSubject })`
  - `makeCreateSessionHandler({ service, actor })`
  - production POST Route exports for bootstrap and root Session creation.

- [ ] **Step 1: Write failing bootstrap and Session Route contract tests**

```ts
import type { ActorContext } from '@ai-super-canvas/core';
import { describe, expect, it, vi } from 'vitest';

import {
  makeBootstrapHandler,
  makeCreateSessionHandler,
} from './handlers';

const actor: ActorContext = {
  accountId: '22222222-2222-4222-8222-222222222222',
  authSubject: 'local:test-owner',
};

describe('control-plane write Route contracts', () => {
  it('bootstraps only with the injected server auth subject', async () => {
    const service = {
      bootstrapLocalAlpha: vi.fn().mockResolvedValue({
        accountId: actor.accountId,
        agentId: '33333333-3333-4333-8333-333333333333',
        agentBindingId: '44444444-4444-4444-8444-444444444444',
        workspaceId: '55555555-5555-4555-8555-555555555555',
        workflowId: '66666666-6666-4666-8666-666666666666',
        trunkRevisionId: '77777777-7777-4777-8777-777777777777',
      }),
    };
    const response = await makeBootstrapHandler({
      service: service as never,
      authSubject: actor.authSubject,
    })(new Request('http://localhost/api/control-plane/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: '23232323-2323-4323-8323-232323232323',
        displayName: '本地测试用户',
      }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accountId: actor.accountId,
      agentId: '33333333-3333-4333-8333-333333333333',
      agentBindingId: '44444444-4444-4444-8444-444444444444',
      workspaceId: '55555555-5555-4555-8555-555555555555',
      workflowId: '66666666-6666-4666-8666-666666666666',
      trunkRevisionId: '77777777-7777-4777-8777-777777777777',
    });
    expect(service.bootstrapLocalAlpha).toHaveBeenCalledWith({
      commandId: '23232323-2323-4323-8323-232323232323',
      authSubject: actor.authSubject,
      displayName: '本地测试用户',
    });
  });

  it('rejects a forged auth subject before calling the service', async () => {
    const service = { bootstrapLocalAlpha: vi.fn() };
    const response = await makeBootstrapHandler({
      service: service as never,
      authSubject: actor.authSubject,
    })(new Request('http://localhost/api/control-plane/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: '23232323-2323-4323-8323-232323232323',
        authSubject: 'attacker',
      }),
    }));
    expect(response.status).toBe(400);
    expect(service.bootstrapLocalAlpha).not.toHaveBeenCalled();
  });

  it('creates a root Session with the injected ActorContext', async () => {
    const service = {
      createRootSession: vi.fn().mockResolvedValue({
        sessionId: '20202020-2020-4020-8020-202020202020',
        nodeId: '21212121-2121-4121-8121-212121212121',
        status: 'active',
      }),
    };
    const response = await makeCreateSessionHandler({
      service: service as never,
      actor,
    })(new Request('http://localhost/api/control-plane/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: '24242424-2424-4424-8424-242424242424',
        workflowId: '25252525-2525-4525-8525-252525252525',
        agentBindingId: '26262626-2626-4626-8626-262626262626',
        title: '真实后端测试',
      }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      sessionId: '20202020-2020-4020-8020-202020202020',
      nodeId: '21212121-2121-4121-8121-212121212121',
      status: 'active',
    });
    expect(service.createRootSession).toHaveBeenCalledWith({
      actor,
      commandId: '24242424-2424-4424-8424-242424242424',
      workflowId: '25252525-2525-4525-8525-252525252525',
      agentBindingId: '26262626-2626-4626-8626-262626262626',
      title: '真实后端测试',
    });
  });
});
```

Extend the test imports with `ControlPlaneApplicationError`,
`AuthorizationError`, and `CommandPayloadConflictError`, then add these exact
transport/error cases. Do not assert on raw Zod issue arrays:

```ts
const validCreateSessionRequest = (): Request => new Request(
  'http://localhost/api/control-plane/sessions',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: '24242424-2424-4424-8424-242424242424',
      workflowId: '25252525-2525-4525-8525-252525252525',
      agentBindingId: '26262626-2626-4626-8626-262626262626',
      title: '真实后端测试',
    }),
  },
);

it.each([
  ['{', 'malformed_json'],
  [JSON.stringify({ commandId: 'not-a-uuid' }), 'invalid_request'],
  [JSON.stringify({
    commandId: '23232323-2323-4323-8323-232323232323',
    displayName: '',
  }), 'invalid_request'],
  [JSON.stringify({
    commandId: '23232323-2323-4323-8323-232323232323',
    accountId: actor.accountId,
  }), 'invalid_request'],
])('rejects invalid bootstrap body %s', async (body, code) => {
  const service = { bootstrapLocalAlpha: vi.fn() };
  const response = await makeBootstrapHandler({
    service: service as never,
    authSubject: actor.authSubject,
  })(new Request('http://localhost/api/control-plane/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code } });
  expect(service.bootstrapLocalAlpha).not.toHaveBeenCalled();
});

it('returns reconciliation as 202 without losing the receipt', async () => {
  const service = {
    createRootSession: vi.fn().mockRejectedValue(
      new ControlPlaneApplicationError(
        'command_requires_reconciliation',
        'Runtime command requires reconciliation',
        true,
        'receipt-3',
      ),
    ),
  };
  const response = await makeCreateSessionHandler({
    service: service as never,
    actor,
  })(validCreateSessionRequest());
  expect(response.status).toBe(202);
  expect(response.headers.get('retry-after')).toBe('2');
  expect(await response.json()).toMatchObject({
    commandReceiptId: 'receipt-3',
    error: { code: 'command_requires_reconciliation' },
  });
});

it.each([
  [new CommandPayloadConflictError('receipt'), 409, 'command_payload_conflict'],
  [new AuthorizationError(), 404, 'not_found'],
] as const)('maps a service failure without leaking it', async (
  reason,
  status,
  code,
) => {
  const service = { createRootSession: vi.fn().mockRejectedValue(reason) };
  const response = await makeCreateSessionHandler({
    service: service as never,
    actor,
  })(validCreateSessionRequest());
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
});
```

- [ ] **Step 2: Run the Route contract test and verify RED**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test \
  vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
```

Expected: FAIL because `handlers.ts` does not exist.

- [ ] **Step 3: Implement strict schemas and handler factories**

Use exact strict schemas:

```ts
const BootstrapSchema = z.object({
  commandId: z.uuid(),
  displayName: z.string().trim().min(1).max(120)
    .default('本地测试用户'),
}).strict();

const CreateSessionSchema = z.object({
  commandId: z.uuid(),
  workflowId: z.uuid(),
  agentBindingId: z.uuid(),
  title: z.string().trim().min(1).max(160),
}).strict();
```

Implement the two factories in `handlers.ts`:

```ts
import type { ActorContext } from '@ai-super-canvas/core';
import type { SessionService } from '@ai-super-canvas/control-plane';
import { z } from 'zod';

import { errorResponse, parseJson } from './http';

const BootstrapSchema = z.object({
  commandId: z.uuid(),
  displayName: z.string().trim().min(1).max(120)
    .default('本地测试用户'),
}).strict();

const CreateSessionSchema = z.object({
  commandId: z.uuid(),
  workflowId: z.uuid(),
  agentBindingId: z.uuid(),
  title: z.string().trim().min(1).max(160),
}).strict();

export function makeBootstrapHandler(input: {
  service: SessionService;
  authSubject: string;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const body = await parseJson(request, BootstrapSchema);
      const result = await input.service.bootstrapLocalAlpha({
        ...body,
        authSubject: input.authSubject,
      });
      return Response.json(result, { status: 200 });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export function makeCreateSessionHandler(input: {
  service: SessionService;
  actor: ActorContext;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const body = await parseJson(request, CreateSessionSchema);
      const result = await input.service.createRootSession({
        actor: input.actor,
        ...body,
      });
      return Response.json(result, { status: 201 });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}
```

Handlers never inspect DB or application errors; `errorResponse` is the sole mapping boundary.

- [ ] **Step 4: Add thin production Route modules**

Bootstrap Route:

```ts
import {
  getControlPlane,
  localAuthSubject,
} from '@/server/control-plane';
import { makeBootstrapHandler } from '../handlers';
import { errorResponse } from '../http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const authSubject = localAuthSubject();
    const { service } = await getControlPlane();
    return makeBootstrapHandler({
      service,
      authSubject,
    })(request);
  } catch (reason) {
    return errorResponse(reason);
  }
}
```

Create `sessions/route.ts` exactly:

```ts
import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';
import { makeCreateSessionHandler } from '../handlers';
import { errorResponse } from '../http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const [{ service }, actor] = await Promise.all([
      getControlPlane(),
      getLocalActorContext(),
    ]);
    return makeCreateSessionHandler({
      service,
      actor,
    })(request);
  } catch (reason) {
    return errorResponse(reason);
  }
}
```

Route-level composition errors must use the same outer `try/catch` and `errorResponse`; do not let an environment or database exception become a raw Next.js error page.

- [ ] **Step 5: Run focused tests, web checks, and production build**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test \
  vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
docker run --rm ai-super-canvas:api-test \
  --filter @ai-super-canvas/web lint
docker run --rm ai-super-canvas:api-test \
  --filter @ai-super-canvas/web typecheck
docker build --tag ai-super-canvas:api-production .
```

Expected: contract tests, lint, typecheck, and standalone production build pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/web/src/app/api/control-plane/handlers.ts \
  apps/web/src/app/api/control-plane/route-contract.test.ts \
  apps/web/src/app/api/control-plane/bootstrap/route.ts \
  apps/web/src/app/api/control-plane/sessions/route.ts
git commit -m "feat(web): expose persisted Session routes"
```

---

### Task 5: Expose Run, persisted event-page, and transcript Routes

**Files:**
- Modify: `apps/web/src/app/api/control-plane/handlers.ts`
- Modify: `apps/web/src/app/api/control-plane/route-contract.test.ts`
- Create: `apps/web/src/app/api/control-plane/sessions/[sessionId]/runs/route.ts`
- Create: `apps/web/src/app/api/control-plane/sessions/[sessionId]/transcript/route.ts`
- Create: `apps/web/src/app/api/control-plane/runs/[runId]/events/route.ts`

**Interfaces:**
- Consumes: Task 1 HTTP helpers, Task 3 composition, `SessionService.startRun`, `SessionService.getRunEvents`, and `SessionService.getSessionTranscript`.
- Produces:
  - `makeStartRunHandler({ service, actor })`
  - `makeRunEventsHandler({ service, actor })`
  - `makeTranscriptHandler({ service, actor })`
  - the three dynamic Next.js Routes.

- [ ] **Step 1: Write failing Run and persisted-read contract tests**

```ts
it('starts a Run for the path Session with server-owned identity', async () => {
  const service = {
    startRun: vi.fn().mockResolvedValue({
      runId: '30303030-3030-4030-8030-303030303030',
      status: 'running',
    }),
  };
  const handler = makeStartRunHandler({ service: service as never, actor });
  const response = await handler(
    new Request('http://localhost/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: '27272727-2727-4727-8727-272727272727',
        idempotencyKey: 'browser-run-1',
        content: '真实消息',
      }),
    }),
    { sessionId: '28282828-2828-4828-8828-282828282828' },
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    runId: '30303030-3030-4030-8030-303030303030',
    status: 'running',
  });
  expect(service.startRun).toHaveBeenCalledWith({
    actor,
    sessionId: '28282828-2828-4828-8828-282828282828',
    commandId: '27272727-2727-4727-8727-272727272727',
    idempotencyKey: 'browser-run-1',
    content: '真实消息',
  });
});

it('returns the sanitized terminal-aware event page unchanged', async () => {
  const page = {
    events: [{
      sequence: 2,
      eventType: 'run.completed',
      payload: { status: 'succeeded' },
      occurredAt: '1970-01-01T00:00:00.000Z',
    }],
    nextAfter: 2,
    terminal: { status: 'succeeded' as const },
  };
  const service = { getRunEvents: vi.fn().mockResolvedValue(page) };
  const response = await makeRunEventsHandler({
    service: service as never,
    actor,
  })(
    new Request('http://localhost/events?after=1'),
    { runId: '30303030-3030-4030-8030-303030303030' },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(page);
  expect(service.getRunEvents).toHaveBeenCalledWith({
    actor,
    runId: '30303030-3030-4030-8030-303030303030',
    after: 1,
  });
});

it('returns the stable persisted transcript DTO', async () => {
  const transcript = {
    sessionId: '29292929-2929-4929-8929-292929292929',
    status: 'active',
    messages: [],
    activeRun: null,
    reconciliationState: null,
    runtimeAvailability: 'unavailable' as const,
  };
  const service = { getSessionTranscript: vi.fn().mockResolvedValue(transcript) };
  const response = await makeTranscriptHandler({
    service: service as never,
    actor,
  })({ sessionId: transcript.sessionId });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(transcript);
  expect(service.getSessionTranscript).toHaveBeenCalledWith({
    actor,
    sessionId: transcript.sessionId,
  });
});
```

Extend the DB error imports with `ActiveRunConflictError` and
`RunIdempotencyConflictError`. Add these exact boundary cases:

```ts
const validRunBody = {
  commandId: '27272727-2727-4727-8727-272727272727',
  idempotencyKey: 'browser-run-1',
  content: '真实消息',
};

const validStartRunRequest = (
  overrides: Record<string, unknown> = {},
): Request => new Request('http://localhost/runs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...validRunBody, ...overrides }),
});

it.each([
  ['not-a-uuid', '0'],
  ['30303030-3030-4030-8030-303030303030', '-1'],
  ['30303030-3030-4030-8030-303030303030', '1.5'],
  ['30303030-3030-4030-8030-303030303030', 'not-a-number'],
])('rejects runId=%s after=%s', async (runId, after) => {
  const service = { getRunEvents: vi.fn() };
  const response = await makeRunEventsHandler({
    service: service as never,
    actor,
  })(
    new Request(`http://localhost/events?after=${after}`),
    { runId },
  );
  expect(response.status).toBe(400);
  expect(service.getRunEvents).not.toHaveBeenCalled();
});


it('rejects an invalid start-Run session path before reading the body', async () => {
  const service = { startRun: vi.fn() };
  const response = await makeStartRunHandler({
    service: service as never,
    actor,
  })(validStartRunRequest(), { sessionId: 'not-a-uuid' });
  expect(response.status).toBe(400);
  expect(service.startRun).not.toHaveBeenCalled();
});

it('rejects an invalid transcript session path', async () => {
  const service = { getSessionTranscript: vi.fn() };
  const response = await makeTranscriptHandler({
    service: service as never,
    actor,
  })({ sessionId: 'not-a-uuid' });
  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(service.getSessionTranscript).not.toHaveBeenCalled();
});

it('hides event-page authorization behind the stable 404', async () => {
  const service = {
    getRunEvents: vi.fn().mockRejectedValue(new AuthorizationError()),
  };
  const response = await makeRunEventsHandler({
    service: service as never,
    actor,
  })(
    new Request('http://localhost/events?after=0'),
    { runId: '30303030-3030-4030-8030-303030303030' },
  );
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    error: {
      code: 'not_found',
      message: 'Resource not found',
      retryable: false,
    },
  });
});
it.each([
  { sessionId: '28282828-2828-4828-8828-282828282828' },
  { accountId: actor.accountId },
  { model: 'gpt-5' },
  { toolPolicy: { allow: ['shell'] } },
])('rejects forged Run field %j', async (extra) => {
  const service = { startRun: vi.fn() };
  const response = await makeStartRunHandler({
    service: service as never,
    actor,
  })(validStartRunRequest(extra), {
    sessionId: '28282828-2828-4828-8828-282828282828',
  });
  expect(response.status).toBe(400);
  expect(service.startRun).not.toHaveBeenCalled();
});

it.each([
  ['empty content', { content: '' }],
  ['oversized content', { content: 'x'.repeat(20_001) }],
  ['empty idempotency key', { idempotencyKey: '' }],
  ['oversized idempotency key', { idempotencyKey: 'x'.repeat(161) }],
])('rejects %s', async (_label, overrides) => {
  const service = { startRun: vi.fn() };
  const response = await makeStartRunHandler({
    service: service as never,
    actor,
  })(validStartRunRequest(overrides), {
    sessionId: '28282828-2828-4828-8828-282828282828',
  });
  expect(response.status).toBe(400);
  expect(service.startRun).not.toHaveBeenCalled();
});

it.each([
  [
    new ActiveRunConflictError(
      '28282828-2828-4828-8828-282828282828',
    ),
    'active_run_conflict',
  ],
  [
    new RunIdempotencyConflictError('browser-run-1'),
    'run_idempotency_conflict',
  ],
] as const)('maps %s to its distinct 409 code', async (reason, code) => {
  const service = { startRun: vi.fn().mockRejectedValue(reason) };
  const response = await makeStartRunHandler({
    service: service as never,
    actor,
  })(validStartRunRequest(), {
    sessionId: '28282828-2828-4828-8828-282828282828',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code } });
});

it('hides transcript authorization and internal references', async () => {
  const service = {
    getSessionTranscript: vi.fn().mockRejectedValue(new AuthorizationError()),
  };
  const response = await makeTranscriptHandler({
    service: service as never,
    actor,
  })({ sessionId: '29292929-2929-4929-8929-292929292929' });
  expect(response.status).toBe(404);
  const serialized = JSON.stringify(await response.json());
  expect(serialized).not.toContain(actor.accountId);
  expect(serialized).not.toContain('externalSessionRef');
  expect(serialized).not.toContain('externalRunRef');
});
  expect(response.headers.get('cache-control')).toBe('no-store');
```

In the successful event-page test, also assert:

```ts
expect(response.headers.get('content-type')).not.toContain('text/event-stream');
```

- [ ] **Step 2: Run contract tests and verify RED**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test \
  vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
```

Expected: FAIL because the three factories are not exported.

- [ ] **Step 3: Implement the three handler factories**

Use the exact Run body schema:

```ts
const StartRunSchema = z.object({
  commandId: z.uuid(),
  idempotencyKey: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(20_000),
}).strict();
```

Replace the existing HTTP-helper import in `handlers.ts` and append these exact factories:

```ts
import {
  errorResponse,
  noStoreJson,
  parseAfter,
  parseJson,
  parseUuid,
} from './http';

export function makeStartRunHandler(input: {
  service: SessionService;
  actor: ActorContext;
}): (
  request: Request,
  params: { sessionId: string },
) => Promise<Response> {
  return async (request, params) => {
    try {
      const sessionId = parseUuid(params.sessionId);
      const body = await parseJson(request, StartRunSchema);
      const result = await input.service.startRun({
        actor: input.actor,
        sessionId,
        ...body,
      });
      return Response.json(result, { status: 202 });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export function makeRunEventsHandler(input: {
  service: SessionService;
  actor: ActorContext;
}): (
  request: Request,
  params: { runId: string },
) => Promise<Response> {
  return async (request, params) => {
    try {
      const runId = parseUuid(params.runId);
      const after = parseAfter(request);
      const result = await input.service.getRunEvents({
        actor: input.actor,
        runId,
        after,
      });
      return noStoreJson(result);
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export function makeTranscriptHandler(input: {
  service: SessionService;
  actor: ActorContext;
}): (
  params: { sessionId: string },
) => Promise<Response> {
  return async (params) => {
    try {
      const sessionId = parseUuid(params.sessionId);
      const result = await input.service.getSessionTranscript({
        actor: input.actor,
        sessionId,
      });
      return noStoreJson(result);
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}
```

The event handler calls only `SessionService.getRunEvents`; no Route or handler imports `RuntimeAdapter.streamRunEvents` or `ControlPlaneRepository.listRunEvents`.

- [ ] **Step 4: Implement Next.js 16 dynamic Route modules**

Each dynamic Route explicitly awaits params:

```ts
type SessionRouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(
  request: Request,
  context: SessionRouteContext,
): Promise<Response> {
  try {
    const [{ service }, actor, params] = await Promise.all([
      getControlPlane(),
      getLocalActorContext(),
      context.params,
    ]);
    return makeStartRunHandler({ service, actor })(request, params);
  } catch (reason) {
    return errorResponse(reason);
  }
}
```

The start-Run module also exports `runtime = 'nodejs'`. Create the two GET modules exactly:

```ts
// sessions/[sessionId]/transcript/route.ts
import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';
import { makeTranscriptHandler } from '@/app/api/control-plane/handlers';
import { errorResponse } from '@/app/api/control-plane/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SessionRouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(
  _request: Request,
  context: SessionRouteContext,
): Promise<Response> {
  try {
    const [{ service }, actor, params] = await Promise.all([
      getControlPlane(),
      getLocalActorContext(),
      context.params,
    ]);
    return makeTranscriptHandler({ service, actor })(params);
  } catch (reason) {
    return errorResponse(reason);
  }
}
```

```ts
// runs/[runId]/events/route.ts
import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';
import { makeRunEventsHandler } from '@/app/api/control-plane/handlers';
import { errorResponse } from '@/app/api/control-plane/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RunRouteContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(
  request: Request,
  context: RunRouteContext,
): Promise<Response> {
  try {
    const [{ service }, actor, params] = await Promise.all([
      getControlPlane(),
      getLocalActorContext(),
      context.params,
    ]);
    return makeRunEventsHandler({ service, actor })(request, params);
  } catch (reason) {
    return errorResponse(reason);
  }
}
```

- [ ] **Step 5: Run focused tests and all web checks**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test \
  vitest run apps/web/src/app/api/control-plane/route-contract.test.ts
docker run --rm ai-super-canvas:api-test \
  --filter @ai-super-canvas/web lint
docker run --rm ai-super-canvas:api-test \
  --filter @ai-super-canvas/web typecheck
docker build --tag ai-super-canvas:api-production .
```

Expected: all Route contracts and web checks pass; the production image builds.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/web/src/app/api/control-plane
git commit -m "feat(web): expose persisted Run reads"
```

---

### Task 6: Close the API PR boundary and run the full gate

**Files:**
- Modify production files only if a failing gate requires a correction within this plan's scope.
- Documentation is already committed by Task 0; Task 6 must leave it unchanged.

**Interfaces:**
- Consumes: all preceding Task outputs.
- Produces: one review-ready API PR with no browser page, no real Agent provider, and no deployment exposure change.

- [ ] **Step 1: Verify the complete Route and dependency boundary**

```bash
git grep -n '@ai-super-canvas/control-plane' -- apps/web
git grep -n -E 'streamRunEvents|listRunEvents|text/event-stream' -- apps/web/src/app/api
git diff --name-only origin/main...HEAD
git diff -- compose.yaml .env.example
```

Expected:

- the web package and server Route code use only public control-plane exports;
- no API Route calls Runtime streaming or Repository event reads directly;
- no `text/event-stream` appears;
- no `apps/web/src/app/control-plane-test`, client component, CSS module, or Playwright file exists in the diff;
- Compose ports, service count, image, and volumes are unchanged;
- no migration or schema file changed.

- [ ] **Step 2: Run frozen install, lint, typecheck, unit tests, and production build on Node 24**

```bash
docker build --target test --tag ai-super-canvas:api-test .
docker run --rm ai-super-canvas:api-test install --frozen-lockfile
docker run --rm ai-super-canvas:api-test lint
docker run --rm ai-super-canvas:api-test typecheck
docker run --rm ai-super-canvas:api-test test
docker build --tag ai-super-canvas:api-production .
```

Expected: frozen install is already up to date; all workspace checks and the standalone Next.js build pass.

- [ ] **Step 3: Run the complete PostgreSQL integration gate**

```bash
bash scripts/test-integration.sh
```

Expected: migrations 0000 through 0007 apply to the isolated database and the complete integration suite passes, including the new readiness probe.

- [ ] **Step 4: Validate Compose and smoke the production image**

```bash
docker compose --env-file .env.example config --quiet

project="ai-super-canvas-api-smoke-$$"
app="ai-super-canvas-api-smoke-$$"
compose=(docker compose -p "$project" -f compose.control-plane-test.yaml)
cleanup() {
  docker rm --force "$app" >/dev/null 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans
}
trap cleanup EXIT

"${compose[@]}" up -d postgres-test
"${compose[@]}" run --rm --build test \
  --filter @ai-super-canvas/db db:migrate
docker run --detach \
  --name "$app" \
  --network "${project}_default" \
  --env DATABASE_URL=postgres://canvas_s1_app:canvas-app-password@postgres-test:5432/canvas_s1_test \
  --env AUTH_MODE=local \
  --env APP_OWNER_SUBJECT=local:owner \
  --publish 127.0.0.1::3000 \
  ai-super-canvas:api-production
smoke_port="$(docker port "$app" 3000/tcp | sed -n 's/.*://p')"

for _attempt in $(seq 1 30); do
  ready="$(curl --silent --show-error --include \
    "http://127.0.0.1:${smoke_port}/api/ready" || true)"
  if printf '%s' "$ready" | grep -q '200 OK'; then break; fi
  sleep 1
done
printf '%s' "$ready" | grep -qi '^cache-control: no-store'
printf '%s' "$ready" | grep -q '"status":"ready"'
printf '%s' "$ready" | grep -q '"database":"ready"'

"${compose[@]}" stop postgres-test
not_ready="$(curl --silent --show-error --include \
  "http://127.0.0.1:${smoke_port}/api/ready")"
printf '%s' "$not_ready" | grep -q '503 Service Unavailable'
printf '%s' "$not_ready" | grep -qi '^cache-control: no-store'
printf '%s' "$not_ready" | grep -q '"status":"not-ready"'
printf '%s' "$not_ready" | grep -q '"database":"unavailable"'
```

Expected: the actual production Route returns `200/no-store` against PostgreSQL and `503/no-store` after PostgreSQL stops. The EXIT trap removes only this unique app container and Compose project even when an assertion fails.

- [ ] **Step 5: Inspect the complete branch diff and run final reviews**

```bash
git fetch origin --prune
git rev-list --left-right --count HEAD...origin/main
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git log --oneline origin/main..HEAD
git status --short
```

Expected: the branch is based on current `origin/main`; only the plan/spec amendment, API/server files, readiness Repository method/test, environment variable rename, web dependencies, and lockfile are present. Worktree is clean after commits.

Run an independent whole-branch correctness/security review. Resolve every Critical or Important finding and re-run covering tests before proceeding.

- [ ] **Step 6: Push and open a Draft PR**

```bash
git push -u origin agent/server-persisted-session-api
```

Then create the Draft PR with the connected GitHub App using these exact fields:

```text
repository_full_name: ArchitectureWorld/ai-super-canvas
base: main
head: agent/server-persisted-session-api
draft: true
title: feat(web): expose persisted session API
body:
## What changed
- Added server-only globalThis composition with server-owned local identity.
- Added bootstrap, Session, Run, JSON event-page, transcript, and database readiness Routes.
- Added cancellable PostgreSQL readiness and strict sanitized HTTP contracts.

## Boundary
- Migration 0007 remains a mandatory deployment prerequisite.
- The Runtime is DeterministicFakeRuntime, not a real model provider.
- No page, LAN exposure, new port, new service, or browser E2E is included.
- Restricted production role wiring remains a deployment hard gate.

## Verification
- Unit: <insert exact passing count>
- PostgreSQL integration: <insert exact passing count>
- Lint/typecheck/build: <insert exact commands and PASS>
- Production /api/ready smoke: 200 with DB, 503 without DB, both no-store.
```

Wait for Quality, Integration, and CodeQL on the pushed HEAD. When all are green and final review has no Critical/Important findings, mark the PR Ready for review. Do not merge without user approval.

---

## Spec Coverage Self-Review

| Approved requirement | Implemented by |
| --- | --- |
| server-only shared composition root | Task 3 |
| server-owned `APP_OWNER_SUBJECT` and current ActorContext | Tasks 3–5 |
| bootstrap and root Session APIs | Task 4 |
| Run creation API | Task 5 |
| persisted JSON event pagination through `SessionService` | Task 5 |
| persisted transcript with Runtime availability | Task 5 |
| database `SELECT 1` readiness with short timeout | Tasks 2–3 |
| stable sanitized errors | Task 1 |
| malformed JSON/schema/UUID/cursor contracts | Tasks 1, 4–5 |
| reconciliation/persistence-unconfirmed 202 semantics | Tasks 1, 4–5 |
| conflicts and authorization hiding | Tasks 1, 4–5 |
| no browser page, SSE, Hermes, real model, new port or service | Task 6 |
| Node 24 full gate and PostgreSQL integration | Task 6 |

## Intentional Deferrals

- `/control-plane-test`, its client state machine, polling UI, and page tests belong to the Test Page PR.
- Browser-to-PostgreSQL Golden Path, refresh/restart browser E2E, and execution evidence belong to the Golden Path PR.
- Migration automation, restricted production role wiring, Nginx/LAN exposure, and trusted-LAN access control belong to the deployment/configuration stage after the Test Page PR.
- Hermes, OpenAI, Letta, and other real Runtime providers require separate designs and PRs.

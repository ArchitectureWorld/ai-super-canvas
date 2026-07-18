# Prepared Run Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prepared Run replay authoritative, expose stable Run conflict errors, and make authorized context loading index-backed.

**Architecture:** Keep the Session's active primary Runtime reference as the authoritative dispatch source because this repository creates it once and has no rotation path. Centralize authorized context loading into four scope-specific `UNION ALL` branches backed by four partial indexes, while preserving current ordering and visibility semantics.

**Tech Stack:** TypeScript 6, postgres.js, PostgreSQL 18, Drizzle ORM/Kit, Vitest, Docker Compose.

---

### Task 1: Authoritative Prepared Run replay

**Files:**
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`

- [x] **Step 1: Write the failing replay tampering test**

  Prepare a Run, update its receipt with `jsonb_set` so `runtime.binding.isolationKey`, `runtime.externalSessionRef`, and `runtime.expectedHistoryDigest` remain strings but differ from database values, then expect each replay to reject with `/invalid persisted Run command result payload/i`.

- [x] **Step 2: Run the replay test and verify RED**

  Run the repository integration file filtered to the new tampering test. Expected: replay resolves because only `canvasAgentBindingId` and JSON types are currently checked.

- [x] **Step 3: Add authoritative replay columns and comparisons**

  Extend the replay row query with the joined binding and active Runtime reference:

  ```sql
  JOIN agent_bindings binding ON binding.id = run.agent_binding_id
  JOIN session_runtime_refs runtime_ref
    ON runtime_ref.session_id = run.session_id
   AND runtime_ref.agent_binding_id = run.agent_binding_id
   AND runtime_ref.is_primary = true
   AND runtime_ref.status = 'active'
  ```

  Compare the parsed binding and Runtime reference values against these columns in a small helper before returning the replayed result.

- [x] **Step 4: Run the replay test and verify GREEN**

  Run the same filtered test. Expected: all legal-type tampering cases reject with the stable invalid-payload message.

### Task 2: Stable active Run and idempotency conflicts

**Files:**
- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`

- [x] **Step 1: Write the failing active Run conflict test**

  Leave the first Run queued, start a second command with a new idempotency key, assert an exported error with `code === 'active_run_conflict'`, and assert Message/Run/start-run receipt counts are unchanged.

- [x] **Step 2: Run the active conflict test and verify RED**

  Expected: postgres.js exposes unique violation `23505` for `runs_one_active_per_session` instead of the requested domain error.

- [x] **Step 3: Add stable domain errors and exact database mapping**

  Add minimal exported classes:

  ```ts
  export class ActiveRunConflictError extends Error {
    readonly code = 'active_run_conflict' as const;
  }

  export class RunIdempotencyConflictError extends Error {
    readonly code = 'run_idempotency_conflict' as const;
  }
  ```

  Under the Session row lock, check idempotency and active status before Message insertion. Wrap the transaction so only `postgres.PostgresError` with `code === '23505'` and exact `constraint_name` values maps to the matching domain error.

- [x] **Step 4: Exercise the constraint fallback and verify GREEN**

  Use concurrent starts to prove the precheck and exact unique-constraint fallback both return stable domain errors without leaking PostgreSQL details.

### Task 3: Authorized context indexes and shared loader

**Files:**
- Modify: `packages/db/src/schema/authorization.ts`
- Modify: `packages/db/src/schema/schema-contract.test.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Create: `packages/db/migrations/0005_prepared_run_invariants.sql`
- Create: `packages/db/migrations/meta/0005_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

- [x] **Step 1: Write failing index availability assertions**

  Assert the Drizzle table config exposes four named context authorization indexes and use `EXPLAIN` with sequential scans disabled to assert every scope branch can use its corresponding index.

- [x] **Step 2: Run the assertions and verify RED**

  Expected: the named indexes are missing and the plan cannot mention them.

- [x] **Step 3: Add partial indexes and extract the shared loader**

  Add account, agent, workflow, and session indexes beginning with the scope key, followed by visibility/expiry/order columns, each restricted to its fixed scope. Implement one `loadAuthorizedContextRows` helper with four mutually exclusive `UNION ALL` branches and a final `ORDER BY created_at, id`; call it from both `prepareRun` and `getSessionRuntimeContext`.

- [x] **Step 4: Generate and inspect the migration**

  Run:

  ```bash
  cd packages/db
  DATABASE_URL=postgres://migration:unused@127.0.0.1:1/canvas_s1_test corepack pnpm drizzle-kit generate --name prepared_run_invariants
  ```

  Expected: host-visible `0005_prepared_run_invariants.sql`, its snapshot, and a journal entry containing all four indexes.

- [x] **Step 5: Run index assertions and repository tests GREEN**

  Rebuild the test image, migrate a clean PostgreSQL volume, then run schema and repository integration tests.

### Task 4: Final verification and commit

**Files:**
- Verify all files changed by Tasks 1-3.

- [x] **Step 1: Run full verification**

  Run repository and schema integration suites, DB unit tests, typecheck, lint, a clean-database migration, and `git diff --check`. Expected: every command exits zero with no failures.

- [x] **Step 2: Review scope and commit**

  Confirm no port, `/home/youran/data`, or Hermes files changed, then commit all reviewed changes with:

  ```bash
  git commit -m "fix(db): enforce prepared run invariants"
  ```

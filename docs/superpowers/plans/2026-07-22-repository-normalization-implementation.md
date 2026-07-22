# Repository Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden and publish the in-progress control-plane work, normalize the public repository, and consolidate the linear feature branches into protected `main` through PR #5.

**Architecture:** Keep PR #5 as the only integration branch. Add exact event fingerprints at the persistence boundary, bound event pagination, encapsulate disposable database testing in one script, patch vulnerable transitive dependencies through pnpm overrides, and apply public-repository governance before a squash merge.

**Tech Stack:** TypeScript 6, Node.js 24.18, pnpm 11.12, Vitest 4, PostgreSQL 18, Drizzle ORM, Docker Compose, GitHub Actions, Next.js 16.

## Global Constraints

- All Linux repository work is performed over SSH in `/home/youran/Development/AI-Super-Canvas`.
- Preserve and include the four pre-existing uncommitted database files; do not discard or overwrite them.
- Use `feat/risk-first-vertical-slice` and its existing linked worktree as the implementation branch.
- Follow TDD for behavior changes: observe the targeted test fail before production changes, then pass.
- Never merge PR #4 separately because it is a strict ancestor of PR #5.
- Do not claim browser E2E passed unless a fresh Playwright run completes successfully.
- Do not perform the large-file module split in this merge.

---

### Task 1: Exact Runtime Event Idempotency and Bounded Pagination

**Files:**
- Modify: `packages/db/src/repositories/control-plane-repository.ts`
- Modify: `packages/db/src/repositories/control-plane-run-types.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.ts`
- Modify: `packages/db/src/repositories/postgres-control-plane-repository.integration.test.ts`
- Modify: `packages/db/src/schema/execution.ts`
- Create: `packages/db/migrations/0006_runtime_event_fingerprint.sql`
- Modify/Create: `packages/db/migrations/meta/*` as produced by Drizzle

**Interfaces:**
- Produces: `RuntimeEventConflictError` with code `runtime_event_conflict`.
- Produces: `listRunEvents({ actor, runId, after, limit? })`, default limit 100, valid range 1-100.
- Persists: non-null `run_events.event_fingerprint` for exact replay comparison.

- [ ] **Step 1: Add failing conflict and pagination integration tests**

Add tests that ingest an event, replay the same key with a different payload/message/terminal envelope, and assert `RuntimeEventConflictError` plus unchanged rows. Add three events and assert `limit: 2` returns exactly two; assert limits 0 and 101 reject.

```ts
await expect(repository.ingestRuntimeEvent({
  actor,
  runId,
  event: { ...originalEvent, payload: { delta: 'conflict' } },
})).rejects.toMatchObject({ code: 'runtime_event_conflict' });

await expect(repository.listRunEvents({ actor, runId, after: 0, limit: 0 }))
  .rejects.toThrow('Run event limit must be an integer between 1 and 100');
expect(await repository.listRunEvents({ actor, runId, after: 0, limit: 2 }))
  .toHaveLength(2);
```

- [ ] **Step 2: Run the targeted integration test and observe RED**

Run the disposable Compose database, apply migrations, then run only `postgres-control-plane-repository.integration.test.ts`. Expected: failures because conflicting replays currently return the old event and `limit` is not implemented.

- [ ] **Step 3: Add the schema column and migration**

Define `eventFingerprint: text('event_fingerprint').notNull()` on `runEvents`. Generate a tracked migration, review it, and ensure existing rows receive a deterministic backfill before `NOT NULL` is enforced.

- [ ] **Step 4: Implement exact replay and bounded reads**

Fingerprint the complete canonical input event, store it on insert, select it on replay, and throw `RuntimeEventConflictError` on mismatch. Resolve `const limit = input.limit ?? 100`, validate 1-100, and add `LIMIT ${limit}`.

- [ ] **Step 5: Run GREEN verification**

Run the targeted integration test, package typecheck, package lint, and full disposable integration suite. Expected: all pass.

- [ ] **Step 6: Commit only Task 1 files**

```bash
git commit -m "feat(db): persist exact runtime event streams"
```

### Task 2: Reproducible Integration Gate and Patched Dependencies

**Files:**
- Create: `scripts/test-integration.sh`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/quality.yml`

**Interfaces:**
- Produces: `pnpm test:integration:docker` as the authoritative disposable integration command.
- Produces: GitHub Actions job names `verify` and `integration`.

- [ ] **Step 1: Add a failing script contract test**

Extend `packages/db/src/testing/control-plane-compose.test.ts` to require the root command and script phases: Compose cleanup, database start, migration, integration test, and trap cleanup.

- [ ] **Step 2: Run the contract test and observe RED**

Run `vitest packages/db/src/testing/control-plane-compose.test.ts`. Expected: failure because the script and root command do not exist.

- [ ] **Step 3: Add the authoritative script**

```bash
#!/usr/bin/env bash
set -euo pipefail
project="${COMPOSE_PROJECT_NAME:-ai-super-canvas-s1-test}"
compose=(docker compose -p "$project" -f compose.control-plane-test.yaml)
cleanup() { "${compose[@]}" down --volumes --remove-orphans; }
trap cleanup EXIT
cleanup
"${compose[@]}" up -d postgres-test
"${compose[@]}" run --rm --build test --filter @ai-super-canvas/db db:migrate
"${compose[@]}" run --rm test test:integration
```

- [ ] **Step 4: Patch production dependencies**

Add pnpm overrides for `sharp` 0.35.3 and `postcss` 8.5.21, regenerate the lockfile with pnpm 11.12 in Node 24.18, and confirm `pnpm why` resolves the patched versions.

- [ ] **Step 5: Add CI integration and audit gates**

Add `pnpm audit --prod --audit-level moderate` to `verify`. Add an `integration` Ubuntu job that checks out the repository and runs `bash ./scripts/test-integration.sh`.

- [ ] **Step 6: Verify Task 2**

Run the contract test, `pnpm audit --prod --audit-level moderate`, the authoritative integration command, lint, typecheck, unit tests, and build in the declared Docker toolchain.

- [ ] **Step 7: Commit Task 2**

```bash
git commit -m "ci: enforce integration and dependency gates"
```

### Task 3: Public Repository Standards and Review Record

**Files:**
- Create: `.editorconfig`
- Create: `.gitattributes`
- Create: `.github/CODEOWNERS`
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/codeql.yml`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Modify: `README.md`
- Create: `docs/reviews/2026-07-22-deep-repository-review.md`

**Interfaces:**
- Documents: exact bootstrap, unit, integration, build, and known E2E status.
- Normalizes: UTF-8/LF text and final newline across supported editors and Git.

- [ ] **Step 1: Add a repository standards contract test**

Extend an existing lightweight repository contract test to assert the required files exist and the README names `test:integration:docker` and the prototype limitation.

- [ ] **Step 2: Run the contract test and observe RED**

Expected: failure because the public-repository files are absent.

- [ ] **Step 3: Add standards and automation files**

Use LF for text, four-space Markdown continuation indentation only where required, weekly npm/GitHub Actions Dependabot updates, and CodeQL `javascript-typescript` analysis on pushes to `main`, pull requests, and a weekly schedule.

- [ ] **Step 4: Rewrite README operational sections and add review record**

Clearly label the UI as a local-storage prototype, add Node/pnpm/Docker prerequisites, `.env` setup, commands, architecture links, security contact, and testing matrix. Record all audit evidence, remediated findings, and deferred large-file/E2E/readiness work.

- [ ] **Step 5: Verify formatting and repository contracts**

Run `git diff --check`, the contract test, lint, typecheck, and Markdown link/path checks using tracked files.

- [ ] **Step 6: Commit Task 3**

```bash
git commit -m "docs: normalize public repository standards"
```

### Task 4: Publish, Protect, Consolidate, and Verify

**Files:**
- Modify: GitHub repository settings (not tracked files)
- Modify: PR #5 state and description
- Close: PR #4 as superseded

**Interfaces:**
- Produces: protected `main` with required `verify` and `integration` checks.
- Produces: one squash merge from PR #5 and no duplicate PR #4 merge.

- [ ] **Step 1: Verify branch scope before push**

Run `git status -sb`, `git diff --check`, `git log main..HEAD`, full Docker lint/typecheck/unit/integration/build, and production dependency audit. Expected: clean worktree and all checks pass.

- [ ] **Step 2: Push and update PR #5**

Push `feat/risk-first-vertical-slice`, update its title/body with the complete normalization scope and verification evidence, and mark it ready for review.

- [ ] **Step 3: Enable public repository safety settings**

Set a concise description, enable delete-branch-on-merge and squash-only merges, vulnerability alerts, automated security fixes, secret scanning, push protection, and private vulnerability reporting when supported.

- [ ] **Step 4: Wait for and inspect all PR checks**

Require fresh success for `verify`, `integration`, and CodeQL before merge. Inspect annotations and logs for any failure.

- [ ] **Step 5: Perform final whole-branch review**

Review `git merge-base main HEAD..HEAD` against this plan. Fix every Critical or Important finding and rerun its covering tests.

- [ ] **Step 6: Configure `main` protection and squash-merge PR #5**

Require PR changes, strict `verify` and `integration` checks, conversation resolution, linear history, no force pushes, and no branch deletion. Squash-merge PR #5 and delete its remote branch.

- [ ] **Step 7: Close superseded PR #4 and synchronize Linux `main`**

Comment that PR #4 is fully contained in merged PR #5, close it, delete its remote branch, fetch/prune, and update the main checkout with `git pull --ff-only`.

- [ ] **Step 8: Final verification**

Confirm `origin/main` contains the squash commit, both PR states are correct, remote feature branches are gone, branch protection/settings are active, the main worktree is clean, and the final GitHub checks are successful.

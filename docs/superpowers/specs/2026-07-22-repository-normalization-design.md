# Repository Normalization and Branch Consolidation Design

**Date:** 2026-07-22

**Approved scope:** Include the four existing uncommitted control-plane files in the current normalization and merge. The user explicitly authorized direct execution after the audit.

## Goal

Turn `feat/risk-first-vertical-slice` into the single reviewed integration branch, close the fully superseded `feat/feature-01-mvp` line, and leave public `main` reproducible, protected, documented, and free of known production dependency advisories at moderate severity or above.

## Current State

- Branch history is linear: `main` -> `feat/feature-01-mvp` -> `feat/risk-first-vertical-slice`.
- PR #4 is fully contained in PR #5 and must not be merged separately.
- Local `feat/risk-first-vertical-slice` is eight commits ahead of its remote and has four intended uncommitted database files.
- Clean `e91038d` passes lint, typecheck, 154 unit tests, 56 Postgres integration tests, and the production build.
- The public repository has no `main` protection, ruleset, dependency alerts, secret scanning, or code scanning.
- `pnpm audit --prod` reports a high-severity `sharp` advisory and a moderate `postcss` advisory through Next.js.
- CI does not run the Postgres integration suite or browser E2E suite.

## Approaches Considered

### A. Merge the committed branch immediately

This is the smallest change, but it leaves the four control-plane files outside Git, known dependency advisories unresolved, and public-repository protections absent. Rejected.

### B. Risk-first consolidation in PR #5 (selected)

Harden and commit the in-progress Runtime event work, fix production dependency advisories, make database integration reproducible in CI, add public repository standards, then push and squash-merge PR #5. Close PR #4 as superseded. This preserves all useful history on the feature branch while presenting one coherent commit on `main`.

### C. Rewrite or split all large modules before merging

Splitting the 3,000+ line repository and contract test modules would improve maintainability, but mixing that refactor with concurrency-sensitive Runtime event completion materially increases merge risk. Defer the split to a follow-up issue after the branch is safely integrated.

## Runtime Event Design

Runtime event idempotency is exact, not key-only. A `runtime_event_key` replay must return the existing row only when a canonical fingerprint of the complete persistable event matches. A conflicting replay raises a stable `RuntimeEventConflictError` and leaves the event, message projection, and Run state unchanged.

The fingerprint is stored in a new non-null `run_events.event_fingerprint` column. Existing rows are backfilled deterministically by the migration before the constraint becomes non-null. New writes calculate the fingerprint from the event envelope using the repository's canonical JSON hashing utility.

Run-event reads remain cursor-based but gain a bounded `limit`: default 100, accepted range 1-100. This prevents unbounded history reads without breaking existing callers.

## Verification and CI Design

Add a repository script that owns the disposable Compose lifecycle: clean old test resources, start `postgres-test`, apply tracked migrations, run the integration suite, and always remove the volume. CI runs this as a separate `integration` job.

Production dependencies are forced to patched `sharp` and `postcss` releases through pnpm overrides until Next.js adopts compatible patched ranges. The lockfile is regenerated in the declared Node 24.18/pnpm 11.12 environment. CI audits production dependencies at moderate severity.

Browser E2E remains a documented follow-up gate because the first isolated browser installation did not finish within the review window. It is not represented as passing.

## Public Repository Design

Add line-ending and editor defaults, contribution and security policies, Dependabot configuration, CodeQL analysis, and an operational README with explicit prototype limitations and authoritative test commands.

Repository settings will prefer squash merges, automatically delete merged branches, enable vulnerability alerts, automated security fixes, secret scanning, push protection, and private vulnerability reporting where GitHub permits. `main` will require PR-based changes plus the `verify` and `integration` status checks, while allowing the owner to complete the current reviewed merge without requiring a self-approval.

## Merge Design

Push the normalized feature branch, mark PR #5 ready, wait for all required checks, review the complete `main...HEAD` range, and squash-merge PR #5. Close PR #4 with a superseded explanation and delete its remote branch only after verifying it is an ancestor of the merged branch. Update the Linux `main` checkout with `--ff-only` and verify the final tree and GitHub state.

## Deferred Work

- Split the oversized Postgres repository, integration contract, and AI runtime contract suite by bounded responsibility.
- Add a stable, cached Playwright browser image and make E2E a required check.
- Separate liveness and database-backed readiness endpoints when the web application starts serving control-plane traffic.

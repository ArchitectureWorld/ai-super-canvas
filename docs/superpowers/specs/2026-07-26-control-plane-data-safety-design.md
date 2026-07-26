# Control Plane Data Safety Design

## Status

- Date: 2026-07-26
- Approved direction: execute the review plan in risk order
- Delivery branch: `codex/control-plane-data-safety`
- Baseline: `main@edc20750beac2bb6b1954410ab1ff48a4e915827`

## Goal

Close three persistence gaps before exposing the control plane through HTTP:

1. Backfill `sessions.transcript_version` for databases written by the legacy
   Message ordinal allocator.
2. Let reconciliation atomically adopt a Runtime Run that is known to exist.
3. Prevent an old Run from syncing its terminal history digest into a replacement
   Runtime Session reference.

The result must preserve server-owned identity, exact Runtime references,
transactional receipt/Run/compensation state, and safe replay after restart.

## Non-goals

- No Route Handler, public API, browser page, or `localStorage` change.
- No Hermes integration or architecture change.
- No service port, Docker port, or runtime deployment change.
- No multi-process event-pump lease.
- No unrelated schema or Repository refactor.

## Design 1: Legacy transcript counter backfill

### Problem

The legacy allocator used `MAX(messages.ordinal) + 1` and did not advance
`sessions.transcript_version`. The current allocator increments
`transcript_version` and uses the previous value as the next ordinal. A database
with existing Messages and a stale counter can therefore reuse ordinal `0` and
violate `messages_session_ordinal_unique`.

### Migration

Create custom migration `0008_transcript_version_backfill.sql`. It takes an
`EXCLUSIVE` lock on `sessions`, computes each Session's Message frontier, and
only advances counters that lag behind:

```sql
LOCK TABLE "sessions" IN EXCLUSIVE MODE;

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

The migration does not lower an already-ahead counter, does not change empty
Sessions, and is SQL-idempotent. Integer overflow fails closed and rolls back.
Production rollout must stop old writers, apply the migration, then start the
new application.

### Proof

An integration test creates a disposable temporary database, applies real
migrations `0000..0007`, writes Messages with the historical allocator while
leaving the counter at its schema default, then applies the complete migration
set. It proves:

- ordinals `0,1` advance the counter from `0` to `2`;
- the next real `prepareRun` writes ordinal `2` and advances the counter to `3`;
- an empty Session remains at `0`;
- a counter already at `7` is not reduced;
- rerunning the migrator does not change the results.

## Design 2: Adopt a reconciled Runtime Run

### Contract

Extend `RuntimeReconciliationResolution` with:

```ts
{
  kind: 'adopt-run';
  runtimeRun: RuntimeRunAttachment;
  evidence: Record<string, unknown>;
}
```

The caller supplies only the Runtime identity and acceptance timestamp.
`canvasRunId`, Session identity, Binding, receipt, and compensation identity
remain server-owned.

Change `RuntimeReconciliationResult` to a discriminated union. An adopted result
identifies the Canvas resource so the application layer can safely hand off an
active Run:

```ts
type RuntimeReconciliationResult =
  | {
      phase: 'attached';
      outcome: 'adopted';
      resource:
        | { kind: 'session'; sessionId: string }
        | { kind: 'run'; runId: string; status: StoredRunStatus };
    }
  | { phase: 'retryable_failure'; outcome: 'absent' }
  | { phase: 'reconciling'; outcome: 'unresolved' };
```

### Transaction

Extract `attachRuntimeRunInTransaction` and reuse it from both normal
`attachRuntimeRun` and reconciliation. The existing receipt lock serializes
concurrent resolution. The helper validates exact Runtime identity, locks the
Run, and commits these changes together:

- Run: set the exact Runtime Run reference, move `queued` or `reconciling` to
  `running`, preserve the first `started_at`, and clear stale terminal errors.
- Command receipt: set `attached`, persist Runtime kind/ref, clear the error,
  and complete the receipt.
- Compensation: set `succeeded`, persist exact evidence, and resolve once.

An exact attached replay returns the current Run status without incrementing the
compensation attempt again. A different Runtime ref conflicts. Failure while
serializing evidence rolls back all three records.

### Event-pump handoff

Add an application-layer `SessionService.resolveRuntimeReconciliation` method.
It waits for the Repository transaction to commit, then starts the event pump
only for an adopted Run whose current status is `queued`, `running`, or
`waiting_approval`. The existing `RunEventPump.start` map makes repeated
same-process handoffs idempotent.

Repository code never starts process-local work from inside a database
transaction.

## Design 3: Compare-and-set terminal history sync

Extend `syncRuntimeSessionHistory` with the immutable
`externalSessionRef` captured by the Run:

```ts
syncRuntimeSessionHistory(input: {
  actor: ActorContext;
  sessionId: string;
  externalSessionRef: string;
  historyDigest: string;
}): Promise<void>;
```

The Repository update must match all of:

- `session_id`;
- `is_primary = true`;
- `status = 'active'`;
- exact `external_session_ref`.

No match is an error, not a no-op. The event pump syncs history before ingesting
the terminal event; therefore an exact-ref mismatch leaves the terminal event
uncommitted and the existing pump error path moves the Run to `reconciling`.
This prevents a succeeded Run from being recorded against an unsynchronized
replacement Runtime Session.

## Error and replay rules

- Known Runtime identity can never be resolved as `absent`.
- A Run adoption with a conflicting Runtime ref fails without partial writes.
- Attached adoption replay validates identity and returns current persisted
  status.
- Stale history sync never mutates the replacement Runtime ref.
- Migration overflow, malformed Runtime timestamp, or non-serializable evidence
  fails the enclosing transaction.
- Public browser DTOs continue to omit external Runtime references.

## Verification

Each behavior follows red-green-refactor and lands as an isolated commit:

1. Legacy migration journey and boundary cases.
2. Repository `adopt-run` transaction, replay, conflict, and rollback.
3. Application post-commit pump handoff.
4. Terminal history CAS in Repository integration and pump unit tests.

Final gates run on Node.js `24.18.0`:

- all unit tests;
- all database integration tests from disposable Postgres;
- lint;
- typecheck;
- production build;
- migration journal and `git diff --check`.

## Acceptance

This safety slice is complete only when:

- a real `0007`-shaped database upgrades without Message ordinal reuse;
- an exactly matched external Run leaves reconciliation as one attached,
  running Canvas Run with one succeeded compensation;
- replay never dispatches or consumes a second Runtime Run;
- an old Run cannot overwrite a replacement Runtime Session history digest;
- all current quality gates remain green.

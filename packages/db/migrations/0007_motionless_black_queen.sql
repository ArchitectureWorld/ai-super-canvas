ALTER TABLE "runs" ADD COLUMN "runtime_session_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runtime_session_external_ref" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "expected_history_digest" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runtime_binding_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "session_runtime_refs" ADD CONSTRAINT "session_runtime_refs_session_binding_id_ref_unique" UNIQUE("session_id","agent_binding_id","id","external_session_ref");--> statement-breakpoint
WITH "run_dispatch_candidates" AS (
  SELECT
    "run"."id" AS "run_id",
    "runtime_ref"."id" AS "runtime_session_ref_id",
    "runtime_ref"."external_session_ref" AS "runtime_session_external_ref",
    "receipt"."result_payload" #>> '{runtime,expectedHistoryDigest}' AS "expected_history_digest",
    "receipt"."result_payload" #> '{runtime,binding}' AS "runtime_binding_snapshot",
    count(*) OVER (PARTITION BY "run"."id") AS "candidate_count"
  FROM "runs" AS "run"
  JOIN "command_receipts" AS "receipt"
    ON "receipt"."result_type" = 'run'
   AND "receipt"."result_id" = "run"."id"
   AND "receipt"."command_type" = 'start-run'
  JOIN "session_runtime_refs" AS "runtime_ref"
    ON "runtime_ref"."session_id" = "run"."session_id"
   AND "runtime_ref"."agent_binding_id" = "run"."agent_binding_id"
   AND "runtime_ref"."external_session_ref" =
     "receipt"."result_payload" #>> '{runtime,externalSessionRef}'
  WHERE jsonb_typeof("receipt"."result_payload") = 'object'
    AND jsonb_typeof("receipt"."result_payload" #> '{runtime}') = 'object'
    AND jsonb_typeof("receipt"."result_payload" #> '{runtime,binding}') = 'object'
    AND jsonb_typeof(
      "receipt"."result_payload" #> '{runtime,externalSessionRef}'
    ) = 'string'
    AND jsonb_typeof(
      "receipt"."result_payload" #> '{runtime,expectedHistoryDigest}'
    ) = 'string'
    AND "receipt"."result_payload" ->> 'commandReceiptId' = "receipt"."id"::text
    AND "receipt"."result_payload" ->> 'runId' = "run"."id"::text
    AND "receipt"."result_payload" ->> 'sessionId' = "run"."session_id"::text
    AND "receipt"."result_payload" #>> '{runtime,binding,canvasAgentBindingId}' =
      "run"."agent_binding_id"::text
    AND ("receipt"."payload_canonical"::jsonb ->> 'sessionId') =
      "run"."session_id"::text
    AND ("receipt"."payload_canonical"::jsonb ->> 'idempotencyKey') =
      "run"."idempotency_key"
    AND length(
      "receipt"."result_payload" #>> '{runtime,externalSessionRef}'
    ) > 0
    AND length(
      "receipt"."result_payload" #>> '{runtime,expectedHistoryDigest}'
    ) > 0
)
UPDATE "runs" AS "run"
SET
  "runtime_session_ref_id" = "candidate"."runtime_session_ref_id",
  "runtime_session_external_ref" = "candidate"."runtime_session_external_ref",
  "expected_history_digest" = "candidate"."expected_history_digest",
  "runtime_binding_snapshot" = "candidate"."runtime_binding_snapshot"
FROM "run_dispatch_candidates" AS "candidate"
WHERE "candidate"."run_id" = "run"."id"
  AND "candidate"."candidate_count" = 1;--> statement-breakpoint
DO $$
DECLARE
  "unresolved_count" bigint;
  "unresolved_ids" text;
BEGIN
  SELECT count(*)
  INTO "unresolved_count"
  FROM "runs"
  WHERE "runtime_session_ref_id" IS NULL
     OR "runtime_session_external_ref" IS NULL
     OR "expected_history_digest" IS NULL
     OR "runtime_binding_snapshot" IS NULL;

  IF "unresolved_count" > 0 THEN
    SELECT string_agg("unresolved"."id"::text, ', ')
    INTO "unresolved_ids"
    FROM (
      SELECT "id"
      FROM "runs"
      WHERE "runtime_session_ref_id" IS NULL
         OR "runtime_session_external_ref" IS NULL
         OR "expected_history_digest" IS NULL
         OR "runtime_binding_snapshot" IS NULL
      ORDER BY "id"
      LIMIT 20
    ) AS "unresolved";
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runs_runtime_input_snapshot_backfill',
      MESSAGE = format(
        'Cannot backfill immutable Run Runtime input snapshot for %s row(s): %s',
        "unresolved_count",
        coalesce("unresolved_ids", '<unknown>')
      );
  END IF;
END;
$$;--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "runtime_session_ref_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "runtime_session_external_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "expected_history_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "runtime_binding_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_runtime_session_ref_fk" FOREIGN KEY ("session_id","agent_binding_id","runtime_session_ref_id","runtime_session_external_ref") REFERENCES "public"."session_runtime_refs"("session_id","agent_binding_id","id","external_session_ref") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_runtime_session_ref_fk";--> statement-breakpoint
CREATE FUNCTION "protect_run_runtime_input_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.runtime_session_ref_id IS DISTINCT FROM NEW.runtime_session_ref_id
    OR OLD.runtime_session_external_ref IS DISTINCT FROM NEW.runtime_session_external_ref
    OR OLD.expected_history_digest IS DISTINCT FROM NEW.expected_history_digest
    OR OLD.runtime_binding_snapshot IS DISTINCT FROM NEW.runtime_binding_snapshot THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'runs_runtime_input_snapshot_immutable',
      MESSAGE = 'Run Runtime input snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "protect_run_runtime_input_snapshot_trigger"
BEFORE UPDATE ON "runs"
FOR EACH ROW
EXECUTE FUNCTION "protect_run_runtime_input_snapshot"();
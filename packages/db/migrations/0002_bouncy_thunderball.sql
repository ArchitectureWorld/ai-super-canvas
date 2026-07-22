ALTER TABLE "runtime_compensations" DROP CONSTRAINT "runtime_compensations_lookup_check";--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD COLUMN "resolution_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_lookup_metadata_check" CHECK (jsonb_typeof("command_receipts"."external_lookup_metadata") = 'object' AND (
        "command_receipts"."external_lookup_metadata" = '{}'::jsonb
        OR (
          "command_receipts"."external_lookup_metadata" ? 'commandId'
          AND jsonb_typeof("command_receipts"."external_lookup_metadata" -> 'commandId') = 'string'
          AND length("command_receipts"."external_lookup_metadata" ->> 'commandId') > 0
          AND (
            (
              "command_receipts"."external_lookup_metadata" ? 'canvasSessionId'
              AND jsonb_typeof("command_receipts"."external_lookup_metadata" -> 'canvasSessionId') = 'string'
              AND length("command_receipts"."external_lookup_metadata" ->> 'canvasSessionId') > 0
            ) OR (
              "command_receipts"."external_lookup_metadata" ? 'canvasRunId'
              AND jsonb_typeof("command_receipts"."external_lookup_metadata" -> 'canvasRunId') = 'string'
              AND length("command_receipts"."external_lookup_metadata" ->> 'canvasRunId') > 0
            )
          )
        )
      ));--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD CONSTRAINT "runtime_compensations_run_requires_session" CHECK ("runtime_compensations"."canvas_run_id" IS NULL OR "runtime_compensations"."canvas_session_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD CONSTRAINT "runtime_compensations_resolution_check" CHECK (jsonb_typeof("runtime_compensations"."resolution_evidence") = 'object' AND (
        (
          "runtime_compensations"."status" = 'succeeded'
          AND "runtime_compensations"."resolved_at" IS NOT NULL
          AND "runtime_compensations"."resolution_evidence" <> '{}'::jsonb
        ) OR (
          "runtime_compensations"."status" <> 'succeeded'
          AND "runtime_compensations"."resolved_at" IS NULL
        )
      ));--> statement-breakpoint
ALTER TABLE "runtime_compensations" ADD CONSTRAINT "runtime_compensations_lookup_check" CHECK (jsonb_typeof("runtime_compensations"."lookup_metadata") = 'object'
        AND "runtime_compensations"."lookup_metadata" ? 'commandId'
        AND jsonb_typeof("runtime_compensations"."lookup_metadata" -> 'commandId') = 'string'
        AND length("runtime_compensations"."lookup_metadata" ->> 'commandId') > 0
        AND (
          (
            "runtime_compensations"."lookup_metadata" ? 'canvasSessionId'
            AND jsonb_typeof("runtime_compensations"."lookup_metadata" -> 'canvasSessionId') = 'string'
            AND length("runtime_compensations"."lookup_metadata" ->> 'canvasSessionId') > 0
          ) OR (
            "runtime_compensations"."lookup_metadata" ? 'canvasRunId'
            AND jsonb_typeof("runtime_compensations"."lookup_metadata" -> 'canvasRunId') = 'string'
            AND length("runtime_compensations"."lookup_metadata" ->> 'canvasRunId') > 0
          )
        )
      );
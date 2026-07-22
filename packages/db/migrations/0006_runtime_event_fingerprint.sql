ALTER TABLE "run_events" ADD COLUMN "event_fingerprint" text;--> statement-breakpoint
UPDATE "run_events"
SET "event_fingerprint" = 'legacy-unverifiable:' || "id"::text
WHERE "event_fingerprint" IS NULL;--> statement-breakpoint
ALTER TABLE "run_events" ALTER COLUMN "event_fingerprint" SET NOT NULL;

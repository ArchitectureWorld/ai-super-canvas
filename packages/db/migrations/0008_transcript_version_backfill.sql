LOCK TABLE "sessions" IN EXCLUSIVE MODE;--> statement-breakpoint
WITH "message_frontiers" AS (
  SELECT
    "session_id",
    MAX("ordinal") + 1 AS "next_transcript_version"
  FROM "messages"
  GROUP BY "session_id"
)
UPDATE "sessions" AS "session"
SET "transcript_version" = "frontier"."next_transcript_version"::integer
FROM "message_frontiers" AS "frontier"
WHERE "session"."id" = "frontier"."session_id"
  AND "session"."transcript_version"::bigint
    < "frontier"."next_transcript_version";

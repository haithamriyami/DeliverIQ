-- AlterTable
ALTER TABLE "users" ADD COLUMN     "gmail_history_id" TEXT,
ADD COLUMN     "inbox_sync_errors" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inbox_sync_lease_until" TIMESTAMP(3),
ADD COLUMN     "inbox_sync_not_before" TIMESTAMP(3),
ADD COLUMN     "inbox_sync_notice" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "send_backoff_count" INTEGER NOT NULL DEFAULT 0;


-- Resume senders paused only because of Gmail's per minute API quota ("Units per minute",
-- metric "Total Query Cost"). That quota was used up by inbox scanning and is not an account
-- problem. Real pauses (suspension, disabled, daily sending limit, reconnect) are kept.
-- Safe to re-run; the app also does this at runtime.
UPDATE "users"
SET "sending_paused_at" = NULL, "sending_paused_reason" = ''
WHERE "sending_paused_at" IS NOT NULL
  AND ("sending_paused_reason" LIKE '%Units per minute%'
    OR "sending_paused_reason" LIKE '%Total Query Cost%'
    OR "sending_paused_reason" LIKE '%Quota exceeded for quota metric%')
  AND "sending_paused_reason" NOT ILIKE '%suspend%'
  AND "sending_paused_reason" NOT ILIKE '%disabled%'
  AND "sending_paused_reason" NOT ILIKE '%sending limit%'
  AND "sending_paused_reason" NOT ILIKE '%reconnect%';

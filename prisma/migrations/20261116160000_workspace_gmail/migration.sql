-- Per workspace Gmail. Each workspace member can link a Gmail address for that workspace.
-- One row per Gmail address keeps the send gap, daily count, pauses and inbox sync shared
-- by every workspace that uses the same address. Nothing is deleted; the old per user
-- Gmail columns on users stay in place (unused) so a rollback keeps working.
BEGIN;

-- AlterTable
ALTER TABLE "campaign_recipients" ADD COLUMN     "sender_account_id" TEXT;

-- AlterTable
ALTER TABLE "inbound_replies" ADD COLUMN     "sender_account_id" TEXT;

-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN     "gmail_account_id" TEXT;

-- CreateTable
CREATE TABLE "gmail_accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "refresh_token" TEXT,
    "connected_at" TIMESTAMP(3),
    "connected_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_send_at" TIMESTAMP(3),
    "last_sent_at" TIMESTAMP(3),
    "sending_paused_at" TIMESTAMP(3),
    "sending_paused_reason" TEXT NOT NULL DEFAULT '',
    "send_backoff_count" INTEGER NOT NULL DEFAULT 0,
    "last_inbox_sync_at" TIMESTAMP(3),
    "gmail_history_id" TEXT,
    "inbox_sync_not_before" TIMESTAMP(3),
    "inbox_sync_lease_until" TIMESTAMP(3),
    "inbox_sync_errors" INTEGER NOT NULL DEFAULT 0,
    "inbox_sync_notice" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "gmail_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gmail_accounts_email_key" ON "gmail_accounts"("email");

-- CreateIndex
CREATE INDEX "campaign_recipients_sender_account_id_sent_at_idx" ON "campaign_recipients"("sender_account_id", "sent_at");

-- CreateIndex
CREATE INDEX "workspace_members_gmail_account_id_idx" ON "workspace_members"("gmail_account_id");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_gmail_account_id_fkey" FOREIGN KEY ("gmail_account_id") REFERENCES "gmail_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_sender_account_id_fkey" FOREIGN KEY ("sender_account_id") REFERENCES "gmail_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_sender_account_id_fkey" FOREIGN KEY ("sender_account_id") REFERENCES "gmail_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Move every existing per user Gmail connection into gmail_accounts, with its throttle and
-- inbox sync state, so sending continues where it left off.
INSERT INTO "gmail_accounts" (
  "id", "email", "refresh_token", "connected_at", "connected_by_id", "created_at",
  "next_send_at", "last_sent_at", "sending_paused_at", "sending_paused_reason", "send_backoff_count",
  "last_inbox_sync_at", "gmail_history_id", "inbox_sync_not_before", "inbox_sync_lease_until",
  "inbox_sync_errors", "inbox_sync_notice"
)
SELECT DISTINCT ON (lower(u."gmail_email"))
  md5(random()::text || clock_timestamp()::text || u."id")::uuid::text,
  lower(u."gmail_email"), u."gmail_refresh_token", u."gmail_connected_at", u."id", CURRENT_TIMESTAMP,
  u."next_send_at", u."last_sent_at", u."sending_paused_at", u."sending_paused_reason", u."send_backoff_count",
  u."last_inbox_sync_at", u."gmail_history_id", u."inbox_sync_not_before", NULL,
  u."inbox_sync_errors", u."inbox_sync_notice"
FROM "users" u
WHERE u."gmail_email" IS NOT NULL AND u."gmail_refresh_token" IS NOT NULL
ORDER BY lower(u."gmail_email"), u."gmail_connected_at" DESC NULLS LAST;

-- Keep that Gmail for the user's membership in their oldest workspace (FinanceBridge in
-- production), the one it has been sending for. Workspaces created later start without
-- Gmail and connect their own.
UPDATE "workspace_members" m
SET "gmail_account_id" = a."id"
FROM "gmail_accounts" a
WHERE a."connected_by_id" = m."user_id"
  AND m."gmail_account_id" IS NULL
  AND m."workspace_id" = (
    SELECT x."workspace_id"
    FROM "workspace_members" x
    JOIN "workspaces" w ON w."id" = x."workspace_id"
    WHERE x."user_id" = m."user_id"
    ORDER BY w."created_at", w."id"
    LIMIT 1
  );

-- Record which Gmail address past sends and replies used, so the daily cap keeps counting them.
UPDATE "campaign_recipients" cr
SET "sender_account_id" = a."id"
FROM "gmail_accounts" a
WHERE cr."sender_id" = a."connected_by_id" AND cr."sender_account_id" IS NULL;

UPDATE "inbound_replies" r
SET "sender_account_id" = a."id"
FROM "gmail_accounts" a
WHERE r."sender_id" = a."connected_by_id" AND r."sender_account_id" IS NULL;

COMMIT;

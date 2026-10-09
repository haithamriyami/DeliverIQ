-- Add display name and reply-to fields to workspaces
ALTER TABLE "workspaces" ADD COLUMN "from_display_name" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "reply_to_email" TEXT;

-- Add message and thread IDs to campaign recipients for email threading
ALTER TABLE "campaign_recipients" ADD COLUMN "message_id" TEXT;
ALTER TABLE "campaign_recipients" ADD COLUMN "thread_id" TEXT;

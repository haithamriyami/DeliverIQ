-- CreateEnum
CREATE TYPE "InboundReplyType" AS ENUM ('reply', 'auto_reply', 'opt_out');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "daily_send_cap" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "send_gap_seconds" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "send_jitter_seconds" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_inbox_sync_at" TIMESTAMP(3),
ADD COLUMN     "last_sent_at" TIMESTAMP(3),
ADD COLUMN     "next_send_at" TIMESTAMP(3),
ADD COLUMN     "sending_paused_at" TIMESTAMP(3),
ADD COLUMN     "sending_paused_reason" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "recipients" ADD COLUMN     "do_not_contact" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replied_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "paused_reason" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "campaign_recipients" ADD COLUMN     "sender_id" TEXT;

-- CreateTable
CREATE TABLE "inbound_replies" (
    "id" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "type" "InboundReplyType" NOT NULL,
    "sender_id" TEXT,
    "recipient_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "subject" TEXT NOT NULL DEFAULT '',
    "snippet" TEXT NOT NULL DEFAULT '',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_replies_gmail_message_id_key" ON "inbound_replies"("gmail_message_id");

-- CreateIndex
CREATE INDEX "inbound_replies_campaign_id_type_idx" ON "inbound_replies"("campaign_id", "type");

-- CreateIndex
CREATE INDEX "inbound_replies_recipient_id_idx" ON "inbound_replies"("recipient_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_sender_id_sent_at_idx" ON "campaign_recipients"("sender_id", "sent_at");

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;


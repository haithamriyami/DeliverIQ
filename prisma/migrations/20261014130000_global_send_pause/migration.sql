-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "sending_paused_at" TIMESTAMP(3),
ADD COLUMN     "sending_paused_reason" TEXT NOT NULL DEFAULT '';


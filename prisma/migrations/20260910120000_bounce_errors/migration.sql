ALTER TABLE "recipients" ADD COLUMN "last_error" TEXT NOT NULL DEFAULT '';
ALTER TABLE "campaign_recipients" ADD COLUMN "error" TEXT NOT NULL DEFAULT '';

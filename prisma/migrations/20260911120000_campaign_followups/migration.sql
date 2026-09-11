CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "campaign_steps" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "step_number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'pending',
    "recipient_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_steps_pkey" PRIMARY KEY ("id")
);

INSERT INTO "campaign_steps" ("id", "campaign_id", "step_number", "name", "subject", "template_id", "status", "recipient_ids", "created_at")
SELECT gen_random_uuid()::text, "id", 1, 'Email 1', "subject", "template_id", "status", "recipient_ids", "created_at"
FROM "campaigns";

ALTER TABLE "campaign_recipients" ADD COLUMN "step_id" TEXT;

UPDATE "campaign_recipients" AS cr
SET "step_id" = s."id"
FROM "campaign_steps" AS s
WHERE s."campaign_id" = cr."campaign_id" AND s."step_number" = 1;

DELETE FROM "campaign_recipients" WHERE "step_id" IS NULL;

ALTER TABLE "campaign_recipients" ALTER COLUMN "step_id" SET NOT NULL;

DROP INDEX IF EXISTS "campaign_recipients_campaign_id_recipient_id_key";
ALTER TABLE "campaign_recipients" DROP CONSTRAINT IF EXISTS "campaign_recipients_campaign_id_recipient_id_key";

CREATE UNIQUE INDEX "campaign_steps_campaign_id_step_number_key" ON "campaign_steps"("campaign_id", "step_number");
CREATE INDEX "campaign_steps_campaign_id_idx" ON "campaign_steps"("campaign_id");
CREATE UNIQUE INDEX "campaign_recipients_step_id_recipient_id_key" ON "campaign_recipients"("step_id", "recipient_id");
CREATE INDEX "campaign_recipients_step_id_status_idx" ON "campaign_recipients"("step_id", "status");

ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "campaign_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

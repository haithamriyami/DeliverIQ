-- Additive only: one new table. No existing table or column is changed.
CREATE TABLE "sendgrid_senders" (
    "workspace_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "daily_cap" INTEGER NOT NULL DEFAULT 100,
    "from_email" TEXT NOT NULL DEFAULT '',
    "from_name" TEXT NOT NULL DEFAULT '',
    "reply_to_email" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sendgrid_senders_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "sendgrid_senders" ADD CONSTRAINT "sendgrid_senders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "contact_lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_lists_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_lists_name_key" ON "contact_lists"("name");

INSERT INTO "contact_lists" ("id", "name")
VALUES (gen_random_uuid()::text, 'Agencies'), (gen_random_uuid()::text, 'Restaurants');

ALTER TABLE "recipients" ADD COLUMN "list_id" TEXT;

UPDATE "recipients"
SET "list_id" = (SELECT "id" FROM "contact_lists" WHERE "name" = 'Agencies' LIMIT 1)
WHERE "list_id" IS NULL;

ALTER TABLE "recipients" ALTER COLUMN "list_id" SET NOT NULL;

CREATE INDEX "recipients_list_id_idx" ON "recipients"("list_id");

ALTER TABLE "recipients" ADD CONSTRAINT "recipients_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "contact_lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaigns" ADD COLUMN "list_id" TEXT;

ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "contact_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

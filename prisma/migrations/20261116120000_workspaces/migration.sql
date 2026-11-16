-- Separate workspaces. Non destructive: no rows are deleted and no data columns are dropped.
-- All existing contacts, lists, templates and campaigns move into the oldest workspace
-- (the FinanceBridge workspace), and every existing user becomes a member of their
-- current workspace with their current role.
BEGIN;

-- 1. A workspace to hold existing data, only if data exists but no workspace does.
INSERT INTO "workspaces" ("id", "name", "created_at")
SELECT gen_random_uuid()::text, 'DeliverIQ', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "workspaces")
  AND (
    EXISTS (SELECT 1 FROM "recipients")
    OR EXISTS (SELECT 1 FROM "contact_lists")
    OR EXISTS (SELECT 1 FROM "templates")
    OR EXISTS (SELECT 1 FROM "campaigns")
  );

-- 2. Memberships.
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "workspace_members" ("id", "workspace_id", "user_id", "role", "created_at")
SELECT gen_random_uuid()::text, u."workspace_id", u."id", u."role", u."created_at"
FROM "users" u
ON CONFLICT ("workspace_id", "user_id") DO NOTHING;

-- 3. Workspace owner columns, backfilled with the oldest workspace.
ALTER TABLE "recipients" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "contact_lists" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "templates" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "workspace_id" TEXT;

UPDATE "recipients" SET "workspace_id" = (SELECT "id" FROM "workspaces" ORDER BY "created_at" ASC, "id" ASC LIMIT 1) WHERE "workspace_id" IS NULL;
UPDATE "contact_lists" SET "workspace_id" = (SELECT "id" FROM "workspaces" ORDER BY "created_at" ASC, "id" ASC LIMIT 1) WHERE "workspace_id" IS NULL;
UPDATE "templates" SET "workspace_id" = (SELECT "id" FROM "workspaces" ORDER BY "created_at" ASC, "id" ASC LIMIT 1) WHERE "workspace_id" IS NULL;
UPDATE "campaigns" SET "workspace_id" = (SELECT "id" FROM "workspaces" ORDER BY "created_at" ASC, "id" ASC LIMIT 1) WHERE "workspace_id" IS NULL;

ALTER TABLE "recipients" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "contact_lists" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "templates" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "campaigns" ALTER COLUMN "workspace_id" SET NOT NULL;

ALTER TABLE "recipients" ADD CONSTRAINT "recipients_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Uniqueness becomes per workspace: the same email or list name can exist in two workspaces.
DROP INDEX IF EXISTS "recipients_email_key";
CREATE UNIQUE INDEX "recipients_workspace_id_email_key" ON "recipients"("workspace_id", "email");
DROP INDEX IF EXISTS "contact_lists_name_key";
CREATE UNIQUE INDEX "contact_lists_workspace_id_name_key" ON "contact_lists"("workspace_id", "name");
CREATE INDEX "templates_workspace_id_idx" ON "templates"("workspace_id");
CREATE INDEX "campaigns_workspace_id_idx" ON "campaigns"("workspace_id");

COMMIT;

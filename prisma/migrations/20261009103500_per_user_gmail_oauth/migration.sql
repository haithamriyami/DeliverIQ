-- Add per-user Gmail OAuth fields
ALTER TABLE "users" ADD COLUMN "gmail_email" TEXT;
ALTER TABLE "users" ADD COLUMN "gmail_refresh_token" TEXT;
ALTER TABLE "users" ADD COLUMN "gmail_connected_at" TIMESTAMP(3);

-- Migrate existing workspace Gmail connection to the first owner user
-- This preserves Haitham's existing connection
UPDATE "users" u
SET 
  "gmail_email" = w."gmail_email",
  "gmail_refresh_token" = w."gmail_refresh_token",
  "gmail_connected_at" = w."gmail_connected_at"
FROM "workspaces" w
WHERE u."workspace_id" = w."id"
  AND u."role" = 'owner'
  AND w."gmail_email" IS NOT NULL
  AND u."id" = (
    SELECT "id" FROM "users" 
    WHERE "workspace_id" = w."id" AND "role" = 'owner' 
    ORDER BY "created_at" ASC 
    LIMIT 1
  );

-- Keep workspace-level fields for backward compatibility during transition
-- They can be dropped in a future migration after verification

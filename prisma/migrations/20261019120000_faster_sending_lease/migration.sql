-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "send_gap_seconds" SET DEFAULT 10,
ALTER COLUMN "send_jitter_seconds" SET DEFAULT 5;

-- CreateTable
CREATE TABLE "scheduler_leases" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduler_leases_pkey" PRIMARY KEY ("name")
);


-- Move workspaces still on the old defaults (30 s gap, 10 s jitter) to the new defaults
-- (10 s gap, 5 s jitter). Workspaces with custom values are left alone. Safe to re-run.
UPDATE "workspaces" SET "send_gap_seconds" = 10, "send_jitter_seconds" = 5
WHERE "send_gap_seconds" = 30 AND "send_jitter_seconds" = 10;

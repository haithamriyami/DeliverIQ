-- Add a nullable organization field on contacts so templates can fill {{organization}}.
-- Existing rows stay null until they are imported again or backfilled after this
-- migration is applied on production.

ALTER TABLE "recipients" ADD COLUMN "organization" TEXT;

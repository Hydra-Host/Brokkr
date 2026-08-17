-- Enforce the invariant that every Device carries a lifecycle status.
--
-- Context: the NetBox backfill previously mapped only 8 of the 10 source
-- statuses, so some `provisioned`/`provisioning` devices fell
-- through to NULL. That mapping is now exhaustive. This migration closes the
-- loop at the schema level.
--
-- Run order (see "re-backfill, then constrain"): the corrected backfill should
-- run first so those rows get their accurate PROVISIONED/PROVISIONING
-- value. The UPDATE below is a safety net for any remaining NULLs — legacy,
-- non-NetBox rows (e.g. out-of-band IPMI entries) that never had a status —
-- so the NOT NULL constraint can be added without the migration failing.
UPDATE "Device" SET "status" = 'PLANNED' WHERE "status" IS NULL;

-- AlterTable: status becomes required, defaulting to PLANNED for new rows.
ALTER TABLE "Device" ALTER COLUMN "status" SET DEFAULT 'PLANNED',
                     ALTER COLUMN "status" SET NOT NULL;

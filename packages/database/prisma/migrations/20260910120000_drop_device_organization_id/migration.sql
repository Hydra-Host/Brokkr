-- Device.organizationId duplicated Device.supplierId (both were written from
-- zone.organizationId). Backfill any rows that only have organizationId, then
-- drop the redundant column and rebuild the active-name unique on supplierId.

-- Abort if any row has both IDs set to different values — dropping organizationId
-- would silently discard a conflicting tenant assignment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Device"
    WHERE "supplierId" IS NOT NULL
      AND "organizationId" IS NOT NULL
      AND "supplierId" IS DISTINCT FROM "organizationId"
  ) THEN
    RAISE EXCEPTION
      'Device.organizationId drop aborted: one or more Device rows have both supplierId and organizationId set to unequal values';
  END IF;
END $$;

UPDATE "Device"
SET "supplierId" = "organizationId"
WHERE "supplierId" IS NULL AND "organizationId" IS NOT NULL;

DO $$
DECLARE
  backfilled integer;
BEGIN
  GET DIAGNOSTICS backfilled = ROW_COUNT;
  RAISE NOTICE 'Device.organizationId backfill: % row(s) set supplierId from organizationId', backfilled;
END $$;

DROP INDEX IF EXISTS "Device_active_onboarding_name_unique";
ALTER TABLE "Device" DROP CONSTRAINT IF EXISTS "Device_organizationId_fkey";
DROP INDEX IF EXISTS "Device_organizationId_idx";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "organizationId";
CREATE UNIQUE INDEX "Device_active_onboarding_name_unique" ON public."Device" USING btree ("supplierId", "zoneId", name) WHERE ("deletedAt" IS NULL);
CREATE INDEX IF NOT EXISTS "Device_supplierId_idx" ON "Device"("supplierId");

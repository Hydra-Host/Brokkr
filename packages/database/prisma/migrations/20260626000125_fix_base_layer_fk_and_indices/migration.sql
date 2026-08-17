-- Follow-up migration: add indices omitted from 00100 and audit backfill results.
-- (The baseLayerId FK was created with RESTRICT directly in 00100, so no
-- drop+recreate is needed here.)

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Deployment_baseLayerId_idx" ON "Deployment"("baseLayerId");
CREATE INDEX IF NOT EXISTS "Deployment_rescueLayerId_idx" ON "Deployment"("rescueLayerId");

-- Post-backfill audit: warn if any active deployments were not mapped.
DO $$
DECLARE
  unmapped_base INT;
  unmapped_rescue INT;
  total_mapped_base INT;
  total_mapped_rescue INT;
BEGIN
  SELECT COUNT(*) INTO unmapped_base
  FROM "Deployment"
  WHERE "endDate" IS NULL
    AND "operatingSystemId" IS NOT NULL
    AND "baseLayerId" IS NULL;

  SELECT COUNT(*) INTO unmapped_rescue
  FROM "Deployment"
  WHERE "endDate" IS NULL
    AND "currentRescueOperatingSystemId" IS NOT NULL
    AND "rescueLayerId" IS NULL;

  SELECT COUNT(*) INTO total_mapped_base
  FROM "Deployment"
  WHERE "baseLayerId" IS NOT NULL;

  SELECT COUNT(*) INTO total_mapped_rescue
  FROM "Deployment"
  WHERE "rescueLayerId" IS NOT NULL;

  RAISE NOTICE 'Backfill results: % base mapped, % active base unmapped; % rescue mapped, % active rescue unmapped',
    total_mapped_base, unmapped_base, total_mapped_rescue, unmapped_rescue;

  IF unmapped_base > 0 THEN
    RAISE WARNING 'Backfill incomplete: % active deployments have operatingSystemId but no matching Layer for baseLayerId. Run seeders before applying migration 00200.', unmapped_base;
  END IF;
END;
$$;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "baseLayerId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN     "rescueLayerId" TEXT;

-- CreateIndex
CREATE INDEX "Deployment_baseLayerId_idx" ON "Deployment"("baseLayerId");

-- CreateIndex
CREATE INDEX "Deployment_rescueLayerId_idx" ON "Deployment"("rescueLayerId");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_baseLayerId_fkey" FOREIGN KEY ("baseLayerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_rescueLayerId_fkey" FOREIGN KEY ("rescueLayerId") REFERENCES "Layer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the new Layer FKs from the legacy OperatingSystem slugs (OS.slug ==
-- Layer.slug by seeding contract). Tolerant: a deployment whose OS slug has no
-- matching Layer keeps NULL rather than aborting the migration. The four system
-- slugs (live + custom-iPXE) are created by the app seeder
-- (seed-from-manifest.ts); 20260626000000 only adds the LIVE LayerKind enum
-- value. The backfill assumes Layers are already seeded; unmatched rows stay
-- NULL by design.
UPDATE "Deployment" d
SET "baseLayerId" = l.id
FROM "OperatingSystem" os
JOIN "Layer" l ON l.slug = os.slug
WHERE d."operatingSystemId" = os.id;

UPDATE "Deployment" d
SET "rescueLayerId" = l.id
FROM "OperatingSystem" os
JOIN "Layer" l ON l.slug = os.slug
WHERE d."currentRescueOperatingSystemId" = os.id;

-- Report unmatched rows so operators see NULL-on-miss counts in the migration log.
DO $$
DECLARE
  base_null_count INT;
  rescue_null_count INT;
BEGIN
  SELECT COUNT(*) INTO base_null_count
  FROM "Deployment"
  WHERE "operatingSystemId" IS NOT NULL AND "baseLayerId" IS NULL;

  SELECT COUNT(*) INTO rescue_null_count
  FROM "Deployment"
  WHERE "currentRescueOperatingSystemId" IS NOT NULL AND "rescueLayerId" IS NULL;

  IF base_null_count > 0 THEN
    RAISE NOTICE 'deployment_layer_fks backfill: % deployments have operatingSystemId but no matching Layer (baseLayerId left NULL)', base_null_count;
  END IF;

  IF rescue_null_count > 0 THEN
    RAISE NOTICE 'deployment_layer_fks backfill: % deployments have currentRescueOperatingSystemId but no matching Layer (rescueLayerId left NULL)', rescue_null_count;
  END IF;
END $$;

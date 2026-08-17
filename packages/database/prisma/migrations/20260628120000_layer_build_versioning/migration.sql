-- CreateEnum
CREATE TYPE "LayerBuildStatus" AS ENUM ('IMPORTING', 'READY', 'FAILED', 'RETIRED');

-- CreateTable: LayerBuild (version registry)
CREATE TABLE "LayerBuild" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "manifestUrl" TEXT NOT NULL,
    "status" "LayerBuildStatus" NOT NULL DEFAULT 'IMPORTING',
    "error" TEXT,
    "pipelineId" BIGINT,
    "generatedAt" TIMESTAMP(3),
    "promotedFrom" TEXT,
    "promotedAt" TIMESTAMP(3),
    "promotedByPipelineId" BIGINT,
    "importedById" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayerBuild_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PlatformSettings (global singleton)
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "defaultLayerBuildId" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LayerBuild_version_env_key" ON "LayerBuild"("version", "env");
CREATE INDEX "LayerBuild_status_idx" ON "LayerBuild"("status");

-- AddForeignKey: LayerBuild.importedById -> User
ALTER TABLE "LayerBuild" ADD CONSTRAINT "LayerBuild_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: PlatformSettings.defaultLayerBuildId -> LayerBuild
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_defaultLayerBuildId_fkey" FOREIGN KEY ("defaultLayerBuildId") REFERENCES "LayerBuild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: PlatformSettings.updatedById -> User
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the singleton row so reads never face missing-row-vs-null-field.
INSERT INTO "PlatformSettings"("id", "updatedAt") VALUES ('singleton', now());

-- AlterTable: Zone — add layerBuildId
ALTER TABLE "Zone" ADD COLUMN "layerBuildId" TEXT;

-- AddForeignKey: Zone.layerBuildId -> LayerBuild
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_layerBuildId_fkey" FOREIGN KEY ("layerBuildId") REFERENCES "LayerBuild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Layer — remove version column
ALTER TABLE "Layer" DROP COLUMN "version";

-- AlterTable: LayerArtifact — add layerBuildId (NOT NULL), remove deactivatedAt, adjust indexes/constraints

-- Step 1: Add layerBuildId as nullable first (will be made NOT NULL in Step 6 after backfill)
ALTER TABLE "LayerArtifact" ADD COLUMN "layerBuildId" TEXT;

-- Step 2: Drop the partial unique index from 20260513120000_layer_artifact_partial_unique
DROP INDEX IF EXISTS "LayerArtifact_active_slot_key";

-- Step 2.5: Delete deactivated artifacts before dropping the column.
-- The old partial unique index allowed multiple rows per (layerId, osDistro,
-- osCodename, arch, variant) slot — one active, N deactivated. After the
-- blanket backfill to 'legacy-backfill' in Step 5, those rows would share the
-- same composite key and violate the full-table unique index created in Step 8.
-- Clean up DeploymentLayer references first (FK), then the artifacts themselves.
DELETE FROM "DeploymentLayer"
WHERE "layerArtifactId" IN (
  SELECT "id" FROM "LayerArtifact" WHERE "deactivatedAt" IS NOT NULL
);
DELETE FROM "LayerRelation"
WHERE "artifactId" IN (
  SELECT "id" FROM "LayerArtifact" WHERE "deactivatedAt" IS NOT NULL
);
DELETE FROM "LayerArtifact" WHERE "deactivatedAt" IS NOT NULL;

-- Step 3: Drop the deactivatedAt index and column
DROP INDEX IF EXISTS "LayerArtifact_deactivatedAt_idx";
ALTER TABLE "LayerArtifact" DROP COLUMN IF EXISTS "deactivatedAt";

-- Step 4: Drop global sha256 unique (may already be absent if partial-unique migration dropped it)
DROP INDEX IF EXISTS "LayerArtifact_sha256_key";

-- Step 5: Backfill existing LayerArtifact rows with a sentinel build so SET NOT NULL succeeds.
-- On first deploy (fresh schema) no rows exist and both the INSERT and UPDATE are no-ops.
-- The conditional INSERT guard prevents creating a sentinel row when there is nothing to backfill.
INSERT INTO "LayerBuild" ("id", "version", "env", "schemaVersion", "manifestUrl", "status", "importedAt", "updatedAt")
SELECT 'legacy-backfill', 'legacy', 'dev', 0, 'n/a', 'RETIRED', now(), now()
WHERE EXISTS (SELECT 1 FROM "LayerArtifact" WHERE "layerBuildId" IS NULL);

UPDATE "LayerArtifact" SET "layerBuildId" = 'legacy-backfill' WHERE "layerBuildId" IS NULL;

-- Step 6: Make layerBuildId NOT NULL (safe after backfill)
ALTER TABLE "LayerArtifact" ALTER COLUMN "layerBuildId" SET NOT NULL;

-- Step 7: Add foreign key (RESTRICT — cannot delete a build while its artifacts exist)
ALTER TABLE "LayerArtifact" ADD CONSTRAINT "LayerArtifact_layerBuildId_fkey" FOREIGN KEY ("layerBuildId") REFERENCES "LayerBuild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Step 8: New composite unique constraints and indexes
CREATE UNIQUE INDEX "LayerArtifact_layerBuildId_sha256_key" ON "LayerArtifact"("layerBuildId", "sha256");
CREATE UNIQUE INDEX "LayerArtifact_build_slot_key" ON "LayerArtifact"("layerBuildId", "layerId", "osDistro", "osCodename", "arch", "variant");
CREATE INDEX "LayerArtifact_layerBuildId_osDistro_osCodename_arch_idx" ON "LayerArtifact"("layerBuildId", "osDistro", "osCodename", "arch");

-- Drop old osDistro/osCodename/arch index (replaced by build-scoped composite)
DROP INDEX IF EXISTS "LayerArtifact_osDistro_osCodename_arch_idx";

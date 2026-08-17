-- Single migration for the layered-OS feature:
--   - LayerKind enum + Layer.family/kind columns
--   - LayerArtifact table (with deactivatedAt soft-delete column)
--   - DeviceMetadata.arch (so the resolver picks amd64 vs arm64)
--   - OperatingSystem.netboxPlatformId no longer unique (BASE OSes share
--     one "Layered OS" platform per env)
--   - InstalledLayer → DeploymentLayer rename, plus a layerArtifactId fk so
--     each row is sha-pinned to the specific artifact applied. Empty table
--     pre-rename, so NOT NULL with no default + no backfill is safe.
--   - LayerRelation refactored from per-layer to per-artifact on the requirer
--     side, so per-build divergence (arch/distro) is expressible. Original
--     table from 20260318214408_layer_models is empty in shipped envs, so
--     drop-and-recreate is safe.

-- CreateEnum
CREATE TYPE "LayerKind" AS ENUM ('BASE', 'LEGACY', 'COMPONENT', 'INTERNAL');

-- AlterTable
ALTER TABLE "Layer" ADD COLUMN     "family" TEXT,
ADD COLUMN     "kind" "LayerKind" NOT NULL DEFAULT 'COMPONENT';

-- CreateTable
CREATE TABLE "LayerArtifact" (
    "id" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "osDistro" TEXT NOT NULL,
    "osCodename" TEXT NOT NULL,
    "osVersion" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "sha256" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "compression" TEXT NOT NULL DEFAULT 'zstd',
    "kernel" TEXT,
    "releaseVersion" TEXT,
    "sourceVersion" TEXT,
    "filename" TEXT,
    "blobPath" TEXT,
    "builtAt" TIMESTAMP(3),
    "builtByPipelineId" BIGINT,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayerArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LayerArtifact_layerId_idx" ON "LayerArtifact"("layerId");

-- CreateIndex
CREATE INDEX "LayerArtifact_osDistro_osCodename_arch_idx" ON "LayerArtifact"("osDistro", "osCodename", "arch");

-- CreateIndex
CREATE INDEX "LayerArtifact_deactivatedAt_idx" ON "LayerArtifact"("deactivatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LayerArtifact_sha256_key" ON "LayerArtifact"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "LayerArtifact_layerId_osDistro_osCodename_arch_variant_key" ON "LayerArtifact"("layerId", "osDistro", "osCodename", "arch", "variant");

-- AddForeignKey
ALTER TABLE "LayerArtifact" ADD CONSTRAINT "LayerArtifact_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "Layer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropIndex: allows multiple OperatingSystem rows to share a single NetBox
-- platform ID. Required so all kind=BASE rows can point at the shared
-- "Layered OS" platform (one per env).
DROP INDEX IF EXISTS "OperatingSystem_netboxPlatformId_key";

-- AlterTable: discovery-reported CPU architecture so the os_layers resolver
-- can pick the right LayerArtifact (amd64 vs arm64) without an extra round-trip.
ALTER TABLE "DeviceMetadata" ADD COLUMN "arch" TEXT;

-- RenameTable: InstalledLayer → DeploymentLayer to match the rest of the
-- schema's naming convention (DeviceOperatingSystem, DeploymentLifecycleAction,
-- etc.) and to better describe what the row means: a layer assigned to a
-- deployment at provision time, not necessarily one that successfully installed.
-- The table is empty (no application code wrote to it before this MR).
ALTER TABLE "InstalledLayer" RENAME TO "DeploymentLayer";

-- RenameConstraint
ALTER TABLE "DeploymentLayer" RENAME CONSTRAINT "InstalledLayer_pkey" TO "DeploymentLayer_pkey";
ALTER TABLE "DeploymentLayer" RENAME CONSTRAINT "InstalledLayer_deploymentId_fkey" TO "DeploymentLayer_deploymentId_fkey";
ALTER TABLE "DeploymentLayer" RENAME CONSTRAINT "InstalledLayer_layerId_fkey" TO "DeploymentLayer_layerId_fkey";

-- AlterTable: add the artifact fk column. Empty table, so NOT NULL with no
-- default and no backfill is fine.
ALTER TABLE "DeploymentLayer" ADD COLUMN "layerArtifactId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "DeploymentLayer_layerArtifactId_idx" ON "DeploymentLayer"("layerArtifactId");

-- AddForeignKey
ALTER TABLE "DeploymentLayer" ADD CONSTRAINT "DeploymentLayer_layerArtifactId_fkey" FOREIGN KEY ("layerArtifactId") REFERENCES "LayerArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- LayerRelation refactor: requirer side moves from Layer to LayerArtifact so
-- per-build divergence (e.g. cuda-13.2 on debian/12/arm64 vs amd64) is
-- expressible. Original Layer-keyed table is dropped — its rows are derivable
-- from the manifest's per-artifact `requires[]` and the catalog seed, both of
-- which write into the new shape on next run.

DROP TABLE "LayerRelation";

CREATE TABLE "LayerRelation" (
    "artifactId"     TEXT NOT NULL,
    "relatedLayerId" TEXT NOT NULL,
    "type"           "LayerRelationType" NOT NULL,
    "groupId"        TEXT,

    CONSTRAINT "LayerRelation_pkey" PRIMARY KEY ("artifactId", "relatedLayerId")
);

-- CreateIndex
CREATE INDEX "LayerRelation_relatedLayerId_idx" ON "LayerRelation"("relatedLayerId");

-- AddForeignKey
ALTER TABLE "LayerRelation" ADD CONSTRAINT "LayerRelation_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "LayerArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayerRelation" ADD CONSTRAINT "LayerRelation_relatedLayerId_fkey" FOREIGN KEY ("relatedLayerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop DeviceOperatingSystemLayer: pure denormalization of (manifest publishes)
-- ∩ hardwareEligibleLayerSlugs(gpuModel, teeEnabled). Eligibility is now
-- computed at request time from LayerArtifact + device metadata, eliminating
-- a writer (DeviceLayersProcessor) and a drift surface. Original table from
-- 20260318214408_layer_models is empty in shipped envs, so a plain DROP is safe.
DROP TABLE "DeviceOperatingSystemLayer";

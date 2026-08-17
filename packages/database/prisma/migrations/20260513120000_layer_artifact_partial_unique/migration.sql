-- Partial unique on (layerId, osDistro, osCodename, arch, variant) WHERE deactivatedAt IS NULL,
-- so superseded rows can coexist with the current active row in a slot for DeploymentLayer audit.

DROP INDEX "LayerArtifact_layerId_osDistro_osCodename_arch_variant_key";

CREATE UNIQUE INDEX "LayerArtifact_active_slot_key"
  ON "LayerArtifact" ("layerId", "osDistro", "osCodename", "arch", "variant")
  WHERE "deactivatedAt" IS NULL;

-- Drop unused blobPath column (always NULL, redundant with url).

ALTER TABLE "LayerArtifact" DROP COLUMN "blobPath";

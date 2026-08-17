-- Reshape Region from the NetBox-era hierarchical country/state model into a
-- coarse, marketplace-level geographic region defined by a custom GeoJSON
-- boundary. The old region rows are a different concept (country/state) and are
-- dropped; zones are re-assigned from coordinates by the region seed/recompute
-- command after this migration runs.

-- Release zone FKs + drop the old (country/state) region rows.
UPDATE "Zone" SET "regionId" = NULL;
DELETE FROM "Region";

-- Drop the self-referential hierarchy.
ALTER TABLE "Region" DROP CONSTRAINT IF EXISTS "Region_parentId_fkey";
ALTER TABLE "Region" DROP COLUMN IF EXISTS "parentId";

-- Add the geocoding columns. Table is empty, so NOT NULL adds are safe.
ALTER TABLE "Region" ADD COLUMN "boundary" JSONB NOT NULL;
ALTER TABLE "Region" ADD COLUMN "centroidLat" DOUBLE PRECISION NOT NULL;
ALTER TABLE "Region" ADD COLUMN "centroidLng" DOUBLE PRECISION NOT NULL;
ALTER TABLE "Region" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "Region" ADD COLUMN "color" TEXT;

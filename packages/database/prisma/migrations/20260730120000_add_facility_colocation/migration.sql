-- Optional operator hierarchy above Zone: Facility -> Colocation -> Zone, so the
-- people who run a building (NOC, upstream, integrator, procurement) are recorded
-- once per site instead of copied onto every zone in it. Addition-only: every new
-- link is nullable and a Zone with no Colocation keeps working unchanged.

CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "internalName" TEXT,
    "operator" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Colocation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "internalName" TEXT,
    "notes" TEXT,
    "facilityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Colocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Colocation_facilityId_idx" ON "Colocation"("facilityId");

ALTER TABLE "Colocation"
  ADD CONSTRAINT "Colocation_facilityId_fkey"
  FOREIGN KEY ("facilityId") REFERENCES "Facility"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Case-insensitive name uniqueness, mirroring ContactTag_label_key. Partial on live
-- rows so soft-deleting a facility frees its name for reuse.
CREATE UNIQUE INDEX "Facility_name_key" ON "Facility"(lower("name")) WHERE "deletedAt" IS NULL;

-- Split on the nullable FK, following Cluster_active_org_zone_provider_unique:
-- Postgres treats NULLs as distinct in a B-tree unique index, so the composite
-- index alone would silently admit two live facility-less colocations sharing a
-- name. `facilityId` is nullable by design and the FK is ON DELETE SET NULL, so
-- that row shape is reachable and needs its own global-scope index.
CREATE UNIQUE INDEX "Colocation_facilityId_name_key" ON "Colocation"("facilityId", lower("name"))
  WHERE "deletedAt" IS NULL AND "facilityId" IS NOT NULL;
CREATE UNIQUE INDEX "Colocation_name_without_facility_key" ON "Colocation"(lower("name"))
  WHERE "deletedAt" IS NULL AND "facilityId" IS NULL;

-- Zone gains an optional colocation. SET NULL, never CASCADE: deleting a colocation
-- must never delete zones (the service returns 409 while zones are still attached).
ALTER TABLE "Zone" ADD COLUMN "colocationId" TEXT;

CREATE INDEX "Zone_colocationId_idx" ON "Zone"("colocationId");

ALTER TABLE "Zone"
  ADD CONSTRAINT "Zone_colocationId_fkey"
  FOREIGN KEY ("colocationId") REFERENCES "Colocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Contact gains two more parents, cascading like the org/manufacturer parents.
ALTER TABLE "Contact"
  ADD COLUMN "facilityId" TEXT,
  ADD COLUMN "colocationId" TEXT;

CREATE INDEX "Contact_facilityId_idx" ON "Contact"("facilityId");
CREATE INDEX "Contact_colocationId_idx" ON "Contact"("colocationId");

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_facilityId_fkey"
  FOREIGN KEY ("facilityId") REFERENCES "Facility"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_colocationId_fkey"
  FOREIGN KEY ("colocationId") REFERENCES "Colocation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Widen the exactly-one-parent CHECK from 3 columns to 5.
ALTER TABLE "Contact" DROP CONSTRAINT "Contact_exactly_one_parent";
ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_exactly_one_parent"
  CHECK (num_nonnulls("zoneId", "organizationId", "manufacturerId", "facilityId", "colocationId") = 1);

-- Prevent duplicate active clusters for the same provider scope while still
-- allowing historical soft-deleted rows to coexist.
CREATE UNIQUE INDEX "Cluster_active_org_zone_provider_unique"
ON "Cluster" ("organizationId", "zoneId", "provider")
WHERE "dateDeleted" IS NULL AND "zoneId" IS NOT NULL;

CREATE UNIQUE INDEX "Cluster_active_org_provider_without_zone_unique"
ON "Cluster" ("organizationId", "provider")
WHERE "dateDeleted" IS NULL AND "zoneId" IS NULL;

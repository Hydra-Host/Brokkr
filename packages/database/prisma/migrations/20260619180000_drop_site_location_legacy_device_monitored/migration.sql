-- Drop the vestigial site/location columns, the retired LegacyDevice +
-- DeviceMetadata data cluster, and the dead `monitored` columns. All of these
-- are unread by application code post-NetBox-cutover (site/location identity is
-- now the Zone UUID; rentals/specs live on Device/Server). `IF EXISTS` keeps the
-- migration safe across partially-migrated environments.

-- ── Legacy data cluster ──────────────────────────────────────────────
-- DeviceTag (keyed by DeviceMetadata) and DeviceMetadata/LegacyDevice. CASCADE
-- drops the dependent FK constraints (e.g. DeviceTestRun_deviceMetadataId_fkey)
-- and indexes in one shot.
DROP TABLE IF EXISTS "DeviceTag" CASCADE;
DROP TABLE IF EXISTS "DeviceMetadata" CASCADE;
DROP TABLE IF EXISTS "LegacyDevice" CASCADE;
DROP TYPE IF EXISTS "DeviceTagType";

-- ── Device site/location + monitored ─────────────────────────────────
ALTER TABLE "Device" DROP COLUMN IF EXISTS "siteId";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "siteName";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "locationId";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "locationName";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "legacyDeviceId";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "monitored";

ALTER TABLE "Server" DROP COLUMN IF EXISTS "monitored";

-- ── OrganizationSiteContact.siteId (+ index) ─────────────────────────
DROP INDEX IF EXISTS "OrganizationSiteContact_siteId_idx";
ALTER TABLE "OrganizationSiteContact" DROP COLUMN IF EXISTS "siteId";
CREATE INDEX IF NOT EXISTS "OrganizationSiteContact_organizationId_idx" ON "OrganizationSiteContact"("organizationId");

-- ── ZoneRequest.siteId/locationId (+ index) ──────────────────────────
DROP INDEX IF EXISTS "ZoneRequest_siteId_idx";
ALTER TABLE "ZoneRequest" DROP COLUMN IF EXISTS "siteId";
ALTER TABLE "ZoneRequest" DROP COLUMN IF EXISTS "locationId";
CREATE INDEX IF NOT EXISTS "ZoneRequest_organizationId_idx" ON "ZoneRequest"("organizationId");

-- ── Cluster.locationId ───────────────────────────────────────────────
ALTER TABLE "Cluster" DROP COLUMN IF EXISTS "locationId";

-- Drop the legacy netboxId correlation column from all non-identity entities.
-- Device.netboxId + Zone.netboxSiteId/netboxLocationId + DeviceOnboardingProgress.netboxId
-- are the identity keys, handled in the follow-up re-key.
ALTER TABLE "Asn" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "BgpPeerGroup" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "BgpSession" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Cable" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Circuit" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "CircuitTermination" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "CircuitType" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "ConfigTemplate" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "ConsolePort" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "ConsoleServerPort" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "DcimRackRole" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "DeviceModel" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "FrontPort" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Gateway" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Interface" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "IpAddress" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "IpamPrefixVlanRole" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "IpRange" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Manufacturer" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "PowerOutlet" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "PowerPort" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Prefix" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "PrefixList" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "PrefixListRule" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Provider" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "ProviderNetwork" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Rack" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "RearPort" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Region" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Tag" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Vlan" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "VlanGroup" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Vrf" DROP COLUMN IF EXISTS "netboxId";

-- Identity columns: hub re-keys device/zone identity to the Brokkr UUID
-- (Device.id / Zone.id) since boss has no live NetBox spoke.
ALTER TABLE "Device" DROP COLUMN IF EXISTS "netboxId";
ALTER TABLE "Zone" DROP COLUMN IF EXISTS "netboxSiteId";
ALTER TABLE "Zone" DROP COLUMN IF EXISTS "netboxLocationId";
ALTER TABLE "DeviceOnboardingProgress" DROP COLUMN IF EXISTS "netboxId";

-- DiscoveryRun keyed device runs by the legacy NetBox int; the Brokkr
-- Device UUID (deviceId) is the sole identity now.
ALTER TABLE "DiscoveryRun" DROP COLUMN IF EXISTS "netboxDeviceId";

-- ZoneStatus re-key: drop the legacy NetBox (tenantId, siteId, locationId)
-- triplet identity in favor of the Brokkr Zone UUID. Boss has no live
-- bridges, so the table is effectively empty — a destructive drop is safe.
DROP INDEX IF EXISTS "ZoneStatus_tenantId_siteId_locationId_key";
DROP INDEX IF EXISTS "ZoneStatus_tenantId_siteId_locationId_isOnline_idx";
ALTER TABLE "ZoneStatus" DROP COLUMN IF EXISTS "tenantId" CASCADE;
ALTER TABLE "ZoneStatus" DROP COLUMN IF EXISTS "siteId" CASCADE;
ALTER TABLE "ZoneStatus" DROP COLUMN IF EXISTS "locationId" CASCADE;
-- Purge legacy rows that predate the zoneId FK; they're unrecoverable without
-- the dropped triplet and ZoneStatus is transient (rebuilt on next heartbeat).
DELETE FROM "ZoneStatus" WHERE "zoneId" IS NULL;
ALTER TABLE "ZoneStatus" ALTER COLUMN "zoneId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ZoneStatus_zoneId_key" ON "ZoneStatus"("zoneId");
CREATE INDEX IF NOT EXISTS "ZoneStatus_zoneId_isOnline_idx" ON "ZoneStatus"("zoneId", "isOnline");

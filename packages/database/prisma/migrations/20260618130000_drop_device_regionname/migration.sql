-- Drop the denormalized Device.regionName. A device's region is now derived
-- from its zone's geocoded Region (Device -> Zone -> Region.name) at read time,
-- so the stale NetBox-era denormalized copy is no longer a source of truth.
-- (LegacyDevice.regionName is left untouched — frozen archive, retired separately.)
ALTER TABLE "Device" DROP COLUMN IF EXISTS "regionName";

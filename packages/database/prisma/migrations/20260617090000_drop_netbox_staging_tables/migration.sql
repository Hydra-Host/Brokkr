-- The NetBox staging mirror tables are no longer read by any app code (the
-- east-west, datacenter-name, and datacenters-list readers now use the Brokkr
-- Zone). Drop them. CASCADE clears the inter-table FK constraints; no Brokkr
-- table references these.
DROP TABLE IF EXISTS "NetboxDevices" CASCADE;
DROP TABLE IF EXISTS "NetboxLocation" CASCADE;
DROP TABLE IF EXISTS "NetboxSite" CASCADE;
DROP TABLE IF EXISTS "NetboxTenant" CASCADE;
DROP TABLE IF EXISTS "NetboxTenantGroup" CASCADE;
DROP TABLE IF EXISTS "NetboxRegion" CASCADE;
DROP TABLE IF EXISTS "NetboxDeviceRole" CASCADE;
DROP TABLE IF EXISTS "NetboxPlatform" CASCADE;
DROP TABLE IF EXISTS "NetboxDeviceStatusChanges" CASCADE;

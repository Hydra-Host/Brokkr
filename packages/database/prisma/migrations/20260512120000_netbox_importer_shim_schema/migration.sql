-- Schema additions for the NetBox topology-importer shim
-- (apps/api/src/admin/netbox-topology-importer/).
--
-- The shim mirrors NetBox writes into Brokkr. Two custom-field columns
-- and one DeviceRole enum value are needed for that mirror to be lossless
-- for the fields the importer writes.

-- AlterEnum
-- Generic role used by the shim for fabric devices (leaf/spine/border/
-- oob switches). The granular per-role identity (slug, color, name) lives
-- only in real NetBox; the shim's POST /api/dcim/device-roles/ is a pure
-- proxy that doesn't mirror role rows. Devices the shim creates with any
-- unrecognized role slug land on this enum value.
ALTER TYPE "DeviceRole" ADD VALUE 'NetworkSwitch';

-- AlterTable
-- Mirrors NetBox cable `custom_fields.cable_details`. Written by the
-- shim's POST/PATCH /api/dcim/cables/ from response.custom_fields.cable_details.
ALTER TABLE "Cable" ADD COLUMN     "cableDetails" TEXT;

-- AlterTable
-- Mirrors NetBox prefix `custom_fields.location_prefix` (the NetBox
-- location id this prefix belongs to). Written by the shim's POST
-- /api/ipam/prefixes/ from response.custom_fields.location_prefix.
ALTER TABLE "Prefix" ADD COLUMN     "locationPrefix" INTEGER;

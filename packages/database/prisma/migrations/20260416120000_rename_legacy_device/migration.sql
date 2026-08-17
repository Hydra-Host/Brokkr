-- Rename the legacy `Device` table to `LegacyDevice` and prepare every
-- incoming FK to be repointed at the new `Device` table created by the
-- subsequent `netbox_port` migration. FKs are dropped here (not renamed)
-- because the UUID-preserving backfill in `netbox_port` copies every
-- `LegacyDevice.id` into `Device.id` verbatim, so the existing `deviceId`
-- columns on the 10 downstream tables continue to resolve after their FK
-- constraints are re-added against the new table.
--
-- Ordering: runs BEFORE `20260416200222_netbox_port` so the `Device` name
-- is free when that migration creates the replacement table.
--
-- Deliberately left alone by this migration:
--   * `StripePaymentIntent.deviceId` — points at `NetboxDevices`; both are
--     slated for removal, so no repoint work happens here.
--   * `DeviceTestRun.deviceId` — integer FK to `DeviceMetadata.id`, part
--     of the same legacy cluster going away later.
--   * `DeviceMetadata.legacyDeviceId` — renamed below to name the
--     relationship honestly; it stays pointed at `LegacyDevice`.

-- =====================================================================
-- 1. Rename the legacy table and its own indexes / constraints.
-- =====================================================================

ALTER TABLE "Device" RENAME TO "LegacyDevice";

ALTER INDEX "Device_pkey"       RENAME TO "LegacyDevice_pkey";
ALTER INDEX "Device_zoneId_idx" RENAME TO "LegacyDevice_zoneId_idx";

ALTER TABLE "LegacyDevice" RENAME CONSTRAINT "Device_supplierId_fkey" TO "LegacyDevice_supplierId_fkey";
ALTER TABLE "LegacyDevice" RENAME CONSTRAINT "Device_skuId_fkey"      TO "LegacyDevice_skuId_fkey";
ALTER TABLE "LegacyDevice" RENAME CONSTRAINT "Device_zoneId_fkey"     TO "LegacyDevice_zoneId_fkey";

-- =====================================================================
-- 2. `DeviceMetadata` keeps pointing at `LegacyDevice`. Rename the
--    column so it reads as what it actually is.
-- =====================================================================

ALTER TABLE "DeviceMetadata" RENAME COLUMN "deviceId" TO "legacyDeviceId";
ALTER TABLE "DeviceMetadata" RENAME CONSTRAINT "DeviceMetadata_deviceId_fkey" TO "DeviceMetadata_legacyDeviceId_fkey";
ALTER INDEX "DeviceMetadata_deviceId_key" RENAME TO "DeviceMetadata_legacyDeviceId_key";

-- =====================================================================
-- 3. Drop the incoming FK constraints on the 10 tables whose `deviceId`
--    columns will be repointed at the new `Device` by `netbox_port`.
--    The columns and their values are preserved; only the constraint is
--    dropped so the re-add against the new table can proceed.
-- =====================================================================

ALTER TABLE "Deployment"                 DROP CONSTRAINT "Deployment_deviceId_fkey";
ALTER TABLE "DeviceHealthCheck"          DROP CONSTRAINT "DeviceHealthCheck_deviceId_fkey";
ALTER TABLE "DeviceOperatingSystem"      DROP CONSTRAINT "DeviceOperatingSystem_deviceId_fkey";
ALTER TABLE "DevicePolicyConsent"        DROP CONSTRAINT "DevicePolicyConsent_deviceId_fkey";
ALTER TABLE "DevicesInReservation"       DROP CONSTRAINT "DevicesInReservation_deviceId_fkey";
ALTER TABLE "DevicesInReservationInvite" DROP CONSTRAINT "DevicesInReservationInvite_deviceId_fkey";
ALTER TABLE "InterruptibleClaim"         DROP CONSTRAINT "InterruptibleClaim_deviceId_fkey";
ALTER TABLE "Job"                        DROP CONSTRAINT "Job_deviceId_fkey";
ALTER TABLE "LenderDeviceAssociation"    DROP CONSTRAINT "LenderDeviceAssociation_deviceId_fkey";
ALTER TABLE "SubscriptionItem"           DROP CONSTRAINT "SubscriptionItem_deviceId_fkey";

-- =====================================================================
-- 4. Relax `Job.deviceId` to nullable. Previously enforced by the now-
--    superseded `20260416211252_job_with_brokkr_device` migration; folded
--    here so that migration can be deleted.
-- =====================================================================

ALTER TABLE "Job" ALTER COLUMN "deviceId" DROP NOT NULL;

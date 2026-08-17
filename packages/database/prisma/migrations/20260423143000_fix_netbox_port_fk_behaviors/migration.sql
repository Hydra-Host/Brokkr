-- Reconcile the on-delete behavior of nine FKs that were re-created by the
-- `20260416200222_netbox_port` migration with `ON DELETE SET NULL`, even
-- though the prisma models had always specified `Restrict` (default) or
-- `Cascade`. This migration drops and re-adds each FK to match the model
-- definitions, restoring the intended referential semantics.
--
-- Background:
--   `20260416120000_rename_legacy_device` dropped 10 FKs pointing at the
--   old `Device` table so that `20260416200222_netbox_port` could repoint
--   them at the new `Device` table after a UUID-preserving backfill. That
--   re-add step uniformly emitted `ON DELETE SET NULL` for every FK
--   regardless of what the prisma model said. The result was a long-lived
--   silent drift between the migration history and the models.
--
-- Safety:
--   The brokkr API never hard-deletes a Device (only the discovery test
--   seeder in `apps/api/src/brokkr-bridge/discovery/__test__/seed-devices.ts`
--   does, and it pre-deletes children). Switching SET NULL -> RESTRICT is
--   therefore non-disruptive in practice; it just makes the constraint
--   match what we always intended.
--
-- Behavior changes summarized:
--   Deployment.deviceId                 SET NULL -> RESTRICT
--   DeviceHealthCheck.deviceId          SET NULL -> RESTRICT
--   DeviceOperatingSystem.deviceId      SET NULL -> RESTRICT
--   DevicePolicyConsent.deviceId        SET NULL -> CASCADE
--   DevicesInReservation.deviceId       SET NULL -> RESTRICT
--   DevicesInReservationInvite.deviceId SET NULL -> RESTRICT
--   InterruptibleClaim.deviceId         SET NULL -> RESTRICT
--   LenderDeviceAssociation.deviceId    SET NULL -> CASCADE
--   DeviceTestRun.deviceMetadataId      (none)   -> SET NULL  (FK didn't exist before)

-- DropForeignKey
ALTER TABLE "Deployment" DROP CONSTRAINT "Deployment_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceHealthCheck" DROP CONSTRAINT "DeviceHealthCheck_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceOperatingSystem" DROP CONSTRAINT "DeviceOperatingSystem_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DevicePolicyConsent" DROP CONSTRAINT "DevicePolicyConsent_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceTestRun" DROP CONSTRAINT "DeviceTestRun_deviceMetadataId_fkey";

-- DropForeignKey
ALTER TABLE "DevicesInReservation" DROP CONSTRAINT "DevicesInReservation_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DevicesInReservationInvite" DROP CONSTRAINT "DevicesInReservationInvite_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "InterruptibleClaim" DROP CONSTRAINT "InterruptibleClaim_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "LenderDeviceAssociation" DROP CONSTRAINT "LenderDeviceAssociation_deviceId_fkey";

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceHealthCheck" ADD CONSTRAINT "DeviceHealthCheck_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceOperatingSystem" ADD CONSTRAINT "DeviceOperatingSystem_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePolicyConsent" ADD CONSTRAINT "DevicePolicyConsent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceTestRun" ADD CONSTRAINT "DeviceTestRun_deviceMetadataId_fkey" FOREIGN KEY ("deviceMetadataId") REFERENCES "DeviceMetadata"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicesInReservation" ADD CONSTRAINT "DevicesInReservation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicesInReservationInvite" ADD CONSTRAINT "DevicesInReservationInvite_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LenderDeviceAssociation" ADD CONSTRAINT "LenderDeviceAssociation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

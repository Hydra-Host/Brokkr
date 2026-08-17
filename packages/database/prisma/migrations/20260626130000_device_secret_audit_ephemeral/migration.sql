-- Ephemeral seals (onboarding pre-flight / PXE enrichment) dispatch operator BMC credentials to a
-- zone with no persistent Device row. To keep the disclosure-audit invariant ("every disclosure of
-- sealed material to a zone is recorded"), DeviceSecretAuditEvent.deviceId becomes nullable and a
-- nullable zoneId is added so a device-less DISPATCH can be recorded against the target zone.

-- AlterTable
ALTER TABLE "DeviceSecretAuditEvent" ALTER COLUMN "deviceId" DROP NOT NULL;
ALTER TABLE "DeviceSecretAuditEvent" ADD COLUMN "zoneId" TEXT;

-- CreateIndex
CREATE INDEX "DeviceSecretAuditEvent_zoneId_createdAt_idx" ON "DeviceSecretAuditEvent"("zoneId", "createdAt");

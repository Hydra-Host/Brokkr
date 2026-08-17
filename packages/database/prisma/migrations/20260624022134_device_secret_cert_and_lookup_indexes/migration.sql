-- AlterEnum
ALTER TYPE "DeviceSecretKind" ADD VALUE 'CERT';

-- DropIndex
DROP INDEX "DeviceSecret_deviceId_idx";

-- CreateIndex: per-(device, purpose) version walks (current = MAX(version) … the read paths scope by purpose).
CREATE INDEX "DeviceSecret_deviceId_purpose_idx" ON "DeviceSecret"("deviceId", "purpose");

-- CreateIndex: atom lookups — narrowest seal is one (device, purpose, kind) row.
CREATE INDEX "DeviceSecret_deviceId_purpose_kind_idx" ON "DeviceSecret"("deviceId", "purpose", "kind");

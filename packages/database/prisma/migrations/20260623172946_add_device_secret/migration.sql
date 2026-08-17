-- CreateEnum
CREATE TYPE "DeviceSecretPurpose" AS ENUM ('BMC', 'CONSOLE');

-- CreateEnum
CREATE TYPE "DeviceSecretKind" AS ENUM ('USER', 'KEY', 'TOKEN');

-- AlterTable
ALTER TABLE "ZoneEnrollment" ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "DeviceSecret" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "purpose" "DeviceSecretPurpose" NOT NULL,
    "kind" "DeviceSecretKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "ephPub" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "zoneId" TEXT NOT NULL,
    "zoneKeyId" TEXT NOT NULL,
    "keyGen" INTEGER NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "DeviceSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceSecret_deviceId_idx" ON "DeviceSecret"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceSecret_zoneId_idx" ON "DeviceSecret"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSecret_deviceId_purpose_version_key" ON "DeviceSecret"("deviceId", "purpose", "version");

-- AddForeignKey
ALTER TABLE "DeviceSecret" ADD CONSTRAINT "DeviceSecret_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSecret" ADD CONSTRAINT "DeviceSecret_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSecret" ADD CONSTRAINT "DeviceSecret_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

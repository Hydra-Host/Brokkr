/*
  Warnings:

  - A unique constraint covering the columns `[systemUuid]` on the table `Device` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[slug]` on the table `DeviceModel` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[organizationId,slug]` on the table `Tag` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DiscoveryIssuePhase" AS ENUM ('INGRESS', 'SCHEMA', 'HANDLER', 'COMPOSER', 'COMMIT');

-- CreateEnum
CREATE TYPE "DiscoveryIssueSeverity" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "GpuCcMode" AS ENUM ('OFF', 'ON', 'DEVTOOLS');

-- CreateEnum
CREATE TYPE "ZoneNetworkType" AS ENUM ('FLAT', 'VPC');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FirmwareType" ADD VALUE 'NIC_FW';
ALTER TYPE "FirmwareType" ADD VALUE 'BMC_FW_BUILD';

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "architecture" TEXT,
ADD COLUMN     "assetTag" TEXT,
ADD COLUMN     "baseboardSerial" TEXT,
ADD COLUMN     "chassisSerial" TEXT,
ADD COLUMN     "iommuEnabled" BOOLEAN,
ADD COLUMN     "kernelCmdline" TEXT,
ADD COLUMN     "productSku" TEXT,
ADD COLUMN     "secureBootEnabled" BOOLEAN,
ADD COLUMN     "sriovEnabled" BOOLEAN,
ADD COLUMN     "systemUuid" TEXT;

-- AlterTable
ALTER TABLE "DeviceModel" ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "Gpu" ADD COLUMN     "architecture" TEXT,
ADD COLUMN     "ccMode" "GpuCcMode",
ADD COLUMN     "computeCapability" TEXT,
ADD COLUMN     "driverVersion" TEXT,
ADD COLUMN     "migMode" BOOLEAN,
ADD COLUMN     "migProfile" TEXT;

-- AlterTable
ALTER TABLE "Interface" ADD COLUMN     "driver" TEXT,
ADD COLUMN     "linkOperUp" BOOLEAN,
ADD COLUMN     "linkPhysicalUp" BOOLEAN,
ADD COLUMN     "markConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "operstate" TEXT;

-- AlterTable
ALTER TABLE "IpRange" ADD COLUMN     "zoneId" TEXT;

-- AlterTable
ALTER TABLE "Prefix" ADD COLUMN     "associatedPrefixId" TEXT,
ADD COLUMN     "bondParameters" JSONB,
ADD COLUMN     "keaSubnetId" INTEGER;

-- AlterTable
ALTER TABLE "StorageDrive" ADD COLUMN     "busPath" TEXT,
ADD COLUMN     "physicalBlockBytes" INTEGER,
ADD COLUMN     "storageController" TEXT;

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "Zone" ADD COLUMN     "ipxeBuildTarget" TEXT,
ADD COLUMN     "ipxeBuildVersion" TEXT,
ADD COLUMN     "networkType" "ZoneNetworkType" NOT NULL DEFAULT 'FLAT';

-- CreateTable
CREATE TABLE "DeviceSolConfig" (
    "deviceId" TEXT NOT NULL,
    "solCapable" BOOLEAN,
    "solEnabled" BOOLEAN,
    "hardwareChannel" INTEGER,
    "baudRate" INTEGER,
    "port" INTEGER,
    "encryptionCapable" BOOLEAN,
    "optimalPort" TEXT,
    "bmcChannelMapping" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceSolConfig_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "netboxDeviceId" INTEGER NOT NULL,
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'STARTED',
    "jobId" TEXT NOT NULL,
    "zonePrefix" TEXT NOT NULL,
    "handlerVersion" TEXT NOT NULL,
    "bridgeCollectorVersion" TEXT,
    "collectorsExpected" INTEGER,
    "collectorsReceived" INTEGER,
    "collectorsApplied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collectorsSkipped" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "composersApplied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "s3Prefix" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRunIssue" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "phase" "DiscoveryIssuePhase" NOT NULL,
    "collector" TEXT,
    "code" TEXT NOT NULL,
    "severity" "DiscoveryIssueSeverity" NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryRunIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NvlinkEdge" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sourceGpuIndex" INTEGER NOT NULL,
    "targetGpuIndex" INTEGER NOT NULL,
    "lanes" INTEGER,
    "bandwidthGbps" DECIMAL(65,30),
    "linkStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NvlinkEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PciDevice" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorName" TEXT,
    "productId" TEXT NOT NULL,
    "productName" TEXT,
    "className" TEXT,
    "subclassName" TEXT,
    "driver" TEXT,
    "subsystemVendorId" TEXT,
    "subsystemProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PciDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UefiBootEntry" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "bootOptionReference" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "uefiDevicePath" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bootOrderIndex" INTEGER,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UefiBootEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscoveryRun_deviceId_startedAt_idx" ON "DiscoveryRun"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "DiscoveryRun_status_idx" ON "DiscoveryRun"("status");

-- CreateIndex
CREATE INDEX "DiscoveryRun_jobId_idx" ON "DiscoveryRun"("jobId");

-- CreateIndex
CREATE INDEX "DiscoveryRunIssue_runId_idx" ON "DiscoveryRunIssue"("runId");

-- CreateIndex
CREATE INDEX "DiscoveryRunIssue_collector_code_idx" ON "DiscoveryRunIssue"("collector", "code");

-- CreateIndex
CREATE INDEX "DiscoveryRunIssue_severity_createdAt_idx" ON "DiscoveryRunIssue"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "NvlinkEdge_deviceId_idx" ON "NvlinkEdge"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "NvlinkEdge_deviceId_sourceGpuIndex_targetGpuIndex_key" ON "NvlinkEdge"("deviceId", "sourceGpuIndex", "targetGpuIndex");

-- CreateIndex
CREATE INDEX "PciDevice_deviceId_idx" ON "PciDevice"("deviceId");

-- CreateIndex
CREATE INDEX "PciDevice_vendorId_productId_idx" ON "PciDevice"("vendorId", "productId");

-- CreateIndex
CREATE INDEX "PciDevice_className_idx" ON "PciDevice"("className");

-- CreateIndex
CREATE UNIQUE INDEX "PciDevice_deviceId_address_key" ON "PciDevice"("deviceId", "address");

-- CreateIndex
CREATE INDEX "UefiBootEntry_deviceId_idx" ON "UefiBootEntry"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "UefiBootEntry_deviceId_bootOptionReference_key" ON "UefiBootEntry"("deviceId", "bootOptionReference");

-- CreateIndex
CREATE UNIQUE INDEX "Device_systemUuid_key" ON "Device"("systemUuid");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_slug_key" ON "DeviceModel"("slug");

-- CreateIndex
CREATE INDEX "IpRange_zoneId_idx" ON "IpRange"("zoneId");

-- CreateIndex
CREATE INDEX "Prefix_associatedPrefixId_idx" ON "Prefix"("associatedPrefixId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_slug_key" ON "Tag"("organizationId", "slug");

-- AddForeignKey
ALTER TABLE "DeviceSolConfig" ADD CONSTRAINT "DeviceSolConfig_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRunIssue" ADD CONSTRAINT "DiscoveryRunIssue_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_associatedPrefixId_fkey" FOREIGN KEY ("associatedPrefixId") REFERENCES "Prefix"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvlinkEdge" ADD CONSTRAINT "NvlinkEdge_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PciDevice" ADD CONSTRAINT "PciDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UefiBootEntry" ADD CONSTRAINT "UefiBootEntry_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

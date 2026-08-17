/*
  Warnings:

  - You are about to drop the `Reservation` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('Hypervisor', 'Baremetal');

-- DropForeignKey
-- ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_organizationId_fkey";

-- AlterTable
ALTER TABLE "DeprecatedDevice" RENAME CONSTRAINT "Device_pkey" TO "DeprecatedDevice_pkey";
ALTER TABLE "DeprecatedDevice" ADD COLUMN "sSHKeyPairId" TEXT;

-- -- DropTable
-- DROP TABLE "Reservation";

-- CreateTable
CREATE TABLE "DeviceMetadata" (
    "id" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "role" "DeviceRole" NOT NULL,
    "siteId" INTEGER NOT NULL,
    "siteName" TEXT NOT NULL,
    "locationId" INTEGER NOT NULL,
    "locationName" TEXT NOT NULL,
    "clusterId" INTEGER,
    "clusterName" TEXT,
    "primaryIp4" TEXT NOT NULL,
    "primaryIp6" TEXT NOT NULL,
    "cpuModel" TEXT NOT NULL,
    "cpuThreadCount" INTEGER NOT NULL,
    "cpuCoreCount" INTEGER NOT NULL,
    "cpuPhysicalCount" INTEGER NOT NULL,
    "ipamConfig" JSONB NOT NULL,
    "virtualNetworkConfig" JSONB NOT NULL,
    "memory" INTEGER NOT NULL,
    "nvmeSize" INTEGER,
    "nvmeCount" INTEGER,
    "ssdSize" INTEGER,
    "ssdCount" INTEGER,
    "hddSize" INTEGER,
    "hddCount" INTEGER,
    "gpuModel" TEXT,
    "gpuCount" INTEGER,
    "deviceId" TEXT NOT NULL,

    CONSTRAINT "DeviceMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "deviceType" "DeviceType" NOT NULL,
    "stripeProductId" TEXT NOT NULL,
    "defaultStripePriceId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deviceMetadataId" INTEGER NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatingSystem" (
    "id" TEXT NOT NULL,
    "netboxPlatformId" INTEGER NOT NULL,
    "description" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "osDistribution" TEXT NOT NULL,
    "osVersion" TEXT NOT NULL,

    CONSTRAINT "OperatingSystem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceOperatingSystem" (
    "deviceId" TEXT NOT NULL,
    "operatingSystemId" TEXT NOT NULL,

    CONSTRAINT "DeviceOperatingSystem_pkey" PRIMARY KEY ("deviceId","operatingSystemId")
);

-- CreateTable
CREATE TABLE "DeviceReservation" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "saleStripePriceId" TEXT NOT NULL,
    "reserverId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "dateAccepted" TIMESTAMP(3),
    "dateDeleted" TIMESTAMP(3),
    "dateExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceMetadata_id_key" ON "DeviceMetadata"("id");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceMetadata_deviceId_key" ON "DeviceMetadata"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "OperatingSystem_netboxPlatformId_key" ON "OperatingSystem"("netboxPlatformId");

-- AddForeignKey
ALTER TABLE "DeprecatedDevice" ADD CONSTRAINT "DeprecatedDevice_sSHKeyPairId_fkey" FOREIGN KEY ("sSHKeyPairId") REFERENCES "SSHKeyPair"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMetadata" ADD CONSTRAINT "DeviceMetadata_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceOperatingSystem" ADD CONSTRAINT "DeviceOperatingSystem_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceOperatingSystem" ADD CONSTRAINT "DeviceOperatingSystem_operatingSystemId_fkey" FOREIGN KEY ("operatingSystemId") REFERENCES "OperatingSystem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceReservation" ADD CONSTRAINT "DeviceReservation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceReservation" ADD CONSTRAINT "DeviceReservation_reserverId_fkey" FOREIGN KEY ("reserverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceReservation" ADD CONSTRAINT "DeviceReservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

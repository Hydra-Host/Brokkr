/*
  Warnings:

  - The primary key for the `NetboxDevices` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `cores` on the `NetboxDevices` table. All the data in the column will be lost.
  - You are about to drop the column `disks` on the `NetboxDevices` table. All the data in the column will be lost.
  - You are about to drop the column `gpu` on the `NetboxDevices` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `NetboxDevices` table. All the data in the column will be lost.
  - You are about to drop the column `location` on the `NetboxDevices` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `NetboxDevices` table. All the data in the column will be lost.
  - You are about to drop the column `storage` on the `NetboxDevices` table. All the data in the column will be lost.
  - You are about to drop the column `tenantId` on the `NetboxDevices` table. All the data in the column will be lost.
  - You are about to drop the `NetboxOrganization` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[deviceId]` on the table `NetboxDevices` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `cpuCoreCount` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `cpuModel` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `cpuPhysicalCount` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `cpuThreadCount` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `deviceId` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `primaryIp4` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `primaryIp6` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `serial` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `siteId` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `siteName` to the `NetboxDevices` table without a default value. This is not possible if the table is not empty.
  - Made the column `status` on table `NetboxDevices` required. This step will fail if there are existing NULL values in that column.
  - Made the column `memory` on table `NetboxDevices` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "readonly"."NetboxDevices" DROP CONSTRAINT "NetboxDevices_tenantId_fkey";

-- AlterTable
ALTER TABLE "readonly"."NetboxDevices" DROP CONSTRAINT "NetboxDevices_pkey",
DROP COLUMN "cores",
DROP COLUMN "disks",
DROP COLUMN "gpu",
DROP COLUMN "id",
DROP COLUMN "location",
DROP COLUMN "name",
DROP COLUMN "storage",
DROP COLUMN "tenantId",
ADD COLUMN     "clusterId" INTEGER,
ADD COLUMN     "clusterName" TEXT,
ADD COLUMN     "cpuCoreCount" INTEGER NOT NULL,
ADD COLUMN     "cpuModel" TEXT NOT NULL,
ADD COLUMN     "cpuPhysicalCount" INTEGER NOT NULL,
ADD COLUMN     "cpuThreadCount" INTEGER NOT NULL,
ADD COLUMN     "deviceId" TEXT NOT NULL,
ADD COLUMN     "gpuCount" INTEGER,
ADD COLUMN     "gpuModel" TEXT,
ADD COLUMN     "hddCount" INTEGER,
ADD COLUMN     "hddSize" INTEGER,
ADD COLUMN     "ipamConfig" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "locationId" INTEGER,
ADD COLUMN     "locationName" TEXT,
ADD COLUMN     "macAddress" TEXT DEFAULT '',
ADD COLUMN     "netboxTenantId" INTEGER,
ADD COLUMN     "nvmeCount" INTEGER,
ADD COLUMN     "nvmeSize" INTEGER,
ADD COLUMN     "primaryIp4" TEXT NOT NULL,
ADD COLUMN     "primaryIp6" TEXT NOT NULL,
ADD COLUMN     "role" "public"."DeviceRole" NOT NULL DEFAULT 'Baremetal',
ADD COLUMN     "serial" TEXT NOT NULL,
ADD COLUMN     "siteId" INTEGER NOT NULL,
ADD COLUMN     "siteName" TEXT NOT NULL,
ADD COLUMN     "ssdCount" INTEGER,
ADD COLUMN     "ssdSize" INTEGER,
ADD COLUMN     "storageLayouts" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "virtualNetworkConfig" JSONB NOT NULL DEFAULT '{}',
ALTER COLUMN "status" SET NOT NULL,
ALTER COLUMN "memory" SET NOT NULL;

-- DropTable
DROP TABLE "readonly"."NetboxOrganization";

-- CreateTable
CREATE TABLE "readonly"."NetboxTenantGroup" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "NetboxTenantGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readonly"."NetboxTenant" (
    "tenantId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT,
    "displayName" TEXT,
    "groupId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdated" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetboxTenant_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "readonly"."NetboxDeviceRole" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "NetboxDeviceRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readonly"."NetboxRegion" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "customFieldData" JSONB NOT NULL DEFAULT '{}',
    "lft" INTEGER NOT NULL,
    "rght" INTEGER NOT NULL,
    "treeId" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,

    CONSTRAINT "NetboxRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readonly"."NetboxSite" (
    "id" INTEGER NOT NULL,
    "customFieldData" JSONB NOT NULL DEFAULT '{}',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "facility" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "physicalAddress" TEXT NOT NULL,
    "shippingAddress" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "groupId" INTEGER,
    "regionId" INTEGER,
    "tenantId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetboxSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readonly"."NetboxLocation" (
    "id" INTEGER NOT NULL,
    "customFieldData" JSONB NOT NULL DEFAULT '{}',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "lft" INTEGER NOT NULL,
    "rght" INTEGER NOT NULL,
    "treeId" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "parentId" INTEGER,
    "siteId" INTEGER NOT NULL,
    "tenantId" INTEGER,
    "status" TEXT NOT NULL,
    "facility" TEXT NOT NULL,

    CONSTRAINT "NetboxLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NetboxDevices_deviceId_key" ON "readonly"."NetboxDevices"("deviceId");

-- AddForeignKey
ALTER TABLE "readonly"."NetboxTenant" ADD CONSTRAINT "NetboxTenant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "readonly"."NetboxTenantGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readonly"."NetboxSite" ADD CONSTRAINT "NetboxSite_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "readonly"."NetboxRegion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readonly"."NetboxLocation" ADD CONSTRAINT "NetboxLocation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "readonly"."NetboxSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readonly"."NetboxLocation" ADD CONSTRAINT "NetboxLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "readonly"."NetboxTenant"("tenantId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readonly"."NetboxDevices" ADD CONSTRAINT "NetboxDevices_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "readonly"."NetboxSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readonly"."NetboxDevices" ADD CONSTRAINT "NetboxDevices_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "readonly"."NetboxLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readonly"."NetboxDevices" ADD CONSTRAINT "NetboxDevices_netboxTenantId_fkey" FOREIGN KEY ("netboxTenantId") REFERENCES "readonly"."NetboxTenant"("tenantId") ON DELETE SET NULL ON UPDATE CASCADE;

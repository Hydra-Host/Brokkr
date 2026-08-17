-- DropForeignKey
ALTER TABLE "readonly"."NetboxDevices" DROP CONSTRAINT "NetboxDevices_siteId_fkey";

-- DropForeignKey
ALTER TABLE "readonly"."NetboxLocation" DROP CONSTRAINT "NetboxLocation_siteId_fkey";

-- AlterTable
ALTER TABLE "readonly"."NetboxDevices" ALTER COLUMN "memory" DROP NOT NULL,
ALTER COLUMN "cpuCoreCount" DROP NOT NULL,
ALTER COLUMN "cpuModel" DROP NOT NULL,
ALTER COLUMN "cpuPhysicalCount" DROP NOT NULL,
ALTER COLUMN "cpuThreadCount" DROP NOT NULL,
ALTER COLUMN "ipamConfig" DROP NOT NULL,
ALTER COLUMN "primaryIp4" DROP NOT NULL,
ALTER COLUMN "primaryIp6" DROP NOT NULL,
ALTER COLUMN "serial" DROP NOT NULL,
ALTER COLUMN "siteId" DROP NOT NULL,
ALTER COLUMN "siteName" DROP NOT NULL,
ALTER COLUMN "storageLayouts" DROP NOT NULL,
ALTER COLUMN "virtualNetworkConfig" DROP NOT NULL;

-- AlterTable
ALTER TABLE "readonly"."NetboxLocation" ALTER COLUMN "siteId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "readonly"."NetboxSite" ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "slug" DROP NOT NULL,
ALTER COLUMN "status" DROP NOT NULL,
ALTER COLUMN "facility" DROP NOT NULL,
ALTER COLUMN "timeZone" DROP NOT NULL,
ALTER COLUMN "description" DROP NOT NULL,
ALTER COLUMN "physicalAddress" DROP NOT NULL,
ALTER COLUMN "shippingAddress" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "readonly"."NetboxLocation" ADD CONSTRAINT "NetboxLocation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "readonly"."NetboxSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readonly"."NetboxDevices" ADD CONSTRAINT "NetboxDevices_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "readonly"."NetboxSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

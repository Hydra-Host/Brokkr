-- AlterTable
ALTER TABLE "DeviceMetadata" ALTER COLUMN "cpuThreadCount" DROP NOT NULL,
ALTER COLUMN "cpuCoreCount" DROP NOT NULL,
ALTER COLUMN "cpuPhysicalCount" DROP NOT NULL,
ALTER COLUMN "ipamConfig" DROP NOT NULL,
ALTER COLUMN "virtualNetworkConfig" DROP NOT NULL;

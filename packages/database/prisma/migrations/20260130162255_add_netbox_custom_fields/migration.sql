-- AlterTable
ALTER TABLE "DeviceMetadata" ADD COLUMN     "instanceId" TEXT,
ADD COLUMN     "ipmiBootDeviceOverride" TEXT,
ADD COLUMN     "lastJobId" TEXT,
ADD COLUMN     "purgeTtys" BOOLEAN,
ADD COLUMN     "serialPorts" JSONB;

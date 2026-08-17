-- DropForeignKey
ALTER TABLE "ZoneStatus" DROP CONSTRAINT "ZoneStatus_zoneId_fkey";

-- DropIndex
DROP INDEX "ZoneStatus_zoneId_idx";

-- AlterTable
ALTER TABLE "DeviceToken" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DeviceTokenAuditEvent" ALTER COLUMN "id" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "ZoneStatus" ADD CONSTRAINT "ZoneStatus_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

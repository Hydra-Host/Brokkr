/*
  Warnings:

  - You are about to drop the column `zone` on the `BridgeHeartbeat` table. All the data in the column will be lost.
  - You are about to drop the column `zone` on the `ZoneStatus` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[tenantId,siteId,locationId]` on the table `ZoneStatus` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `locationId` to the `BridgeHeartbeat` table without a default value. This is not possible if the table is not empty.
  - Added the required column `siteId` to the `BridgeHeartbeat` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenantId` to the `BridgeHeartbeat` table without a default value. This is not possible if the table is not empty.
  - Added the required column `locationId` to the `ZoneStatus` table without a default value. This is not possible if the table is not empty.
  - Added the required column `siteId` to the `ZoneStatus` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenantId` to the `ZoneStatus` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "BridgeHeartbeat_zone_receivedAt_idx";

-- DropIndex
DROP INDEX "BridgeHeartbeat_zone_startTime_idx";

-- DropIndex
DROP INDEX "ZoneStatus_zone_isOnline_idx";

-- DropIndex
DROP INDEX "ZoneStatus_zone_key";

-- AlterTable
ALTER TABLE "BridgeHeartbeat" DROP COLUMN "zone",
ADD COLUMN     "locationId" INTEGER NOT NULL,
ADD COLUMN     "siteId" INTEGER NOT NULL,
ADD COLUMN     "tenantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "ZoneStatus" DROP COLUMN "zone",
ADD COLUMN     "locationId" INTEGER NOT NULL,
ADD COLUMN     "siteId" INTEGER NOT NULL,
ADD COLUMN     "tenantId" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "BridgeHeartbeat_tenantId_siteId_locationId_receivedAt_idx" ON "BridgeHeartbeat"("tenantId", "siteId", "locationId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "BridgeHeartbeat_tenantId_siteId_locationId_startTime_idx" ON "BridgeHeartbeat"("tenantId", "siteId", "locationId", "startTime");

-- CreateIndex
CREATE INDEX "ZoneStatus_tenantId_siteId_locationId_isOnline_idx" ON "ZoneStatus"("tenantId", "siteId", "locationId", "isOnline");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneStatus_tenantId_siteId_locationId_key" ON "ZoneStatus"("tenantId", "siteId", "locationId");

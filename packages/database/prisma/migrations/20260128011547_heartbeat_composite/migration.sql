/*
  Warnings:

  - The primary key for the `BridgeHeartbeat` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `BridgeHeartbeat` table. All the data in the column will be lost.
  - The primary key for the `DeviceHealthCheck` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `heartbeatId` on the `DeviceHealthCheck` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `DeviceHealthCheck` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "DeviceHealthCheck" DROP CONSTRAINT "DeviceHealthCheck_heartbeatId_fkey";

-- DropIndex
DROP INDEX "BridgeHeartbeat_jobId_key";

-- DropIndex
DROP INDEX "DeviceHealthCheck_heartbeatId_deviceId_key";

-- DropIndex
DROP INDEX "DeviceHealthCheck_heartbeatId_idx";

-- AlterTable
ALTER TABLE "BridgeHeartbeat" DROP CONSTRAINT "BridgeHeartbeat_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "BridgeHeartbeat_pkey" PRIMARY KEY ("jobId");

-- AlterTable
ALTER TABLE "DeviceHealthCheck" DROP CONSTRAINT "DeviceHealthCheck_pkey",
DROP COLUMN "heartbeatId",
DROP COLUMN "id",
ADD CONSTRAINT "DeviceHealthCheck_pkey" PRIMARY KEY ("jobId", "deviceId");

-- AddForeignKey
ALTER TABLE "DeviceHealthCheck" ADD CONSTRAINT "DeviceHealthCheck_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BridgeHeartbeat"("jobId") ON DELETE CASCADE ON UPDATE CASCADE;

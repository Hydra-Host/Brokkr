/*
  Warnings:

  - Made the column `cpuModel` on table `DeviceMetadata` required. This step will fail if there are existing NULL values in that column.
  - Made the column `cpuThreadCount` on table `DeviceMetadata` required. This step will fail if there are existing NULL values in that column.
  - Made the column `cpuCoreCount` on table `DeviceMetadata` required. This step will fail if there are existing NULL values in that column.
  - Made the column `cpuPhysicalCount` on table `DeviceMetadata` required. This step will fail if there are existing NULL values in that column.
  - Made the column `ipamConfig` on table `DeviceMetadata` required. This step will fail if there are existing NULL values in that column.
  - Made the column `virtualNetworkConfig` on table `DeviceMetadata` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "DeviceMetadata" ALTER COLUMN "cpuModel" SET NOT NULL,
ALTER COLUMN "cpuThreadCount" SET NOT NULL,
ALTER COLUMN "cpuCoreCount" SET NOT NULL,
ALTER COLUMN "cpuPhysicalCount" SET NOT NULL,
ALTER COLUMN "ipamConfig" SET NOT NULL,
ALTER COLUMN "virtualNetworkConfig" SET NOT NULL;

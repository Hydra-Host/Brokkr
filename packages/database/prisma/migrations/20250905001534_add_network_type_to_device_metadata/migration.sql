-- CreateEnum
CREATE TYPE "DeviceNetworkType" AS ENUM ('NAT', 'Public');

-- AlterTable
ALTER TABLE "DeviceMetadata" ADD COLUMN     "networkType" "DeviceNetworkType";

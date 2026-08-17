/*
  Warnings:

  - You are about to drop the column `directProvisioning` on the `FeatureFlags` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "DeviceTagType" AS ENUM ('Compute', 'LegacyLifecycle');

-- AlterTable
ALTER TABLE "FeatureFlags" DROP COLUMN "directProvisioning";

-- CreateTable
CREATE TABLE "DeviceTag" (
    "type" "DeviceTagType" NOT NULL,
    "deviceMetadataId" INTEGER NOT NULL,

    CONSTRAINT "DeviceTag_pkey" PRIMARY KEY ("deviceMetadataId","type")
);

-- AddForeignKey
ALTER TABLE "DeviceTag" ADD CONSTRAINT "DeviceTag_deviceMetadataId_fkey" FOREIGN KEY ("deviceMetadataId") REFERENCES "DeviceMetadata"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "GpuBusType" AS ENUM ('PCIE', 'SXM5', 'NVL', 'OAM', 'OTHER');

-- AlterTable
ALTER TABLE "OfferListing" ADD COLUMN "gpusPerNode" INTEGER;
ALTER TABLE "OfferListing" ADD COLUMN "gpuBusType" "GpuBusType";

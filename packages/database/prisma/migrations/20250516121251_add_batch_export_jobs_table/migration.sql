-- CreateEnum
CREATE TYPE "BatchExportJobStatus" AS ENUM ('Pending', 'Completed', 'Failed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobType" ADD VALUE 'PowerOn';
ALTER TYPE "JobType" ADD VALUE 'PowerOff';

-- CreateTable
CREATE TABLE "BatchExportJobs" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "location" TEXT,
    "locationExpiration" TIMESTAMP(3),
    "status" "BatchExportJobStatus" NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatchExportJobs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BatchExportJobs" ADD CONSTRAINT "BatchExportJobs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

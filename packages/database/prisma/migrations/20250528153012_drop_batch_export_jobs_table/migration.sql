/*
  Warnings:

  - You are about to drop the `BatchExportJobs` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "BatchExportJobs" DROP CONSTRAINT "BatchExportJobs_customerId_fkey";

-- DropTable
DROP TABLE "BatchExportJobs";

-- DropEnum
DROP TYPE "BatchExportJobStatus";

/*
  Warnings:

  - The values [Evaluating] on the enum `OnboardingStatus` will be removed. If these variants are still used in the database, this will fail.
  - The primary key for the `DeviceHealthCheck` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `jobId` on the `DeviceHealthCheck` table. All the data in the column will be lost.
  - The required column `id` was added to the `DeviceHealthCheck` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('Pending', 'InProgress', 'Completed', 'Failed');

-- AlterEnum
BEGIN;
CREATE TYPE "OnboardingStatus_new" AS ENUM ('Queued', 'InProgress', 'Done', 'Timeout', 'Failed');
ALTER TABLE "public"."DeviceOnboardingProgress" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "DeviceOnboardingProgress" ALTER COLUMN "status" TYPE "OnboardingStatus_new" USING ("status"::text::"OnboardingStatus_new");
ALTER TYPE "OnboardingStatus" RENAME TO "OnboardingStatus_old";
ALTER TYPE "OnboardingStatus_new" RENAME TO "OnboardingStatus";
DROP TYPE "public"."OnboardingStatus_old";
ALTER TABLE "DeviceOnboardingProgress" ALTER COLUMN "status" SET DEFAULT 'Queued';
COMMIT;

-- DropForeignKey
ALTER TABLE "DeviceHealthCheck" DROP CONSTRAINT "DeviceHealthCheck_jobId_fkey";

-- DropIndex
DROP INDEX "DeviceHealthCheck_jobId_idx";

-- DropIndex
DROP INDEX "Zone_netboxSiteId_key";

-- AlterTable
ALTER TABLE "DeviceHealthCheck" DROP CONSTRAINT "DeviceHealthCheck_pkey",
DROP COLUMN "jobId",
ADD COLUMN     "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
ADD CONSTRAINT "DeviceHealthCheck_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "DeviceMetadata" ALTER COLUMN "powerStatus" SET DEFAULT 'Running';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "error" TEXT,
ADD COLUMN     "lastCompletedStep" TEXT,
ADD COLUMN     "status" "JobStatus" NOT NULL DEFAULT 'Pending';

-- CreateIndex
CREATE INDEX "DeviceHealthCheck_testedAt_idx" ON "DeviceHealthCheck"("testedAt");

-- Backfill: existing jobs were only created on success, so mark them as Completed
UPDATE "Job" SET "status" = 'Completed' WHERE "status" = 'Pending';

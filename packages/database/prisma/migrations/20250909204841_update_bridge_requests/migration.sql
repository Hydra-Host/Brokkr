/*
  Warnings:

  - You are about to drop the column `dateApproved` on the `BridgeRequest` table. All the data in the column will be lost.
  - You are about to drop the column `dateCreated` on the `BridgeRequest` table. All the data in the column will be lost.
  - You are about to drop the column `dateDeleted` on the `BridgeRequest` table. All the data in the column will be lost.
  - You are about to drop the column `dateUpdated` on the `BridgeRequest` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `BridgeRequest` table. All the data in the column will be lost.
  - You are about to drop the column `prefixes` on the `BridgeRequest` table. All the data in the column will be lost.
  - Added the required column `data` to the `BridgeRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `datacenterId` to the `BridgeRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `organizationId` to the `BridgeRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `BridgeRequest` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "BridgeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "BridgeRequest" DROP COLUMN "dateApproved",
DROP COLUMN "dateCreated",
DROP COLUMN "dateDeleted",
DROP COLUMN "dateUpdated",
DROP COLUMN "name",
DROP COLUMN "prefixes",
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "data" JSONB NOT NULL,
ADD COLUMN     "datacenterId" INTEGER NOT NULL,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedBy" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "status" VARCHAR(20) NOT NULL GENERATED ALWAYS AS (
  CASE 
    WHEN "rejectedAt" IS NOT NULL THEN 'REJECTED'
    WHEN "approvedAt" IS NOT NULL THEN 'APPROVED'
    ELSE 'PENDING'
  END
) STORED;

-- CreateIndex
CREATE INDEX "BridgeRequest_organizationId_idx" ON "BridgeRequest"("organizationId");

-- CreateIndex
CREATE INDEX "BridgeRequest_datacenterId_idx" ON "BridgeRequest"("datacenterId");

-- CreateIndex
CREATE INDEX "BridgeRequest_organizationId_datacenterId_zoneId_idx" ON "BridgeRequest"("organizationId", "datacenterId", "zoneId");



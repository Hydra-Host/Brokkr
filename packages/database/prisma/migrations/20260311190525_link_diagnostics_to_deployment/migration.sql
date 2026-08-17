/*
  Warnings:

  - You are about to drop the column `deviceId` on the `DeviceDiagnostics` table. All the data in the column will be lost.
  - Added the required column `deploymentId` to the `DeviceDiagnostics` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "DeviceDiagnostics" DROP CONSTRAINT "DeviceDiagnostics_deviceId_fkey";

-- DropIndex
DROP INDEX "DeviceDiagnostics_deviceId_idx";

-- AlterTable
ALTER TABLE "DeviceDiagnostics" DROP COLUMN "deviceId",
ADD COLUMN     "deploymentId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "DeviceDiagnostics_deploymentId_idx" ON "DeviceDiagnostics"("deploymentId");

-- AddForeignKey
ALTER TABLE "DeviceDiagnostics" ADD CONSTRAINT "DeviceDiagnostics_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

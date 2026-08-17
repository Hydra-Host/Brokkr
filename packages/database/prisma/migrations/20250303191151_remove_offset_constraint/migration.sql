/*
  Warnings:

  - You are about to drop the `DeploymentStatus` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "DeploymentStatus" DROP CONSTRAINT "DeploymentStatus_deploymentId_fkey";

-- DropIndex
DROP INDEX "KafkaEvent_offset_key";

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "reservationId" TEXT;

-- DropTable
DROP TABLE "DeploymentStatus";

-- DropEnum
DROP TYPE "DeviceDeploymentStatus";

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

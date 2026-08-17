-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "currentRescueOperatingSystemId" TEXT;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_currentRescueOperatingSystemId_fkey" FOREIGN KEY ("currentRescueOperatingSystemId") REFERENCES "OperatingSystem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

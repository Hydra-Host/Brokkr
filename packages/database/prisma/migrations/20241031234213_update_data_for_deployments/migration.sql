/*
  Warnings:

  - Added the required column `operatingSystemId` to the `DeviceReservation` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DeviceMetadata" ADD COLUMN     "macAddress" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "DeviceReservation" ADD COLUMN     "internalProvision" BOOLEAN DEFAULT false,
ADD COLUMN     "nickname" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "operatingSystemId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "DeploymentKeys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deviceReservationId" TEXT NOT NULL,
    "sshKeyId" TEXT NOT NULL,

    CONSTRAINT "DeploymentKeys_pkey" PRIMARY KEY ("deviceReservationId","sshKeyId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentKeys_id_key" ON "DeploymentKeys"("id");

-- AddForeignKey
ALTER TABLE "DeviceReservation" ADD CONSTRAINT "DeviceReservation_operatingSystemId_fkey" FOREIGN KEY ("operatingSystemId") REFERENCES "OperatingSystem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentKeys" ADD CONSTRAINT "DeploymentKeys_deviceReservationId_fkey" FOREIGN KEY ("deviceReservationId") REFERENCES "DeviceReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentKeys" ADD CONSTRAINT "DeploymentKeys_sshKeyId_fkey" FOREIGN KEY ("sshKeyId") REFERENCES "SshKeys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

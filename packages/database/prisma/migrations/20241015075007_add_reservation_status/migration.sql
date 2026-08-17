/*
  Warnings:

  - You are about to drop the column `status` on the `DeviceReservation` table. All the data in the column will be lost.
  - Added the required column `stripeSubscriptionId` to the `DeviceReservation` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DeviceReservation" DROP COLUMN "status",
ADD COLUMN     "stripeSubscriptionId" TEXT NOT NULL,
ALTER COLUMN "updatedAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "DeviceReservationStatus" (
    "id" TEXT NOT NULL,
    "deviceReservationId" TEXT NOT NULL,

    CONSTRAINT "DeviceReservationStatus_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DeviceReservationStatus" ADD CONSTRAINT "DeviceReservationStatus_deviceReservationId_fkey" FOREIGN KEY ("deviceReservationId") REFERENCES "DeviceReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

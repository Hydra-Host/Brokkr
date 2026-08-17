/*
  Warnings:

  - You are about to drop the column `reservationId` on the `Deployment` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Deployment" DROP CONSTRAINT "Deployment_reservationId_fkey";

-- AlterTable
ALTER TABLE "Deployment" DROP COLUMN "reservationId";

-- CreateTable
CREATE TABLE "DevicesInReservation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,

    CONSTRAINT "DevicesInReservation_pkey" PRIMARY KEY ("reservationId","deviceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DevicesInReservation_id_key" ON "DevicesInReservation"("id");

-- AddForeignKey
ALTER TABLE "DevicesInReservation" ADD CONSTRAINT "DevicesInReservation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicesInReservation" ADD CONSTRAINT "DevicesInReservation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

/*
  Warnings:

  - You are about to drop the `Reservation` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_organizationId_fkey";

-- RenameTable
ALTER TABLE "Reservation" RENAME TO "ReservationInvite";

-- AddForeignKey
ALTER TABLE "ReservationInvite" ADD CONSTRAINT "ReservationInvite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationInvite" RENAME CONSTRAINT "Reservation_pkey" TO "ReservationInvite_pkey";

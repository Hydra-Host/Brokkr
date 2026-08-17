/*
  Warnings:

  - A unique constraint covering the columns `[reservationId]` on the table `ReservationInvite` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ReservationInvite_reservationId_key" ON "ReservationInvite"("reservationId");

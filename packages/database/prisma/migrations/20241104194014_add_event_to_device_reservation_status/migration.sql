/*
  Warnings:

  - Added the required column `event` to the `DeviceReservationStatus` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DeviceReservationStatus" ADD COLUMN     "event" TEXT NOT NULL;

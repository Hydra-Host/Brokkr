/*
  Warnings:

  - You are about to drop the column `dateAccepted` on the `DeviceReservation` table. All the data in the column will be lost.
  - You are about to drop the column `dateDeleted` on the `DeviceReservation` table. All the data in the column will be lost.
  - You are about to drop the column `dateExpires` on the `DeviceReservation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DeviceReservation" DROP COLUMN "dateAccepted",
DROP COLUMN "dateDeleted",
DROP COLUMN "dateExpires",
ALTER COLUMN "endDate" DROP NOT NULL;

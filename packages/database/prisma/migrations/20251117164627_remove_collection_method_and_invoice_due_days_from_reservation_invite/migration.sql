/*
  Warnings:

  - You are about to drop the column `duration` on the `ContractTerm` table. All the data in the column will be lost.
  - You are about to drop the column `collectionMethod` on the `ReservationInvite` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceDueDays` on the `ReservationInvite` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ContractTerm" DROP COLUMN "duration";

-- AlterTable
ALTER TABLE "ReservationInvite" DROP COLUMN "collectionMethod",
DROP COLUMN "invoiceDueDays";

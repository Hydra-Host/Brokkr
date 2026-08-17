/*
  Warnings:

  - Added the required column `event` to the `DeploymentKeys` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "ReservationStatus" ADD VALUE 'Rebooting';

-- AlterTable
ALTER TABLE "DeploymentKeys" ADD COLUMN     "event" TEXT NOT NULL;

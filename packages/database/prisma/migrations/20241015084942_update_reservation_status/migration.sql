/*
  Warnings:

  - Added the required column `jobId` to the `DeviceReservationStatus` table without a default value. This is not possible if the table is not empty.
  - Added the required column `status` to the `DeviceReservationStatus` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `DeviceReservationStatus` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('Provisioning', 'Provisioned', 'Error', 'Decomissioning', 'Decomissioned');

-- AlterTable
ALTER TABLE "DeviceReservationStatus" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "jobId" TEXT NOT NULL,
ADD COLUMN     "message" TEXT,
ADD COLUMN     "status" "ReservationStatus" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

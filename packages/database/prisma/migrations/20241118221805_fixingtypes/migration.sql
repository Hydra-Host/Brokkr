/*
  Warnings:

  - The `location` column on the `NetboxDevices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `disks` column on the `NetboxDevices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `storage` column on the `NetboxDevices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `memory` column on the `NetboxDevices` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "readonly"."NetboxDevices" DROP COLUMN "location",
ADD COLUMN     "location" INTEGER,
DROP COLUMN "disks",
ADD COLUMN     "disks" INTEGER,
DROP COLUMN "storage",
ADD COLUMN     "storage" INTEGER,
DROP COLUMN "memory",
ADD COLUMN     "memory" INTEGER;

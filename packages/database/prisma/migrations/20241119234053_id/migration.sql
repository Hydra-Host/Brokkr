/*
  Warnings:

  - The primary key for the `NetboxDevices` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Changed the type of `deviceId` on the `NetboxDevices` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "readonly"."NetboxDevices" DROP CONSTRAINT "NetboxDevices_pkey",
DROP COLUMN "deviceId",
ADD COLUMN     "deviceId" INTEGER NOT NULL,
ADD CONSTRAINT "NetboxDevices_pkey" PRIMARY KEY ("deviceId");

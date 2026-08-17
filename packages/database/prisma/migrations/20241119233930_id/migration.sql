-- DropIndex
DROP INDEX "readonly"."NetboxDevices_deviceId_key";

-- AlterTable
ALTER TABLE "readonly"."NetboxDevices" ADD CONSTRAINT "NetboxDevices_pkey" PRIMARY KEY ("deviceId");

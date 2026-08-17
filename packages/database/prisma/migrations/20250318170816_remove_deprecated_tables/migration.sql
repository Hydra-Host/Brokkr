/*
  Warnings:

  - You are about to drop the `DeploymentKeys` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DeprecatedDevice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DeviceReservation` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DeviceReservationStatus` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Hypervisor` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SSHKeyPair` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TenantRequest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `VirtualMachine` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "DeploymentKeys" DROP CONSTRAINT "DeploymentKeys_deviceReservationId_fkey";

-- DropForeignKey
ALTER TABLE "DeploymentKeys" DROP CONSTRAINT "DeploymentKeys_sshKeyId_fkey";

-- DropForeignKey
ALTER TABLE "DeprecatedDevice" DROP CONSTRAINT "DeprecatedDevice_sSHKeyPairId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceReservation" DROP CONSTRAINT "DeviceReservation_customerId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceReservation" DROP CONSTRAINT "DeviceReservation_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceReservation" DROP CONSTRAINT "DeviceReservation_operatingSystemId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceReservation" DROP CONSTRAINT "DeviceReservation_reserverId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceReservationStatus" DROP CONSTRAINT "DeviceReservationStatus_deviceReservationId_fkey";

-- DropForeignKey
ALTER TABLE "Hypervisor" DROP CONSTRAINT "Hypervisor_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "Hypervisor" DROP CONSTRAINT "Hypervisor_sshKeyPairId_fkey";

-- DropForeignKey
ALTER TABLE "SSHKeyPair" DROP CONSTRAINT "SSHKeyPair_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "TenantRequest" DROP CONSTRAINT "TenantRequest_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "VirtualMachine" DROP CONSTRAINT "VirtualMachine_deviceId_fkey";

-- DropTable
DROP TABLE "DeploymentKeys";

-- DropTable
DROP TABLE "DeprecatedDevice";

-- DropTable
DROP TABLE "DeviceReservation";

-- DropTable
DROP TABLE "DeviceReservationStatus";

-- DropTable
DROP TABLE "Hypervisor";

-- DropTable
DROP TABLE "SSHKeyPair";

-- DropTable
DROP TABLE "TenantRequest";

-- DropTable
DROP TABLE "VirtualMachine";

-- DropEnum
DROP TYPE "ReservationStatus";

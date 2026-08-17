/*
  Warnings:

  - You are about to drop the `DeviceAuditLog` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "AuditLogType" AS ENUM ('DEVICE', 'USER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "DeviceRole" AS ENUM ('Hypervisor', 'Baremetal', 'Cluster', 'Bridge', 'VM');

-- DropTable
DROP TABLE "DeviceAuditLog";

-- CreateTable
CREATE TABLE "SSHKeyPair" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedSshPrivateKey" TEXT NOT NULL,
    "sshPublicKey" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),

    CONSTRAINT "SSHKeyPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "netboxDeviceId" INTEGER NOT NULL,
    "type" "DeviceRole" NOT NULL,
    "hypervisorId" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hypervisor" (
    "id" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "sshKeyPairId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,

    CONSTRAINT "Hypervisor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "jobId" TEXT NOT NULL,
    "deviceId" INTEGER,
    "userId" TEXT NOT NULL,
    "type" "AuditLogType" NOT NULL DEFAULT 'DEVICE',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "metadata" TEXT NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Hypervisor_deviceId_key" ON "Hypervisor"("deviceId");

-- AddForeignKey
ALTER TABLE "Hypervisor" ADD CONSTRAINT "Hypervisor_sshKeyPairId_fkey" FOREIGN KEY ("sshKeyPairId") REFERENCES "SSHKeyPair"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hypervisor" ADD CONSTRAINT "Hypervisor_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

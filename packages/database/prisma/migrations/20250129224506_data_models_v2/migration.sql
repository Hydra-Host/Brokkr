/*
  Warnings:

  - A unique constraint covering the columns `[contractTermId]` on the table `ReservationInvite` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ReservationChannel" AS ENUM ('HYDRA_MARKETPLACE', 'HYDRA_SALES', 'DC_SALES', 'SELF_PROVISION');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('ON_DEMAND', 'INTERRUPTIBLE', 'RESERVED_ROLLING');

-- CreateEnum
CREATE TYPE "CollectionMethod" AS ENUM ('CHARGED_AUTOMATICALLY', 'SEND_INVOICE');

-- CreateEnum
CREATE TYPE "BillingFrequency" AS ENUM ('HOURLY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "DeploymentType" AS ENUM ('SELF_SERVICE', 'OFF_BROKKR');

-- CreateEnum
CREATE TYPE "DeviceDeploymentStatus" AS ENUM ('Queued', 'Provisioning', 'Provisioned', 'Rebooting', 'Error', 'Decommissioning', 'Decommissioned');

-- AlterTable
ALTER TABLE "DeploymentKeys" ADD COLUMN     "deploymentId" TEXT;

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "skuId" TEXT;

-- AlterTable
ALTER TABLE "ReservationInvite" ADD COLUMN     "channel" "ReservationChannel" NOT NULL DEFAULT 'HYDRA_SALES',
ADD COLUMN     "contractTermId" TEXT,
ADD COLUMN     "reservationId" TEXT;

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "saleStripePriceId" TEXT,
    "stripeSubscriptionId" TEXT,
    "internalProvision" BOOLEAN DEFAULT false,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "channel" "ReservationChannel" NOT NULL,
    "reserverId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractTerm" (
    "id" TEXT NOT NULL,
    "buyerPrice" INTEGER NOT NULL,
    "supplierPrice" INTEGER NOT NULL,
    "hydraMargin" DECIMAL(65,30) NOT NULL,
    "contractType" "ContractType" NOT NULL,
    "collectionMethod" "CollectionMethod" NOT NULL,
    "billingFrequency" "BillingFrequency" NOT NULL,
    "paidTrialHours" INTEGER,
    "stripeProductId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3),
    "reservationId" TEXT NOT NULL,
    "reservationInviteId" TEXT,

    CONSTRAINT "ContractTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "type" "DeploymentType" NOT NULL,
    "deviceId" TEXT NOT NULL,
    "operatingSystemId" TEXT NOT NULL,
    "reservationId" TEXT,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentStatus" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "status" "DeviceDeploymentStatus" NOT NULL,
    "jobId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierSKU" (
    "id" TEXT NOT NULL,
    "stripeProductId" TEXT NOT NULL,
    "defaultStripePriceId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,

    CONSTRAINT "SupplierSKU_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicesInReservationInvite" (
    "deviceId" TEXT NOT NULL,
    "reservationInviteId" TEXT NOT NULL,

    CONSTRAINT "DevicesInReservationInvite_pkey" PRIMARY KEY ("deviceId","reservationInviteId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierSKU_stripeProductId_key" ON "SupplierSKU"("stripeProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationInvite_contractTermId_key" ON "ReservationInvite"("contractTermId");

-- AddForeignKey
ALTER TABLE "DeploymentKeys" ADD CONSTRAINT "DeploymentKeys_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "SupplierSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_reserverId_fkey" FOREIGN KEY ("reserverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractTerm" ADD CONSTRAINT "ContractTerm_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_operatingSystemId_fkey" FOREIGN KEY ("operatingSystemId") REFERENCES "OperatingSystem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentStatus" ADD CONSTRAINT "DeploymentStatus_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationInvite" ADD CONSTRAINT "ReservationInvite_contractTermId_fkey" FOREIGN KEY ("contractTermId") REFERENCES "ContractTerm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationInvite" ADD CONSTRAINT "ReservationInvite_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicesInReservationInvite" ADD CONSTRAINT "DevicesInReservationInvite_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicesInReservationInvite" ADD CONSTRAINT "DevicesInReservationInvite_reservationInviteId_fkey" FOREIGN KEY ("reservationInviteId") REFERENCES "ReservationInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

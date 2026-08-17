-- Site/Zone Consolidation Migration
-- Consolidates "data center" (NetBox site) and "zone" (NetBox location) into a single Zone concept.
-- Additive only — no columns or tables are dropped.

-- CreateEnum
CREATE TYPE "ZoneAddressType" AS ENUM ('PRIMARY', 'SHIPPING');

-- CreateEnum
CREATE TYPE "ZoneContactType" AS ENUM ('Main', 'Technical');

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "netboxSiteId" INTEGER,
    "netboxLocationId" INTEGER,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneAddress" (
    "id" TEXT NOT NULL,
    "type" "ZoneAddressType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "formattedAddress" TEXT NOT NULL,
    "addressLineOne" TEXT NOT NULL,
    "addressLineTwo" TEXT,
    "city" TEXT NOT NULL,
    "stateOrProvince" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "timezone" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,

    CONSTRAINT "ZoneAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneContact" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contactType" "ZoneContactType" NOT NULL,
    "isShippingContact" BOOLEAN NOT NULL DEFAULT false,
    "zoneId" TEXT NOT NULL,

    CONSTRAINT "ZoneContact_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Add zoneId to Device
ALTER TABLE "Device" ADD COLUMN "zoneId" TEXT;

-- CreateIndex (not unique — multiple zones can share a NetBox site)
CREATE INDEX "Zone_netboxSiteId_key" ON "Zone"("netboxSiteId");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_netboxLocationId_key" ON "Zone"("netboxLocationId");

-- CreateIndex
CREATE INDEX "Zone_organizationId_idx" ON "Zone"("organizationId");

-- CreateIndex
CREATE INDEX "ZoneAddress_zoneId_idx" ON "ZoneAddress"("zoneId");

-- CreateIndex
CREATE INDEX "ZoneContact_zoneId_idx" ON "ZoneContact"("zoneId");

-- CreateIndex
CREATE INDEX "Device_zoneId_idx" ON "Device"("zoneId");

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneAddress" ADD CONSTRAINT "ZoneAddress_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneContact" ADD CONSTRAINT "ZoneContact_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;


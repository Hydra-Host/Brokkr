-- CreateEnum
CREATE TYPE "InterconnectType" AS ENUM ('ANY', 'INFINIBAND', 'ROCEV1', 'ROCEV2');

-- CreateEnum
CREATE TYPE "OemType" AS ENUM ('DELL', 'LENOVO', 'HPE', 'SUPERMICRO', 'ASUS', 'GIGABYTE', 'OTHER');

-- CreateEnum
CREATE TYPE "CpuOemType" AS ENUM ('INTEL', 'AMD', 'ARM', 'OTHER');

-- CreateEnum
CREATE TYPE "RamType" AS ENUM ('DDR4', 'DDR5', 'HBM2', 'HBM3', 'OTHER');

-- Add down payment
ALTER TABLE "OfferContractTerm" ADD COLUMN "downPaymentPercent" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "OfferListingAdvancedSpec" (
    "id" TEXT NOT NULL,
    "offerListingId" TEXT NOT NULL,
    
    -- Location / OEM / CPU
    "oemName" "OemType",
    "exactLocation" TEXT,
    "cpuOem" "CpuOemType",
    "cpuModel" TEXT,
    "cpuSpecs" TEXT,
    
    -- Resources / power
    "dcPowerMw" DECIMAL(10,2),
    
    -- Network
    "interconnectType" "InterconnectType",
    "interconnectSpeedGbps" DOUBLE PRECISION,
    "nsBandwidthCount" INTEGER,
    "nsBandwidthGbps" INTEGER,
    "nsBandwidthLabel" TEXT,
    "internetBandwidthEntries" JSONB,
    "multiIspFailover" BOOLEAN,
    "multiIspFailoverSpeed" INTEGER,
    
    -- Security
    "hydraVpcCapable" BOOLEAN,
    "teeCapable" BOOLEAN,
    
    -- Storage / drives
    "ramSpec" DECIMAL(10,4),
    "ramType" "RamType",
    "osDriveCount" INTEGER,
    "osDriveSize" DECIMAL(10,4),
    "osDriveType" TEXT,
    "storageDriveCount" INTEGER,
    "storageDriveSize" DECIMAL(10,4),
    "storageDriveType" TEXT,
    "cpuNodesSpec" TEXT,
    "storageNodesSpec" TEXT,
    "timelineText" TEXT,
    
    -- Capacity / expansion
    "potentialExpansionGpuCount" INTEGER,
    
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferListingAdvancedSpec_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfferListingAdvancedSpec_offerListingId_key" ON "OfferListingAdvancedSpec"("offerListingId");

-- AddForeignKey
ALTER TABLE "OfferListingAdvancedSpec" ADD CONSTRAINT "OfferListingAdvancedSpec_offerListingId_fkey" FOREIGN KEY ("offerListingId") REFERENCES "OfferListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;


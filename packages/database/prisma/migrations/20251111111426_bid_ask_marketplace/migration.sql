-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OfferType" AS ENUM ('DEMAND', 'SUPPLIER');

-- CreateTable
CREATE TABLE "OfferListing" (
    "id" TEXT NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "type" "OfferType" NOT NULL,
    "organizationId" TEXT NOT NULL,
    "gpuModel" TEXT NOT NULL,
    "gpuCount" INTEGER NOT NULL,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "region" TEXT,
    "deviceSpec" TEXT,
    "interconnect" BOOLEAN NOT NULL DEFAULT false,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferContractTerm" (
    "id" TEXT NOT NULL,
    "contractLengthInWeeks" INTEGER NOT NULL,
    "minNodes" INTEGER NOT NULL,
    "maxNodes" INTEGER NOT NULL,
    "buyerPricePerGpuHour" DECIMAL(10,4) NOT NULL,
    "sellerPricePerGpuHour" DECIMAL(10,4) NOT NULL,
    "hydraSpreadPerGpuHour" DECIMAL(10,4) NOT NULL,
    "offerListingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferContractTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferInterest" (
    "id" TEXT NOT NULL,
    "offerListingId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "pricingDetails" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferInterest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferInterestTerm" (
    "id" TEXT NOT NULL,
    "offerInterestId" TEXT NOT NULL,
    "contractTermId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferInterestTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfferListing_organizationId_idx" ON "OfferListing"("organizationId");

-- CreateIndex
CREATE INDEX "OfferListing_type_status_idx" ON "OfferListing"("type", "status");

-- CreateIndex
CREATE INDEX "OfferListing_gpuModel_status_idx" ON "OfferListing"("gpuModel", "status");

-- CreateIndex
CREATE INDEX "OfferInterest_offerListingId_idx" ON "OfferInterest"("offerListingId");

-- CreateIndex
CREATE INDEX "OfferInterest_organizationId_idx" ON "OfferInterest"("organizationId");

-- CreateIndex
CREATE INDEX "OfferInterest_createdById_idx" ON "OfferInterest"("createdById");

-- CreateIndex
CREATE INDEX "OfferInterestTerm_offerInterestId_idx" ON "OfferInterestTerm"("offerInterestId");

-- CreateIndex
CREATE INDEX "OfferInterestTerm_contractTermId_idx" ON "OfferInterestTerm"("contractTermId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferInterestTerm_offerInterestId_contractTermId_key" ON "OfferInterestTerm"("offerInterestId", "contractTermId");

-- AddForeignKey
ALTER TABLE "OfferListing" ADD CONSTRAINT "OfferListing_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferContractTerm" ADD CONSTRAINT "OfferContractTerm_offerListingId_fkey" FOREIGN KEY ("offerListingId") REFERENCES "OfferListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferInterest" ADD CONSTRAINT "OfferInterest_offerListingId_fkey" FOREIGN KEY ("offerListingId") REFERENCES "OfferListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferInterest" ADD CONSTRAINT "OfferInterest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferInterest" ADD CONSTRAINT "OfferInterest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferInterestTerm" ADD CONSTRAINT "OfferInterestTerm_offerInterestId_fkey" FOREIGN KEY ("offerInterestId") REFERENCES "OfferInterest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferInterestTerm" ADD CONSTRAINT "OfferInterestTerm_contractTermId_fkey" FOREIGN KEY ("contractTermId") REFERENCES "OfferContractTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

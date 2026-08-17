-- DropForeignKey
ALTER TABLE "OfferListing" DROP CONSTRAINT "OfferListing_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "OfferContractTerm" DROP CONSTRAINT "OfferContractTerm_offerListingId_fkey";

-- DropForeignKey
ALTER TABLE "OfferInterest" DROP CONSTRAINT "OfferInterest_offerListingId_fkey";

-- DropForeignKey
ALTER TABLE "OfferInterest" DROP CONSTRAINT "OfferInterest_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "OfferInterest" DROP CONSTRAINT "OfferInterest_createdById_fkey";

-- DropForeignKey
ALTER TABLE "OfferInterestTerm" DROP CONSTRAINT "OfferInterestTerm_offerInterestId_fkey";

-- DropForeignKey
ALTER TABLE "OfferInterestTerm" DROP CONSTRAINT "OfferInterestTerm_contractTermId_fkey";

-- DropForeignKey
ALTER TABLE "OfferListingAdvancedSpec" DROP CONSTRAINT "OfferListingAdvancedSpec_offerListingId_fkey";

-- DropTable
DROP TABLE "OfferListing";

-- DropTable
DROP TABLE "OfferContractTerm";

-- DropTable
DROP TABLE "OfferInterest";

-- DropTable
DROP TABLE "OfferInterestTerm";

-- DropTable
DROP TABLE "OfferListingAdvancedSpec";

-- DropEnum
DROP TYPE "OfferStatus";

-- DropEnum
DROP TYPE "OfferType";

-- DropEnum
DROP TYPE "InterconnectType";

-- DropEnum
DROP TYPE "OemType";

-- DropEnum
DROP TYPE "CpuOemType";

-- DropEnum
DROP TYPE "RamType";

-- DropEnum
DROP TYPE "GpuBusType";

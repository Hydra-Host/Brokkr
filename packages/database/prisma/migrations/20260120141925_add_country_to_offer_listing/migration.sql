-- AlterTable
ALTER TABLE "OfferListing" ADD COLUMN     "country" TEXT;

-- AlterTable - Remove availability notes field
ALTER TABLE "OfferListingAdvancedSpec" DROP COLUMN IF EXISTS "timelineText";

/*
  Warnings:

  - You are about to drop the column `hydraSpreadPerGpuHour` on the `OfferContractTerm` table. All the data in the column will be lost.
  - You are about to drop the column `sellerPricePerGpuHour` on the `OfferContractTerm` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "OfferContractTerm" DROP COLUMN "hydraSpreadPerGpuHour",
DROP COLUMN "sellerPricePerGpuHour";

/*
  Warnings:

  - You are about to drop the column `reservationInviteId` on the `ContractTerm` table. All the data in the column will be lost.
  - You are about to drop the column `askPrice` on the `ReservationInvite` table. All the data in the column will be lost.
  - You are about to drop the column `contractTermId` on the `ReservationInvite` table. All the data in the column will be lost.
  - You are about to drop the column `salePrice` on the `ReservationInvite` table. All the data in the column will be lost.
  - You are about to drop the column `stripePriceId` on the `ReservationInvite` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "ReservationInvite" DROP CONSTRAINT "ReservationInvite_contractTermId_fkey";

-- DropIndex
DROP INDEX "ReservationInvite_contractTermId_key";

-- AlterTable
ALTER TABLE "ContractTerm" DROP COLUMN "reservationInviteId";

-- AlterTable
ALTER TABLE "ReservationInvite" DROP COLUMN "askPrice",
DROP COLUMN "contractTermId",
DROP COLUMN "salePrice",
DROP COLUMN "stripePriceId",
ADD COLUMN     "billingFrequency" "BillingFrequency" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "buyerPrice" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "collectionMethod" "CollectionMethod" NOT NULL DEFAULT 'CHARGED_AUTOMATICALLY',
ADD COLUMN     "margin" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "supplierPrice" INTEGER NOT NULL DEFAULT 0;

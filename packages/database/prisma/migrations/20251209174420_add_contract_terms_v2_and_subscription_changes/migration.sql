-- CreateEnum
CREATE TYPE "ContractTermChannel" AS ENUM ('HYDRA_MARKETPLACE', 'HYDRA_SALES', 'DC_SALES', 'SELF_PROVISION', 'HYDRA_ADMIN_TEST');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SubscriptionItemType" ADD VALUE 'OFF_BROKKR_DEVICE';
ALTER TYPE "SubscriptionItemType" ADD VALUE 'DOWN_PAYMENT';

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "isManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "SubscriptionItem" ADD COLUMN     "discountPercentage" DECIMAL(65,30);

-- CreateTable
CREATE TABLE "ContractTermV2" (
    "id" TEXT NOT NULL,
    "buyerPrice" INTEGER NOT NULL,
    "supplierPrice" INTEGER NOT NULL,
    "contractType" "ContractType" NOT NULL,
    "collectionMethod" "CollectionMethod" NOT NULL,
    "channel" "ContractTermChannel" NOT NULL,
    "billingFrequency" "BillingFrequency" NOT NULL,
    "downPaymentAmount" DECIMAL(65,30),
    "interruptibleNoticePeriod" INTEGER,
    "orderCriteria" JSONB,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "invoiceDueDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "gracePeriodExpiresAt" TIMESTAMP(3),
    "referralOrganizationId" TEXT,
    "salesRepresentativeId" TEXT,
    "subscriptionId" TEXT NOT NULL,

    CONSTRAINT "ContractTermV2_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ContractTermV2" ADD CONSTRAINT "ContractTermV2_referralOrganizationId_fkey" FOREIGN KEY ("referralOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractTermV2" ADD CONSTRAINT "ContractTermV2_salesRepresentativeId_fkey" FOREIGN KEY ("salesRepresentativeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractTermV2" ADD CONSTRAINT "ContractTermV2_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

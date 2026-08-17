/*
  Warnings:

  - You are about to drop the column `amount` on the `SubscriptionItem` table. All the data in the column will be lost.
  - Added the required column `buyerPrice` to the `SubscriptionItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `hydraMargin` to the `SubscriptionItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `supplierPrice` to the `SubscriptionItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "SubscriptionItem" DROP COLUMN "amount",
ADD COLUMN     "buyerPrice" INTEGER NOT NULL,
ADD COLUMN     "hydraMargin" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "supplierPrice" INTEGER NOT NULL,
ADD COLUMN     "supplyOrganizationId" TEXT;

-- CreateIndex
CREATE INDEX "SubscriptionItem_supplyOrganizationId_idx" ON "SubscriptionItem"("supplyOrganizationId");

-- AddForeignKey
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_supplyOrganizationId_fkey" FOREIGN KEY ("supplyOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

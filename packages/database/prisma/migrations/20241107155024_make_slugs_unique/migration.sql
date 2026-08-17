/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `OperatingSystem` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "DeviceReservation" ALTER COLUMN "saleStripePriceId" DROP NOT NULL,
ALTER COLUMN "stripeSubscriptionId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "OperatingSystem_slug_key" ON "OperatingSystem"("slug");

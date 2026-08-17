/*
  Warnings:

  - Added the required column `amount` to the `SubscriptionItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `SubscriptionItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "SubscriptionItem" ADD COLUMN     "amount" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "name" TEXT NOT NULL;

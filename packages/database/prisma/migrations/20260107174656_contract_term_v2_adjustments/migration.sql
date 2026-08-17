/*
  Warnings:

  - You are about to alter the column `downPaymentAmount` on the `ContractTermV2` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Integer`.
  - Added the required column `hydraMargin` to the `ContractTermV2` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "ContractType" ADD VALUE 'RESERVED';

-- AlterTable
ALTER TABLE "ContractTermV2" ADD COLUMN     "hydraMargin" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "referralCommissionPercent" DECIMAL(65,30),
ALTER COLUMN "downPaymentAmount" SET DATA TYPE INTEGER;

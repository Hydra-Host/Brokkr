-- CreateEnum
CREATE TYPE "NetTerms" AS ENUM ('P7D', 'P15D', 'P30D');

-- AlterTable
ALTER TABLE "BillingInformation" ADD COLUMN     "netTerms" "NetTerms";

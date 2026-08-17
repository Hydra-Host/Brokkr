/*
  Warnings:

  - Added the required column `tenantType` to the `Organization` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "TenantType" AS ENUM ('SupplyCustomer', 'DemandCustomer');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "tenantType" "TenantType" NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false;

/*
  Warnings:

  - You are about to drop the column `isTrusted` on the `Organization` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "FeatureFlags" ADD COLUMN     "verifiedExtendTerms" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Organization" DROP COLUMN "isTrusted";

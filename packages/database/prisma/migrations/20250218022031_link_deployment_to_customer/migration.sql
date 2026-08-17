/*
  Warnings:

  - Added the required column `customerId` to the `Deployment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "customerId" TEXT NOT NULL;
-- Update existing Deployment records with customerId from Device's Organization

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

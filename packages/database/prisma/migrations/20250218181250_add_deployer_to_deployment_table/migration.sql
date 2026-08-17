/*
  Warnings:

  - Added the required column `deployerId` to the `Deployment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "deployerId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deployerId_fkey" FOREIGN KEY ("deployerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

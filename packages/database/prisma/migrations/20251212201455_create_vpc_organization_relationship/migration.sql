/*
  Warnings:

  - A unique constraint covering the columns `[organizationId]` on the table `Vpc` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `organizationId` to the `Vpc` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Vpc" DROP CONSTRAINT "Vpc_id_fkey";

-- AlterTable
ALTER TABLE "Vpc" ADD COLUMN     "organizationId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Vpc_organizationId_key" ON "Vpc"("organizationId");

-- CreateIndex
CREATE INDEX "Vpc_organizationId_idx" ON "Vpc"("organizationId");

-- AddForeignKey
ALTER TABLE "Vpc" ADD CONSTRAINT "Vpc_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

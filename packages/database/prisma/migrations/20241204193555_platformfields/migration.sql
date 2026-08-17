/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `NetboxPlatform` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "readonly"."NetboxPlatform" ADD COLUMN     "description" TEXT,
ADD COLUMN     "osDistribution" TEXT,
ADD COLUMN     "osVersion" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "NetboxPlatform_slug_key" ON "readonly"."NetboxPlatform"("slug");

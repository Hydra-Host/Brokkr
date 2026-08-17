/*
  Warnings:

  - You are about to drop the column `level` on the `NetboxRegion` table. All the data in the column will be lost.
  - You are about to drop the column `lft` on the `NetboxRegion` table. All the data in the column will be lost.
  - You are about to drop the column `rght` on the `NetboxRegion` table. All the data in the column will be lost.
  - You are about to drop the column `treeId` on the `NetboxRegion` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "readonly"."NetboxRegion" DROP COLUMN "level",
DROP COLUMN "lft",
DROP COLUMN "rght",
DROP COLUMN "treeId";

/*
  Warnings:

  - You are about to drop the column `description` on the `NetboxLocation` table. All the data in the column will be lost.
  - You are about to drop the column `level` on the `NetboxLocation` table. All the data in the column will be lost.
  - You are about to drop the column `lft` on the `NetboxLocation` table. All the data in the column will be lost.
  - You are about to drop the column `parentId` on the `NetboxLocation` table. All the data in the column will be lost.
  - You are about to drop the column `rght` on the `NetboxLocation` table. All the data in the column will be lost.
  - You are about to drop the column `treeId` on the `NetboxLocation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "readonly"."NetboxLocation" DROP COLUMN "description",
DROP COLUMN "level",
DROP COLUMN "lft",
DROP COLUMN "parentId",
DROP COLUMN "rght",
DROP COLUMN "treeId";

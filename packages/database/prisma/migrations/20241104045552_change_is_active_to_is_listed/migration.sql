/*
  Warnings:

  - You are about to drop the column `isActive` on the `Device` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Device" RENAME COLUMN "isActive" TO "isListed";


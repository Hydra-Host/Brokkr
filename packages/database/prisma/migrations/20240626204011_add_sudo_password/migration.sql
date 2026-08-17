/*
  Warnings:

  - Added the required column `sudoPassword` to the `Hypervisor` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Hypervisor" ADD COLUMN     "sudoPassword" TEXT NOT NULL;

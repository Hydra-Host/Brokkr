/*
  Warnings:

  - Added the required column `roleDescription` to the `OrganizationMembers` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "OrganizationMembers" ADD COLUMN     "roleDescription" TEXT NOT NULL;

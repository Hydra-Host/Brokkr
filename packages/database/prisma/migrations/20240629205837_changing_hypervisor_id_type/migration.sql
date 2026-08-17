/*
  Warnings:

  - Changed the type of `hypervisorId` on the `VirtualMachine` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "VirtualMachine" DROP COLUMN "hypervisorId",
ADD COLUMN     "hypervisorId" INTEGER NOT NULL;

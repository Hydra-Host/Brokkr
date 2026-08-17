/*
  Warnings:

  - You are about to drop the column `inviteeId` on the `OrganizationMembershipInvitation` table. All the data in the column will be lost.
  - Added the required column `inviterId` to the `OrganizationMembershipInvitation` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "OrganizationMembershipInvitation" DROP CONSTRAINT "OrganizationMembershipInvitation_inviteeId_fkey";

-- AlterTable
ALTER TABLE "OrganizationMembershipInvitation" DROP COLUMN "inviteeId",
ADD COLUMN     "inviterId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "OrganizationMembershipInvitation" ADD CONSTRAINT "OrganizationMembershipInvitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

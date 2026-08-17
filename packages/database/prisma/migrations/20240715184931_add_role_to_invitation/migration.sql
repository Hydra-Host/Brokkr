-- AlterTable
ALTER TABLE "OrganizationMembershipInvitation" ADD COLUMN     "role" "OrganizationMembershipRole" NOT NULL DEFAULT 'Member';

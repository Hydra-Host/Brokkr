-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrganizationMembership" ADD COLUMN     "deletedAt" TIMESTAMP(3);

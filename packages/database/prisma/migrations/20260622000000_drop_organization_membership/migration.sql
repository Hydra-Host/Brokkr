-- Drop the deprecated `OrganizationMembership` table. `Member` is the canonical
-- membership table (single source of truth for role/isDefaultOrg); no code path
-- reads or writes `OrganizationMembership`. Its own foreign keys drop with the
-- table and nothing else references it, so no CASCADE is needed.

-- DropForeignKey
ALTER TABLE "OrganizationMembership" DROP CONSTRAINT "OrganizationMembership_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationMembership" DROP CONSTRAINT "OrganizationMembership_userId_fkey";

-- DropTable
DROP TABLE "OrganizationMembership";

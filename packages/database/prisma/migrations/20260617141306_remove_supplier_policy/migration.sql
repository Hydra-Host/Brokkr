-- DropTable
DROP TABLE "DevicePolicyConsent";

-- DropTable
DROP TABLE "OrganizationSupplierPolicy";

-- AlterTable
ALTER TABLE "Organization" DROP COLUMN "requireBuyerConsentOnPolicy";

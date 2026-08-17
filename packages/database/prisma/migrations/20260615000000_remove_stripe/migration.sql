-- Remove Stripe integration: dedicated Stripe tables/enum and all `stripe*`
-- columns scattered across other models. Tables are dropped in dependency
-- order (referencing tables first) so each table's foreign keys are removed
-- with it and no surviving table is left pointing at a dropped one.

-- DropTable
DROP TABLE "StripeSubscription";

-- DropTable
DROP TABLE "StripeCharge";

-- DropTable
DROP TABLE "StripePaymentIntent";

-- DropTable
DROP TABLE "StripeInvoice";

-- DropTable
DROP TABLE "StripePrice";

-- DropTable
DROP TABLE "StripeProduct";

-- DropTable
DROP TABLE "StripeCustomer";

-- DropTable
DROP TABLE "StripeEvent";

-- DropEnum
DROP TYPE "StripeEventStatus";

-- DropColumn (Device)
ALTER TABLE "Device" DROP COLUMN "stripeProductId",
DROP COLUMN "defaultStripePriceId",
DROP COLUMN "floorStripePriceId";

-- DropColumn (Server)
ALTER TABLE "Server" DROP COLUMN "stripeProductId",
DROP COLUMN "defaultStripePriceId",
DROP COLUMN "floorStripePriceId";

-- DropColumn (LegacyDevice)
ALTER TABLE "LegacyDevice" DROP COLUMN "stripeProductId",
DROP COLUMN "defaultStripePriceId",
DROP COLUMN "floorStripePriceId";

-- DropColumn (SupplierSKU) -- the unique index on stripeProductId is dropped with the column
ALTER TABLE "SupplierSKU" DROP COLUMN "stripeProductId",
DROP COLUMN "defaultStripePriceId";

-- DropColumn (Organization)
ALTER TABLE "Organization" DROP COLUMN "stripeConnectAccountId",
DROP COLUMN "stripeOnboardingCompleted";

-- DropColumn (FeatureFlags)
ALTER TABLE "FeatureFlags" DROP COLUMN "stripeConnect";

-- DropColumn (Reservation)
ALTER TABLE "Reservation" DROP COLUMN "saleStripePriceId",
DROP COLUMN "stripeSubscriptionId";

-- DropColumn (ContractTerm)
ALTER TABLE "ContractTerm" DROP COLUMN "stripeProductId";

-- DropColumn (BillingInformation) -- the unique index on stripeCustomerId is dropped with the column
ALTER TABLE "BillingInformation" DROP COLUMN "stripeCustomerId";

-- DropColumn (NetboxDeviceStatusChanges)
ALTER TABLE "NetboxDeviceStatusChanges" DROP COLUMN "stripeProductId",
DROP COLUMN "stripeCustomerId",
DROP COLUMN "stripePriceId";

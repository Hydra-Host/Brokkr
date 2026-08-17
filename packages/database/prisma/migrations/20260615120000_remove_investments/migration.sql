-- Remove the investments/lender program: the lender_device_association table
-- and the FeatureFlags.investments column. No surviving table references the
-- dropped one (its FKs to Organization/Device are dropped with it).

-- DropTable
DROP TABLE "LenderDeviceAssociation";

-- DropColumn (FeatureFlags)
ALTER TABLE "FeatureFlags" DROP COLUMN "investments";

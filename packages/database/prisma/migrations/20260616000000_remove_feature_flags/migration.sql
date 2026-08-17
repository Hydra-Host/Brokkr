-- Remove the organization feature-flags system: the FeatureFlags table and its
-- one-to-one relation to Organization. No surviving table references the dropped
-- one (its FK to Organization is dropped with it).

-- DropTable
DROP TABLE "FeatureFlags";

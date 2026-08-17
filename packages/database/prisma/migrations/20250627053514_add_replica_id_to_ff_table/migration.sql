-- This is an empty migration.
ALTER TABLE "FeatureFlags" REPLICA IDENTITY USING INDEX "FeatureFlags_organizationId_key";

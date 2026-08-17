-- Drop the dead Vault-era columns from DeviceOnboardingProgress. BMC credentials
-- now seal into the DeviceSecret store at onboard time (no Vault), and the
-- bridge tenant/site/location triplet was replaced by the zoneId FK. These
-- columns have no readers or writers post-cutover. Deprecation cleanup.
ALTER TABLE IF EXISTS "DeviceOnboardingProgress" DROP COLUMN "vaultCredentialsSaved";
ALTER TABLE IF EXISTS "DeviceOnboardingProgress" DROP COLUMN "ipmiLogin";
ALTER TABLE IF EXISTS "DeviceOnboardingProgress" DROP COLUMN "ipmiPassword";
ALTER TABLE IF EXISTS "DeviceOnboardingProgress" DROP COLUMN "bridgeTenantId";
ALTER TABLE IF EXISTS "DeviceOnboardingProgress" DROP COLUMN "bridgeSiteId";
ALTER TABLE IF EXISTS "DeviceOnboardingProgress" DROP COLUMN "bridgeLocationId";

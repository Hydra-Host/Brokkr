-- Remove the remaining NetBox-coupled columns. These had no live readers
-- (Vpc/Deployment/Onboarding) or were vestigial preconditions
-- (OperatingSystem.netboxPlatformId only gated netplan publish). netris* peers
-- are NOT NetBox and are retained.
ALTER TABLE "Vpc" DROP COLUMN IF EXISTS "netboxTenantId";
ALTER TABLE "Vpc" DROP COLUMN IF EXISTS "netboxVrfId";
ALTER TABLE "Vpc" DROP COLUMN IF EXISTS "netboxGatewayIpAddressId";
ALTER TABLE "Vpc" DROP COLUMN IF EXISTS "netboxGatewayId";
ALTER TABLE "Vpc" DROP COLUMN IF EXISTS "netboxAllocationPrefixId";
ALTER TABLE "Vpc" DROP COLUMN IF EXISTS "netboxSubnetPrefixId";

ALTER TABLE "Deployment" DROP COLUMN IF EXISTS "netboxPublicIpAddress";
ALTER TABLE "Deployment" DROP COLUMN IF EXISTS "netboxPublicIpAddressId";
ALTER TABLE "Deployment" DROP COLUMN IF EXISTS "netboxPrivateIpAddress";
ALTER TABLE "Deployment" DROP COLUMN IF EXISTS "netboxPrivateIpAddressId";

ALTER TABLE "DeviceOnboardingProgress" DROP COLUMN IF EXISTS "netboxDeviceCreated";

ALTER TABLE "OperatingSystem" DROP COLUMN IF EXISTS "netboxPlatformId";

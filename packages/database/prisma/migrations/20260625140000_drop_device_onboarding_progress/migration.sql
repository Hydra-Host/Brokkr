-- Option G onboarding redesign: the Device row (role=null) IS the onboarding record now, so the
-- DeviceOnboardingProgress table and its enum are retired. Pre-onboard state lives in the browser;
-- post-onboard progress is derived from the bridge saga steps + Server.lifecycleStatus.

-- DropTable
DROP TABLE IF EXISTS "DeviceOnboardingProgress";

-- DropEnum
DROP TYPE IF EXISTS "OnboardingStatus";

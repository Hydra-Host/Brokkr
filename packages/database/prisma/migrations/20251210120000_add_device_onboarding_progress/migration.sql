-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('Queued', 'InProgress', 'Evaluating', 'Done', 'Timeout', 'Failed');

-- CreateTable
CREATE TABLE "DeviceOnboardingProgress" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT,
    "macAddress" TEXT NOT NULL,
    "ipmiMacAddress" TEXT,
    "ipmiIp" TEXT,
    "deviceName" TEXT,
    "organizationId" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'Queued',
    "startTime" TIMESTAMP(3) NOT NULL,
    "powerCycleTriggered" BOOLEAN NOT NULL DEFAULT false,
    "netboxDeviceCreated" BOOLEAN NOT NULL DEFAULT false,
    "vaultCredentialsSaved" BOOLEAN NOT NULL DEFAULT false,
    "deviceDetailsChecked" BOOLEAN NOT NULL DEFAULT false,
    "networkingDetailsChecked" BOOLEAN NOT NULL DEFAULT false,
    "diskInfo" JSONB,
    "networkingInfo" JSONB,
    "ipmiLogin" TEXT,
    "ipmiPassword" TEXT,
    "bridgeTenantId" INTEGER,
    "bridgeSiteId" INTEGER,
    "bridgeLocationId" INTEGER,
    "lastCheckAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DeviceOnboardingProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceOnboardingProgress_organizationId_idx" ON "DeviceOnboardingProgress"("organizationId");

-- CreateIndex
CREATE INDEX "DeviceOnboardingProgress_macAddress_idx" ON "DeviceOnboardingProgress"("macAddress");

-- CreateIndex
CREATE INDEX "DeviceOnboardingProgress_organizationId_macAddress_idx" ON "DeviceOnboardingProgress"("organizationId", "macAddress");

-- CreateIndex
CREATE INDEX "DeviceOnboardingProgress_organizationId_acknowledged_idx" ON "DeviceOnboardingProgress"("organizationId", "acknowledged");

-- CreateIndex
CREATE INDEX "DeviceOnboardingProgress_organizationId_status_idx" ON "DeviceOnboardingProgress"("organizationId", "status");

-- CreateIndex
CREATE INDEX "DeviceOnboardingProgress_status_idx" ON "DeviceOnboardingProgress"("status");

-- CreateIndex
CREATE INDEX "DeviceOnboardingProgress_organizationId_macAddress_startTim_idx" ON "DeviceOnboardingProgress"("organizationId", "macAddress", "startTime");

-- AddForeignKey
ALTER TABLE "DeviceOnboardingProgress" ADD CONSTRAINT "DeviceOnboardingProgress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

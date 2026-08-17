-- CreateTable
CREATE TABLE "DevicePolicyConsent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,

    CONSTRAINT "DevicePolicyConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DevicePolicyConsent_userId_idx" ON "DevicePolicyConsent"("userId");

-- CreateIndex
CREATE INDEX "DevicePolicyConsent_deviceId_idx" ON "DevicePolicyConsent"("deviceId");

-- CreateIndex
CREATE INDEX "DevicePolicyConsent_policyId_idx" ON "DevicePolicyConsent"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "DevicePolicyConsent_userId_deviceId_policyId_key" ON "DevicePolicyConsent"("userId", "deviceId", "policyId");

-- AddForeignKey
ALTER TABLE "DevicePolicyConsent" ADD CONSTRAINT "DevicePolicyConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePolicyConsent" ADD CONSTRAINT "DevicePolicyConsent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePolicyConsent" ADD CONSTRAINT "DevicePolicyConsent_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "OrganizationSupplierPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

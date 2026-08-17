-- AlterTable
ALTER TABLE "FeatureFlags" ADD COLUMN     "investments" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LenderDeviceAssociation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LenderDeviceAssociation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LenderDeviceAssociation_organizationId_idx" ON "LenderDeviceAssociation"("organizationId");

-- CreateIndex
CREATE INDEX "LenderDeviceAssociation_deviceId_idx" ON "LenderDeviceAssociation"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "LenderDeviceAssociation_organizationId_deviceId_key" ON "LenderDeviceAssociation"("organizationId", "deviceId");

-- AddForeignKey
ALTER TABLE "LenderDeviceAssociation" ADD CONSTRAINT "LenderDeviceAssociation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LenderDeviceAssociation" ADD CONSTRAINT "LenderDeviceAssociation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

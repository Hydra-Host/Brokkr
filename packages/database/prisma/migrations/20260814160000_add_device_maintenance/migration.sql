-- CreateTable
CREATE TABLE "DeviceMaintenance" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "message" TEXT,
    "expectedEndAt" TIMESTAMP(3),
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabledBy" TEXT NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "disabledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceMaintenance_deviceId_disabledAt_idx" ON "DeviceMaintenance"("deviceId", "disabledAt");

-- AddForeignKey
ALTER TABLE "DeviceMaintenance" ADD CONSTRAINT "DeviceMaintenance_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce at-most-one active (disabledAt IS NULL) maintenance record per device.
-- Prisma cannot express partial unique indexes, so this is SQL-only — see the
-- Deployment_active_server_unique / InterruptibleClaim_deviceId_pending_unique precedent.
CREATE UNIQUE INDEX "DeviceMaintenance_deviceId_active_unique"
  ON "DeviceMaintenance"("deviceId") WHERE "disabledAt" IS NULL;

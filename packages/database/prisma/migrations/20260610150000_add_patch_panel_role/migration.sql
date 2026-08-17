-- Adds the PatchPanel device role and its per-role MTI extension table.
--
-- Rack-mounted patch panels terminating structured cabling. Passive hardware —
-- no power status enum/column (never reported; nothing to observe), no BMC,
-- no network presence. Mirrors the RackBrush extension shape: 1:1 with Device,
-- FK-only rows are valid (all domain columns nullable).

-- AlterEnum
ALTER TYPE "DeviceRole" ADD VALUE IF NOT EXISTS 'PatchPanel';

-- CreateTable
CREATE TABLE "PatchPanel" (
    "id"             TEXT NOT NULL,
    "panelType"      TEXT,
    "portCount"      INTEGER,
    "rackUnitHeight" INTEGER,
    "deviceId"       TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PatchPanel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatchPanel_deviceId_key" ON "PatchPanel"("deviceId");

-- AddForeignKey
ALTER TABLE "PatchPanel" ADD CONSTRAINT "PatchPanel_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Adds the RackBrush device role and its per-role MTI extension table.
--
-- Rack-mounted brush panels for cable pass-through. Passive hardware —
-- no power status enum/column (never reported; nothing to observe), no BMC,
-- no network presence. Mirrors the Pdu/Cdu extension shape: 1:1 with Device,
-- FK-only rows are valid (all domain columns nullable).

-- AlterEnum
ALTER TYPE "DeviceRole" ADD VALUE IF NOT EXISTS 'RackBrush';

-- CreateTable
CREATE TABLE "RackBrush" (
    "id"             TEXT NOT NULL,
    "brushMaterial"  TEXT,
    "rackUnitHeight" INTEGER,
    "deviceId"       TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RackBrush_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RackBrush_deviceId_key" ON "RackBrush"("deviceId");

-- AddForeignKey
ALTER TABLE "RackBrush" ADD CONSTRAINT "RackBrush_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

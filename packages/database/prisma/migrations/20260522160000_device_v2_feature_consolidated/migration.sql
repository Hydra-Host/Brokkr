-- Single migration that lands the entire device multi-table-inheritance
-- feature against master. Folds the earlier `DeviceV2` exploration back
-- onto the canonical `Device` table:
--
--   - Adds the per-role MTI extension tables (Server, Bridge, Switch,
--     Router, Pdu, Cdu) keyed off `Device.id`.
--   - Adds the `Cpu` per-socket inventory table.
--   - Extends `Device` with the columns the V2 work introduced
--     (`systemSerial`, `organizationId`, `deletedAt`).
--   - Backfills `Device.organizationId` from `Zone.organizationId` and
--     copies `Device.serial` → `Device.systemSerial`.
--   - Adds the canonical Brokkr role values to the existing `DeviceRole`
--     enum (`Server`, `Switch`, `Router`, `PDU`, `CDU` — `Bridge` already
--     existed).
--
-- The intermediate `DeviceV2` table, the `DeviceV2Role` / `DeviceV2Status`
-- enums, and the `deviceV2Id` dual-FK columns on the hardware tables are
-- deliberately NOT created — `Device` is the canonical name from day one.

-- ── DeviceRole enum extension ─────────────────────────────────────────
-- The existing enum already carries `Bridge`; the remaining five
-- canonical Brokkr roles are added so the MTI extensions can key off
-- `Device.role` directly. Older NetBox-shaped values (Hypervisor,
-- Baremetal, …, NetworkSwitch) stay in place for backward compat with
-- rows imported via the NetBox pipeline.
ALTER TYPE "DeviceRole" ADD VALUE IF NOT EXISTS 'Server';
ALTER TYPE "DeviceRole" ADD VALUE IF NOT EXISTS 'Switch';
ALTER TYPE "DeviceRole" ADD VALUE IF NOT EXISTS 'Router';
ALTER TYPE "DeviceRole" ADD VALUE IF NOT EXISTS 'PDU';
ALTER TYPE "DeviceRole" ADD VALUE IF NOT EXISTS 'CDU';

-- ── Device column additions ───────────────────────────────────────────
-- `systemSerial`  — SMBIOS system-level identifier; what most callers
--                   mean by "the device's serial". Backfilled from the
--                   existing `serial` column for parity.
-- `organizationId`— denormalized tenant FK so per-org reads don't need
--                   to join Zone. Backfilled from `Zone.organizationId`.
-- `deletedAt`     — soft-delete tombstone. NULL = live.
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "systemSerial"   TEXT;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP(3);

-- Backfill systemSerial from the legacy single-serial column.
UPDATE "Device"
SET    "systemSerial" = "serial"
WHERE  "systemSerial" IS NULL
  AND  "serial" IS NOT NULL;

-- Backfill organizationId from the device's zone.
UPDATE "Device" d
SET    "organizationId" = z."organizationId"
FROM   "Zone" z
WHERE  d."zoneId" = z."id"
  AND  d."organizationId" IS NULL;

ALTER TABLE "Device"
  ADD CONSTRAINT "Device_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Device_organizationId_idx" ON "Device"("organizationId");
CREATE INDEX IF NOT EXISTS "Device_deletedAt_idx"      ON "Device"("deletedAt");
CREATE INDEX IF NOT EXISTS "Device_role_idx"           ON "Device"("role");

-- ── Cpu (per-socket inventory) ────────────────────────────────────────
CREATE TABLE "Cpu" (
    "id"           TEXT NOT NULL,
    "socketIndex"  INTEGER NOT NULL,
    "model"        TEXT NOT NULL,
    "vendor"       TEXT,
    "architecture" TEXT,
    "coreCount"    INTEGER,
    "threadCount"  INTEGER,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deviceId"     TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cpu_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Cpu_deviceId_socketIndex_key" ON "Cpu"("deviceId", "socketIndex");
CREATE INDEX "Cpu_deviceId_idx" ON "Cpu"("deviceId");
CREATE INDEX "Cpu_model_idx"    ON "Cpu"("model");
ALTER TABLE "Cpu" ADD CONSTRAINT "Cpu_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Server (per-role extension for `role = 'Server'`) ─────────────────
CREATE TABLE "Server" (
    "id"               TEXT NOT NULL,
    "ipxeBuildTarget"  TEXT,
    "ipxeBuildVersion" TEXT,
    "purgeTtys"        BOOLEAN,
    "storageLayouts"   JSONB NOT NULL DEFAULT '{}',
    "netplanOverride"  TEXT,
    "kernelCmdline"    TEXT,
    "vpcCapable"       BOOLEAN DEFAULT false,
    "teeEnabled"       BOOLEAN NOT NULL DEFAULT false,
    "monitored"        BOOLEAN NOT NULL DEFAULT false,
    "monitorPsk"       TEXT,
    "ecoMode"          BOOLEAN NOT NULL DEFAULT false,
    "deviceId"         TEXT NOT NULL,
    "configTemplateId" TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Server_deviceId_key"            ON "Server"("deviceId");
CREATE INDEX        "Server_configTemplateId_idx"    ON "Server"("configTemplateId");
ALTER TABLE "Server" ADD CONSTRAINT "Server_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Server" ADD CONSTRAINT "Server_configTemplateId_fkey"
  FOREIGN KEY ("configTemplateId") REFERENCES "ConfigTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Bridge / Switch / Router / Pdu / Cdu (per-role extensions) ────────
CREATE TABLE "Bridge" (
    "id"               TEXT NOT NULL,
    "bridgeVersion"    TEXT,
    "redisQueuePrefix" TEXT,
    "lastSeenAt"       TIMESTAMP(3),
    "deviceId"         TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Bridge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Bridge_deviceId_key" ON "Bridge"("deviceId");
ALTER TABLE "Bridge" ADD CONSTRAINT "Bridge_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Switch" (
    "id"         TEXT NOT NULL,
    "switchRole" TEXT,
    "fabric"     TEXT,
    "portCount"  INTEGER,
    "deviceId"   TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Switch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Switch_deviceId_key" ON "Switch"("deviceId");
ALTER TABLE "Switch" ADD CONSTRAINT "Switch_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Router" (
    "id"         TEXT NOT NULL,
    "routerType" TEXT,
    "bgpAsn"     INTEGER,
    "deviceId"   TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Router_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Router_deviceId_key" ON "Router"("deviceId");
ALTER TABLE "Router" ADD CONSTRAINT "Router_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Pdu" (
    "id"            TEXT NOT NULL,
    "outletCount"   INTEGER,
    "ratedAmperage" INTEGER,
    "voltageType"   TEXT,
    "deviceId"      TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Pdu_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Pdu_deviceId_key" ON "Pdu"("deviceId");
ALTER TABLE "Pdu" ADD CONSTRAINT "Pdu_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Cdu" (
    "id"                     TEXT NOT NULL,
    "coolantType"            TEXT,
    "ratedFlowRateLpm"       DOUBLE PRECISION,
    "ratedThermalCapacityKw" INTEGER,
    "deviceId"               TEXT NOT NULL,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cdu_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Cdu_deviceId_key" ON "Cdu"("deviceId");
ALTER TABLE "Cdu" ADD CONSTRAINT "Cdu_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

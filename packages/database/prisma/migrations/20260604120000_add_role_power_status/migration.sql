-- Add per-role observed power status.
--
-- Power state ("is the box powered on right now") lives on the per-role MTI
-- extension tables, one typed enum per role. Independent of the coarse
-- `Device.status` and of `Server.lifecycleStatus`. Servers additionally carry
-- the transitional states (PoweringOn / PoweringOff / Rebooting) the bridge
-- power-control saga drives; the other roles are On/Off only. Every column is
-- nullable: NULL means "power state unknown / never observed".
--
-- The legacy free-form `Device.powerStatus` String is intentionally left in
-- place (deprecated) until its main-api / web / cli readers migrate off it.

-- ── 1. Per-role power-status enums ───────────────────────────────────────
CREATE TYPE "ServerPowerStatus" AS ENUM ('On', 'Off', 'PoweringOn', 'PoweringOff', 'Rebooting');
CREATE TYPE "BridgePowerStatus" AS ENUM ('On', 'Off');
CREATE TYPE "CduPowerStatus" AS ENUM ('On', 'Off');
CREATE TYPE "PduPowerStatus" AS ENUM ('On', 'Off');
CREATE TYPE "RouterPowerStatus" AS ENUM ('On', 'Off');
CREATE TYPE "SwitchPowerStatus" AS ENUM ('On', 'Off');

-- ── 2. Nullable power-status column on each role extension ────────────────
ALTER TABLE "Server" ADD COLUMN "powerStatus" "ServerPowerStatus";
ALTER TABLE "Bridge" ADD COLUMN "powerStatus" "BridgePowerStatus";
ALTER TABLE "Cdu" ADD COLUMN "powerStatus" "CduPowerStatus";
ALTER TABLE "Pdu" ADD COLUMN "powerStatus" "PduPowerStatus";
ALTER TABLE "Router" ADD COLUMN "powerStatus" "RouterPowerStatus";
ALTER TABLE "Switch" ADD COLUMN "powerStatus" "SwitchPowerStatus";

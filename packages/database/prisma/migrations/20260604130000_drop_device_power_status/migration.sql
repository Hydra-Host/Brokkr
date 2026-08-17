-- Drop the legacy free-form Device.powerStatus String column.
--
-- Power state now lives on the per-role extension tables as typed enums
-- (Server.powerStatus, Bridge.powerStatus, …), populated by the real-time
-- writers (bridge power-control, phone-home, provisioning).
--
-- Before dropping, carry the existing free-form Device.powerStatus values
-- onto each role extension. NetBox can't be relied on as the source of truth
-- here (its power_status custom field is stale), so we migrate the live DB
-- column directly. The legacy strings are the @repo/utils power words:
--   'Running' | 'Powered Off' | 'Starting' | 'Shutting Down' | 'Rebooting'.
-- Server carries the transitional states, so all five round-trip 1:1. The
-- binary roles (Bridge/Cdu/Pdu/Router/Switch) are On|Off only, so the
-- transitional words are unrepresentable and collapse to NULL ("unknown").
-- Anything else (or NULL) maps to NULL — power state genuinely unknown.

-- ── 1. Backfill the per-role power-status enums from Device.powerStatus ──
UPDATE "Server" s
SET "powerStatus" = CASE d."powerStatus"
  WHEN 'Running'       THEN 'On'::"ServerPowerStatus"
  WHEN 'Powered Off'   THEN 'Off'::"ServerPowerStatus"
  WHEN 'Starting'      THEN 'PoweringOn'::"ServerPowerStatus"
  WHEN 'Shutting Down' THEN 'PoweringOff'::"ServerPowerStatus"
  WHEN 'Rebooting'     THEN 'Rebooting'::"ServerPowerStatus"
  ELSE NULL
END
FROM "Device" d
WHERE s."deviceId" = d."id"
  AND d."powerStatus" IS NOT NULL;

UPDATE "Bridge" b
SET "powerStatus" = CASE d."powerStatus"
  WHEN 'Running'     THEN 'On'::"BridgePowerStatus"
  WHEN 'Powered Off' THEN 'Off'::"BridgePowerStatus"
  ELSE NULL
END
FROM "Device" d
WHERE b."deviceId" = d."id"
  AND d."powerStatus" IS NOT NULL;

UPDATE "Cdu" c
SET "powerStatus" = CASE d."powerStatus"
  WHEN 'Running'     THEN 'On'::"CduPowerStatus"
  WHEN 'Powered Off' THEN 'Off'::"CduPowerStatus"
  ELSE NULL
END
FROM "Device" d
WHERE c."deviceId" = d."id"
  AND d."powerStatus" IS NOT NULL;

UPDATE "Pdu" p
SET "powerStatus" = CASE d."powerStatus"
  WHEN 'Running'     THEN 'On'::"PduPowerStatus"
  WHEN 'Powered Off' THEN 'Off'::"PduPowerStatus"
  ELSE NULL
END
FROM "Device" d
WHERE p."deviceId" = d."id"
  AND d."powerStatus" IS NOT NULL;

UPDATE "Router" r
SET "powerStatus" = CASE d."powerStatus"
  WHEN 'Running'     THEN 'On'::"RouterPowerStatus"
  WHEN 'Powered Off' THEN 'Off'::"RouterPowerStatus"
  ELSE NULL
END
FROM "Device" d
WHERE r."deviceId" = d."id"
  AND d."powerStatus" IS NOT NULL;

UPDATE "Switch" sw
SET "powerStatus" = CASE d."powerStatus"
  WHEN 'Running'     THEN 'On'::"SwitchPowerStatus"
  WHEN 'Powered Off' THEN 'Off'::"SwitchPowerStatus"
  ELSE NULL
END
FROM "Device" d
WHERE sw."deviceId" = d."id"
  AND d."powerStatus" IS NOT NULL;

-- ── 2. Drop the now-redundant base-Device column ────────────────────────
ALTER TABLE "Device" DROP COLUMN "powerStatus";

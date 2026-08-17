-- Replace the legacy stringified NetBox id with a proper FK to the new
-- `Device` table, while keeping the raw NetBox id around under its honest
-- name for the tail of the migration window.
--
-- Before: `deviceId TEXT` — a stringified NetBox device id, no FK, no relation,
--         joined by `findMany({ where: { deviceId: String(netboxId) } })`.
-- After : `deviceId TEXT` — Brokkr Device UUID, real FK, real relation.
--         `netboxId TEXT` — the old column, renamed to reflect what it is.
--
-- Rename is done via `ALTER TABLE RENAME COLUMN`, which is a metadata-only
-- operation — no row is rewritten and no data is lost.

-- 1. Rename the legacy column to its honest name.
ALTER TABLE "DeviceOnboardingProgress" RENAME COLUMN "deviceId" TO "netboxId";

-- 2. Add the new UUID FK column.
ALTER TABLE "DeviceOnboardingProgress" ADD COLUMN "deviceId" TEXT;

-- 3. Backfill by joining through the renamed column. Guard the cast so
--    non-numeric legacy values don't crash the migration.
UPDATE "DeviceOnboardingProgress" p
SET "deviceId" = d."id"
FROM "Device" d
WHERE p."netboxId" ~ '^[0-9]+$'
  AND d."netboxId" = p."netboxId"::int;

-- 4. Index + FK.
CREATE INDEX "DeviceOnboardingProgress_deviceId_idx"
  ON "DeviceOnboardingProgress"("deviceId");

ALTER TABLE "DeviceOnboardingProgress"
  ADD CONSTRAINT "DeviceOnboardingProgress_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

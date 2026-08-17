-- Split device status into two independent axes.
--
-- Before: `Device.status` (DeviceStatus) carried BOTH the coarse,
-- role-agnostic lifecycle (PLANNED/STAGED/ACTIVE/MAINTENANCE) AND the granular
-- server-only operational state (INVENTORY/PROVISIONING/PROVISIONED/OFFLINE/
-- FAILED/DECOMMISSIONING) in a single 10-value enum.
--
-- After:
--   * `Device.status` (DeviceStatus)            — the 4 coarse states, every role.
--   * `Server.lifecycleStatus` (ServerLifecycleStatus) — the 6 operational
--                                                  states, server-role only.
--
-- The two axes are independent. NetBox still carries one status slug per
-- device; the application decomposes it across the two fields (see
-- `device-status-utils.ts`). This migration performs the same decomposition
-- in-place for existing rows, then narrows the DeviceStatus enum to 4 values.

-- ── 1. New server operational lifecycle enum ─────────────────────────────
CREATE TYPE "ServerLifecycleStatus" AS ENUM (
  'INVENTORY',
  'PROVISIONING',
  'PROVISIONED',
  'OFFLINE',
  'FAILED',
  'DECOMMISSIONING'
);

-- ── 2. Add Server.lifecycleStatus (nullable for the backfill window) ─────
ALTER TABLE "Server" ADD COLUMN "lifecycleStatus" "ServerLifecycleStatus";

-- ── 3. Decompose: copy the owning Device.status operational state down onto
--       the Server row. Mirrors NETBOX_TO_SERVER_LIFECYCLE: the 6 operational
--       values map 1:1; the 4 coarse values map to their nearest operational
--       state (PLANNED→INVENTORY, STAGED→PROVISIONING, ACTIVE→PROVISIONED,
--       MAINTENANCE→OFFLINE) so a server is never left without a lifecycle.
UPDATE "Server" s
SET "lifecycleStatus" = (
  CASE d."status"::text
    WHEN 'INVENTORY'        THEN 'INVENTORY'
    WHEN 'PROVISIONING'     THEN 'PROVISIONING'
    WHEN 'PROVISIONED'      THEN 'PROVISIONED'
    WHEN 'OFFLINE'          THEN 'OFFLINE'
    WHEN 'FAILED'           THEN 'FAILED'
    WHEN 'DECOMMISSIONING'  THEN 'DECOMMISSIONING'
    WHEN 'STAGED'           THEN 'PROVISIONING'
    WHEN 'ACTIVE'           THEN 'PROVISIONED'
    WHEN 'MAINTENANCE'      THEN 'OFFLINE'
    ELSE 'INVENTORY' -- PLANNED and any unexpected value
  END
)::"ServerLifecycleStatus"
FROM "Device" d
WHERE s."deviceId" = d."id";

-- ── 4. Default for new rows + enforce NOT NULL ───────────────────────────
ALTER TABLE "Server" ALTER COLUMN "lifecycleStatus" SET DEFAULT 'INVENTORY';
UPDATE "Server" SET "lifecycleStatus" = 'INVENTORY' WHERE "lifecycleStatus" IS NULL;
ALTER TABLE "Server" ALTER COLUMN "lifecycleStatus" SET NOT NULL;

-- ── 5. Collapse Device.status operational values into the 4 coarse states
--       (done while the column is still the wide enum). Device.status is the
--       onboarding pipeline (PLANNED → STAGED → ACTIVE) where ACTIVE is the
--       terminal "onboarded / in service" state; MAINTENANCE means off-floor.
--       Every operational value implies the device already finished onboarding,
--       so they all collapse to ACTIVE except OFFLINE → MAINTENANCE. The
--       granular operational state is preserved on Server.lifecycleStatus
--       (step 3), so this stays lossless: old 'planned' → (PLANNED, INVENTORY)
--       remains distinct from old 'inventory' → (ACTIVE, INVENTORY). Leaves
--       Device.role untouched so the write-once role trigger passes for every row.
UPDATE "Device"
SET "status" = (
  CASE "status"::text
    WHEN 'INVENTORY'        THEN 'ACTIVE'
    WHEN 'PROVISIONING'     THEN 'ACTIVE'
    WHEN 'PROVISIONED'      THEN 'ACTIVE'
    WHEN 'FAILED'           THEN 'ACTIVE'
    WHEN 'DECOMMISSIONING'  THEN 'ACTIVE'
    WHEN 'OFFLINE'          THEN 'MAINTENANCE'
    ELSE "status"::text
  END
)::"DeviceStatus"
WHERE "status"::text IN (
  'INVENTORY', 'PROVISIONING', 'PROVISIONED', 'OFFLINE', 'FAILED', 'DECOMMISSIONING'
);

-- ── 6. Recreate the DeviceStatus enum with only the 4 coarse states ──────
--       Standard Postgres "narrow an enum" dance: drop the default, swap the
--       type via a text cast, restore the default, drop the old type.
ALTER TABLE "Device" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "DeviceStatus" RENAME TO "DeviceStatus_old";
CREATE TYPE "DeviceStatus" AS ENUM ('PLANNED', 'STAGED', 'ACTIVE', 'MAINTENANCE');
ALTER TABLE "Device"
  ALTER COLUMN "status" TYPE "DeviceStatus" USING ("status"::text::"DeviceStatus");
ALTER TABLE "Device" ALTER COLUMN "status" SET DEFAULT 'PLANNED';
DROP TYPE "DeviceStatus_old";

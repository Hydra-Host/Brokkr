-- Move rental / billing / reservation FKs from Device.id to Server.id.
--
-- Six tables today reference `Device("id")` via `deviceId`:
--   Deployment, SubscriptionItem, InterruptibleClaim,
--   DeviceOperatingSystem, DevicesInReservation, DevicesInReservationInvite
--
-- All six represent things you can only do to a Server-shaped host
-- (rent it, bill it, deploy an OS to it, reserve it). After the MTI
-- feature lands, the canonical "this is a rentable host" identity
-- lives on `Server`, not `Device`. This migration re-targets each FK
-- accordingly so the database can enforce the invariant
-- "rentals/billing/reservations are bound to a Server row" instead of
-- the weaker "...to any Device row".
--
-- Three of the six tables (DeviceOperatingSystem, DevicesInReservation,
-- DevicesInReservationInvite) carry the deviceId in their composite
-- primary key. They're rebuilt on (serverId, ...) and renamed to
-- reflect the new domain:
--   DeviceOperatingSystem        -> ServerOperatingSystem
--   DevicesInReservation         -> ServersInReservation
--   DevicesInReservationInvite   -> ServersInReservationInvite
--
-- Pre-flight: every `deviceId` on the six tables below must reference a
-- server-shaped Device (role in `SERVER_ROLES`, see
-- `apps/api/src/common/role-server.ts`) so the inline backfill (Step 1)
-- gives it a `Server` row. If a `deviceId` references a non-server-shaped
-- Device, Step B (UPDATE) leaves `serverId` NULL and Step C (`SET NOT
-- NULL`) aborts the transaction.
--
-- ON DELETE / ON UPDATE clauses preserve current semantics per the
-- 20260423143000_fix_netbox_port_fk_behaviors and
-- 20260416200222_netbox_port migrations (RESTRICT/CASCADE for required
-- relations, SET NULL/CASCADE for SubscriptionItem's nullable relation).

-- ─────────────────────────────────────────────────────────────────────
-- 1. Inline Server backfill
-- ─────────────────────────────────────────────────────────────────────
-- Mirrors the `SERVER_ROLES` eligibility set in `apps/api/src/common/role-server.ts`:
-- every Device whose role qualifies as a compute host gets a Server row
-- if one doesn't exist yet. The eligibility list below must stay in sync
-- with `SERVER_ROLES`; `role-server.spec.ts` asserts that. Eligibility set:
--   - Legacy host roles (SERVER_ROLES): Baremetal, Hypervisor, Cluster,
--     DiscoveredHost, OffMarketplaceHost, Deprecated
--   - Canonical v2 role: Server
-- Anything else (Bridge, VM, NetworkSwitch, Switch, Router, PDU, CDU,
-- NULL) is skipped — those Devices shouldn't have rentals attached
-- (operators must verify this manually per the pre-flight note above).
--
-- `storageLayouts` is COALESCEd to '{}' to mirror the TypeScript
-- backfill's `device.storageLayouts ?? {}`, keeping behavior identical
-- whether the source Device row had null or {} historically.
INSERT INTO "Server" (
  id,
  "deviceId",
  "ipxeBuildTarget",
  "ipxeBuildVersion",
  "purgeTtys",
  "configTemplateId",
  "kernelCmdline",
  "storageLayouts",
  "netplanOverride",
  "vpcCapable",
  "teeEnabled",
  "monitored",
  "monitorPsk",
  "ecoMode",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  d.id,
  d."ipxeBuildTarget",
  d."ipxeBuildVersion",
  d."purgeTtys",
  d."configTemplateId",
  d."kernelCmdline",
  COALESCE(d."storageLayouts", '{}'::jsonb),
  d."netplanOverride",
  d."vpcCapable",
  d."teeEnabled",
  d."monitored",
  d."monitorPsk",
  d."ecoMode",
  NOW(),
  NOW()
FROM "Device" d
LEFT JOIN "Server" s ON s."deviceId" = d.id
WHERE d.role IN (
  'Baremetal'::"DeviceRole",
  'Hypervisor'::"DeviceRole",
  'Cluster'::"DeviceRole",
  'DiscoveredHost'::"DeviceRole",
  'OffMarketplaceHost'::"DeviceRole",
  'Deprecated'::"DeviceRole",
  'Server'::"DeviceRole"
)
  AND s.id IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Deployment — simple table swap
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "Deployment" ADD COLUMN "serverId" TEXT;

UPDATE "Deployment" d
SET    "serverId" = s.id
FROM   "Server" s
WHERE  s."deviceId" = d."deviceId";

ALTER TABLE "Deployment" ALTER COLUMN "serverId" SET NOT NULL;
ALTER TABLE "Deployment" DROP CONSTRAINT "Deployment_deviceId_fkey";
ALTER TABLE "Deployment" DROP COLUMN "deviceId";

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lookups by serverId are common (find-active-deployment-for-server,
-- billing reconciliation). No prior deviceId index existed; adding
-- one now is cheap and matches the pattern used elsewhere.
CREATE INDEX "Deployment_serverId_idx" ON "Deployment"("serverId");

-- ─────────────────────────────────────────────────────────────────────
-- 3. SubscriptionItem — simple table swap, nullable
-- ─────────────────────────────────────────────────────────────────────
-- `serverId` stays nullable: off-Brokkr / down-payment subscription
-- items legitimately have no host attached. ON DELETE SET NULL mirrors
-- the prior deviceId behavior.
ALTER TABLE "SubscriptionItem" ADD COLUMN "serverId" TEXT;

UPDATE "SubscriptionItem" si
SET    "serverId" = s.id
FROM   "Server" s
WHERE  s."deviceId" = si."deviceId";

-- No SET NOT NULL — nullable by design.
ALTER TABLE "SubscriptionItem" DROP CONSTRAINT "SubscriptionItem_deviceId_fkey";
ALTER TABLE "SubscriptionItem" DROP COLUMN "deviceId";

ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SubscriptionItem_serverId_idx" ON "SubscriptionItem"("serverId");

-- ─────────────────────────────────────────────────────────────────────
-- 4. InterruptibleClaim — simple table swap + partial unique rebuild
-- ─────────────────────────────────────────────────────────────────────
-- The partial unique index on deviceId WHERE status='Pending' guards
-- the "one pending claim per host" race condition (see
-- 20260122180000_fix_interruptible_claim_unique_index). It must be
-- recreated on serverId before the deviceId column is dropped — the
-- semantic is identical since Server-Device is 1:1.
DROP INDEX IF EXISTS "InterruptibleClaim_deviceId_pending_unique";

ALTER TABLE "InterruptibleClaim" ADD COLUMN "serverId" TEXT;

UPDATE "InterruptibleClaim" ic
SET    "serverId" = s.id
FROM   "Server" s
WHERE  s."deviceId" = ic."deviceId";

ALTER TABLE "InterruptibleClaim" ALTER COLUMN "serverId" SET NOT NULL;
ALTER TABLE "InterruptibleClaim" DROP CONSTRAINT "InterruptibleClaim_deviceId_fkey";
ALTER TABLE "InterruptibleClaim" DROP COLUMN "deviceId";

ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "InterruptibleClaim_serverId_idx" ON "InterruptibleClaim"("serverId");

-- Partial unique: at most one Pending claim per Server. Matches the
-- behavior of the prior InterruptibleClaim_deviceId_pending_unique.
CREATE UNIQUE INDEX "InterruptibleClaim_serverId_pending_unique"
  ON "InterruptibleClaim"("serverId")
  WHERE status = 'Pending';

-- ─────────────────────────────────────────────────────────────────────
-- 5. DeviceOperatingSystem -> ServerOperatingSystem
-- ─────────────────────────────────────────────────────────────────────
-- Composite PK (deviceId, operatingSystemId) rebuilt as
-- (serverId, operatingSystemId). No other tables FK into this PK
-- (DeviceOperatingSystemLayer was the only dependent and was DROPped
-- in 20260509000920_layer_artifact_and_deployment_layer).
ALTER TABLE "DeviceOperatingSystem" ADD COLUMN "serverId" TEXT;

UPDATE "DeviceOperatingSystem" dos
SET    "serverId" = s.id
FROM   "Server" s
WHERE  s."deviceId" = dos."deviceId";

ALTER TABLE "DeviceOperatingSystem" ALTER COLUMN "serverId" SET NOT NULL;
ALTER TABLE "DeviceOperatingSystem" DROP CONSTRAINT "DeviceOperatingSystem_pkey";
ALTER TABLE "DeviceOperatingSystem" DROP CONSTRAINT "DeviceOperatingSystem_deviceId_fkey";
ALTER TABLE "DeviceOperatingSystem" DROP COLUMN "deviceId";

ALTER TABLE "DeviceOperatingSystem" RENAME TO "ServerOperatingSystem";

ALTER TABLE "ServerOperatingSystem" ADD CONSTRAINT "ServerOperatingSystem_pkey"
  PRIMARY KEY ("serverId", "operatingSystemId");
ALTER TABLE "ServerOperatingSystem" ADD CONSTRAINT "ServerOperatingSystem_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The operatingSystemId FK stays semantically identical; rename for
-- naming consistency with the new table.
ALTER TABLE "ServerOperatingSystem"
  RENAME CONSTRAINT "DeviceOperatingSystem_operatingSystemId_fkey"
                 TO "ServerOperatingSystem_operatingSystemId_fkey";

-- ─────────────────────────────────────────────────────────────────────
-- 6. DevicesInReservation -> ServersInReservation
-- ─────────────────────────────────────────────────────────────────────
-- Composite PK (reservationId, deviceId) rebuilt as
-- (reservationId, serverId). The standalone `id @unique` UUID column
-- is preserved (used as a stable per-row identifier elsewhere); its
-- unique index is renamed.
ALTER TABLE "DevicesInReservation" ADD COLUMN "serverId" TEXT;

UPDATE "DevicesInReservation" dir
SET    "serverId" = s.id
FROM   "Server" s
WHERE  s."deviceId" = dir."deviceId";

ALTER TABLE "DevicesInReservation" ALTER COLUMN "serverId" SET NOT NULL;
ALTER TABLE "DevicesInReservation" DROP CONSTRAINT "DevicesInReservation_pkey";
ALTER TABLE "DevicesInReservation" DROP CONSTRAINT "DevicesInReservation_deviceId_fkey";
ALTER TABLE "DevicesInReservation" DROP COLUMN "deviceId";

ALTER TABLE "DevicesInReservation" RENAME TO "ServersInReservation";

ALTER TABLE "ServersInReservation" ADD CONSTRAINT "ServersInReservation_pkey"
  PRIMARY KEY ("reservationId", "serverId");
ALTER TABLE "ServersInReservation" ADD CONSTRAINT "ServersInReservation_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServersInReservation"
  RENAME CONSTRAINT "DevicesInReservation_reservationId_fkey"
                 TO "ServersInReservation_reservationId_fkey";

ALTER INDEX "DevicesInReservation_id_key"
  RENAME TO "ServersInReservation_id_key";

-- ─────────────────────────────────────────────────────────────────────
-- 7. DevicesInReservationInvite -> ServersInReservationInvite
-- ─────────────────────────────────────────────────────────────────────
-- Composite PK (deviceId, reservationInviteId) rebuilt as
-- (serverId, reservationInviteId).
ALTER TABLE "DevicesInReservationInvite" ADD COLUMN "serverId" TEXT;

UPDATE "DevicesInReservationInvite" diri
SET    "serverId" = s.id
FROM   "Server" s
WHERE  s."deviceId" = diri."deviceId";

ALTER TABLE "DevicesInReservationInvite" ALTER COLUMN "serverId" SET NOT NULL;
ALTER TABLE "DevicesInReservationInvite" DROP CONSTRAINT "DevicesInReservationInvite_pkey";
ALTER TABLE "DevicesInReservationInvite" DROP CONSTRAINT "DevicesInReservationInvite_deviceId_fkey";
ALTER TABLE "DevicesInReservationInvite" DROP COLUMN "deviceId";

ALTER TABLE "DevicesInReservationInvite" RENAME TO "ServersInReservationInvite";

ALTER TABLE "ServersInReservationInvite" ADD CONSTRAINT "ServersInReservationInvite_pkey"
  PRIMARY KEY ("serverId", "reservationInviteId");
ALTER TABLE "ServersInReservationInvite" ADD CONSTRAINT "ServersInReservationInvite_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServersInReservationInvite"
  RENAME CONSTRAINT "DevicesInReservationInvite_reservationInviteId_fkey"
                 TO "ServersInReservationInvite_reservationInviteId_fkey";

-- ─────────────────────────────────────────────────────────────────────
-- 8. Marketplace pricing — mirror seven Device columns onto Server
-- ─────────────────────────────────────────────────────────────────────
-- Seven pricing/listing columns historically lived on Device:
--   stripeProductId, defaultStripePriceId, hourlyPrice,
--   floorHourlyPrice, floorStripePriceId, isListed, isInterruptible
--
-- They semantically only ever apply to host-shaped Devices (the ones
-- that get rented through the marketplace). Bridges/Switches/PDUs etc.
-- never have meaningful values here. Now that every host-shaped Device
-- has a Server row (Section 1), we mirror those columns onto Server
-- and cut application reads/writes over to the Server-side originals
-- in the same release.
--
-- Strategy: pure additive backfill. The Device-side columns are NOT
-- dropped — they stay in place as a frozen audit snapshot of the
-- values at migration time. Once the application no longer reads or
-- writes those columns (which it doesn't, post-cutover), Device-side
-- mutations stop and Server becomes the sole source of truth. The
-- DROP is a follow-up migration after the app cut-over has soaked.
--
-- Defaults + nullability mirror Device exactly so call-site swaps are
-- a pure source change with no semantic difference.
ALTER TABLE "Server"
  ADD COLUMN "stripeProductId"      TEXT,
  ADD COLUMN "defaultStripePriceId" TEXT,
  ADD COLUMN "hourlyPrice"          DECIMAL(65,30),
  ADD COLUMN "floorHourlyPrice"     DECIMAL(65,30),
  ADD COLUMN "floorStripePriceId"   TEXT,
  ADD COLUMN "isListed"             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isInterruptible"      BOOLEAN NOT NULL DEFAULT false;

-- Backfill: copy the seven values from the underlying Device row.
-- Joins via the freshly-populated `deviceId` (every Server has one;
-- it's `UNIQUE NOT NULL`). For boolean columns the COALESCE is
-- defense-in-depth — Device's boolean columns are NOT NULL DEFAULT
-- false today, but if a future Device column ever loses NOT NULL
-- we'd silently insert NULL into a NOT NULL Server column and abort
-- the whole migration. COALESCE prevents the abort and lands the
-- same false the application would have written anyway.
UPDATE "Server" s
SET    "stripeProductId"      = d."stripeProductId",
       "defaultStripePriceId" = d."defaultStripePriceId",
       "hourlyPrice"          = d."hourlyPrice",
       "floorHourlyPrice"     = d."floorHourlyPrice",
       "floorStripePriceId"   = d."floorStripePriceId",
       "isListed"             = COALESCE(d."isListed", false),
       "isInterruptible"      = COALESCE(d."isInterruptible", false)
FROM   "Device" d
WHERE  s."deviceId" = d.id;

-- ─────────────────────────────────────────────────────────────────────
-- 9. Attach changelog_trigger to Server
-- ─────────────────────────────────────────────────────────────────────
-- The Device table has changelog_trigger attached (see
-- 20260515120000_add_device_changelog_trigger). Post-cutover, writes
-- to the seven marketplace columns stop landing on Device and start
-- landing on Server. Attach the (row-shape-agnostic) trigger function
-- to Server so audit coverage of pricing/listing changes follows the
-- write path. The partial indexes
--   idx_changelog_diff_is_listed_true / false
--   idx_changelog_diff_is_interruptible_true / false
-- key off `(diff->>'isListed')` / `(diff->>'isInterruptible')` and
-- do NOT filter by `tableName`, so Server-sourced diffs start being
-- indexed automatically — no index changes required.
--
-- Same trigger function (`changelog_trigger_func`) Device uses; it
-- serializes via `row_to_json(NEW)` + `TG_TABLE_NAME` so it adapts
-- to any table shape with a UUID-typed `id` column. Server's
-- `id String @id @default(uuid())` satisfies that.
CREATE OR REPLACE TRIGGER changelog_trigger
    AFTER INSERT OR UPDATE OR DELETE ON "Server"
    FOR EACH ROW EXECUTE FUNCTION changelog_trigger_func();

-- ─────────────────────────────────────────────────────────────────────
-- 10. Consolidate legacy host roles to the canonical `Server` role
-- ─────────────────────────────────────────────────────────────────────
-- Section 1 gave every host-shaped Device a Server extension row but
-- left `Device.role` at its legacy value. The per-role record classes
-- (e.g. `BaremetalRecord`) pin `role = Server` as their discriminator,
-- so the post-MTI invariant must hold:
--   "Device has a Server extension row  iff  Device.role = Server".
-- This step flips the legacy host roles to `Server` so existing rows
-- are visible through those records.
--
-- Targeted by role list (the same set Section 1 backfilled). Non-host
-- roles (VM, NetworkSwitch, Bridge, Switch, Router, Pdu, Cdu) are
-- intentionally excluded — they never got a Server row.
--
-- `Deprecated` is folded into the soft-delete model: a deprecated host
-- becomes a soft-deleted Server (`role = Server` + `deletedAt` set)
-- rather than carrying a distinct role. `COALESCE` preserves an
-- already-set `deletedAt` and only stamps NOW() on rows that weren't
-- previously tombstoned.

-- Active host roles → Server (role only; these stay live).
UPDATE "Device"
SET    "role" = 'Server'::"DeviceRole"
WHERE  "role" IN (
  'Baremetal'::"DeviceRole",
  'Hypervisor'::"DeviceRole",
  'Cluster'::"DeviceRole",
  'DiscoveredHost'::"DeviceRole",
  'OffMarketplaceHost'::"DeviceRole"
);

-- Deprecated hosts → soft-deleted Server.
UPDATE "Device"
SET    "role"      = 'Server'::"DeviceRole",
       "deletedAt" = COALESCE("deletedAt", NOW())
WHERE  "role" = 'Deprecated'::"DeviceRole";

-- ─────────────────────────────────────────────────────────────────────
-- 11. Final safety assertions
-- ─────────────────────────────────────────────────────────────────────
-- Defense-in-depth. The intermediate SET NOT NULL steps already enforce
-- these invariants on the non-nullable tables; an explicit DO block
-- makes the intent visible in the SQL and catches any silent NULL that
-- would otherwise propagate to the next release.
DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM "Deployment" WHERE "serverId" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: Deployment.serverId NULL count = %', bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count FROM "InterruptibleClaim" WHERE "serverId" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: InterruptibleClaim.serverId NULL count = %', bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count FROM "ServerOperatingSystem" WHERE "serverId" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: ServerOperatingSystem.serverId NULL count = %', bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count FROM "ServersInReservation" WHERE "serverId" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: ServersInReservation.serverId NULL count = %', bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count FROM "ServersInReservationInvite" WHERE "serverId" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: ServersInReservationInvite.serverId NULL count = %', bad_count;
  END IF;

  -- Role-consolidation invariant (Section 10): every Device that has a
  -- Server extension row must now carry role = Server — the discriminator
  -- the per-role records pin on. A non-zero count means a host-shaped
  -- Device's role wasn't flipped (or a Server row exists for an
  -- unexpected role), which would make that device invisible to
  -- `BaremetalRecord` and its siblings.
  SELECT COUNT(*) INTO bad_count
  FROM "Server" s
  INNER JOIN "Device" d ON d.id = s."deviceId"
  WHERE d."role" IS DISTINCT FROM 'Server'::"DeviceRole";
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % Server-backed Device(s) not role=Server', bad_count;
  END IF;
END $$;

-- Remove the legacy OperatingSystem catalog + the ServerOperatingSystem join,
-- now fully replaced by the Layer system (Deployment.baseLayerId / rescueLayerId).

-- Serialize the guard SELECT and the subsequent DDL so no concurrent write can
-- commit between the check and the column drops (eliminates TOCTOU window).
LOCK TABLE "Deployment" IN ACCESS EXCLUSIVE MODE;

-- Fail-closed guard: abort if any active deployment's REQUIRED base OS was not
-- backfilled by migration 00100, before the OperatingSystem table is destroyed.
-- Only the base path is hard-guarded: operatingSystemId is NOT NULL and never
-- cleared, so an unmapped baseLayerId is a genuine backfill failure. The rescue
-- path is intentionally NOT guarded here — post-cutover (layer-only) rescue
-- deactivation clears rescueLayerId but leaves the legacy
-- currentRescueOperatingSystemId stale, so a NULL rescueLayerId is the normal
-- deactivated state, indistinguishable from a genuine miss. Migrations 00100
-- and 00125 RAISE NOTICEs with rescue mapped/unmapped counts for observability.
DO $$
DECLARE
  unmapped_base INT;
BEGIN
  SELECT COUNT(*) INTO unmapped_base
  FROM "Deployment"
  WHERE "endDate" IS NULL
    AND "operatingSystemId" IS NOT NULL
    AND "baseLayerId" IS NULL;

  IF unmapped_base > 0 THEN
    RAISE EXCEPTION 'Aborting: % active Deployment(s) have operatingSystemId set but baseLayerId is NULL after backfill — resolve slug mismatches or run seeders before applying this migration.', unmapped_base;
  END IF;
END;
$$;

-- DropForeignKey
ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_operatingSystemId_fkey";
ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_currentRescueOperatingSystemId_fkey";

-- AlterTable: drop the legacy OS FK columns from Deployment
ALTER TABLE "Deployment" DROP COLUMN "operatingSystemId";
ALTER TABLE "Deployment" DROP COLUMN "currentRescueOperatingSystemId";

-- DropTable: the per-server installable-OS join (its FKs drop with it)
DROP TABLE "ServerOperatingSystem";

-- DropTable: the OS catalog (now unreferenced)
DROP TABLE "OperatingSystem";

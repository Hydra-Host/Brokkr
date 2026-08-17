-- Onboarding dedup is enforced in the DB, not the app: a role=null Device IS the onboarding record,
-- named by its (lowercased, separator-stripped) BMC MAC. A partial composite unique over active rows
-- makes a duplicate onboard fail at insert (P2002), closing the scan->onboard-twice and concurrent
-- double-submit races the prior SELECT-based check couldn't. Scoped to (organizationId, zoneId)
-- because management MACs aren't globally unique; NOT role-filtered, so an already-onboarded device
-- (now role=Server, still active) also blocks re-onboarding its BMC until it's cancelled/soft-deleted.
-- Mirrors the systemUuid (20260625150000) and interface (20260626120000) partial-unique indexes;
-- Prisma can't model partial indexes, so this raw index owns the constraint (name stays non-@unique).
-- If existing active rows already share (organizationId, zoneId, name), index creation fails loudly —
-- resolve the duplicates before deploying.

-- CreateIndex
CREATE UNIQUE INDEX "Device_active_onboarding_name_unique"
  ON "Device"("organizationId", "zoneId", "name")
  WHERE "deletedAt" IS NULL;

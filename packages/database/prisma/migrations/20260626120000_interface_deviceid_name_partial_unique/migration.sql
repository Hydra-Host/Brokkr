-- Interface (deviceId, name) uniqueness must respect soft-delete: deprecate soft-deletes a device's
-- interfaces (deletedAt set), so the plain global unique blocked re-onboarding the same box —
-- discovery's interface upsert keyed on (deviceId, name) matched the tombstoned row instead of
-- creating a fresh live one. Replace the Prisma-managed global unique with a PARTIAL unique index
-- scoped to active rows, mirroring the systemUuid (20260625150000) and IPAM (20260306040000)
-- soft-delete partial indexes. Prisma can't model partial indexes, so `@@unique([deviceId, name])`
-- drops from the schema and this raw index owns the constraint — uniqueness holds only among live
-- interfaces; any number of tombstones may share a freed (deviceId, name).

-- DropIndex
DROP INDEX IF EXISTS "Interface_deviceId_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "Interface_active_deviceId_name_unique"
  ON "Interface"("deviceId", "name")
  WHERE "deletedAt" IS NULL;

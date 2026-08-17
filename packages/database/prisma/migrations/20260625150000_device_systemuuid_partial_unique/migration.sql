-- systemUuid uniqueness must respect soft-delete: a tombstoned Device (deletedAt set) keeps its
-- SMBIOS UUID, so the plain global unique index blocked re-onboarding the same physical box
-- (discovery's ghw_product handler writes Device.systemUuid → unique-constraint COMMIT_FAILED).
-- Replace the Prisma-managed global unique with a PARTIAL unique index scoped to active rows,
-- mirroring the IPAM soft-delete partial indexes (20260306040000). Prisma can't model partial
-- indexes, so `Device.systemUuid` drops its `@unique` in the schema and this raw index owns the
-- constraint — uniqueness is enforced only among live devices; any number of tombstones may share
-- a freed UUID (NULLs are excluded from unique indexes either way).

-- DropIndex
DROP INDEX IF EXISTS "Device_systemUuid_key";

-- CreateIndex
CREATE UNIQUE INDEX "Device_active_systemUuid_unique"
  ON "Device"("systemUuid")
  WHERE "deletedAt" IS NULL;

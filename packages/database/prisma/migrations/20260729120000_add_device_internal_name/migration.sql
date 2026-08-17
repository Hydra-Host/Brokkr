-- Device.internalName: admin-only free-form label, unique among live rows when set.
-- Nullable so adding the column to a populated table needs no default, and so
-- "cleared" labels don't collide (Postgres NULL ≠ under unique indexes).
ALTER TABLE "Device" ADD COLUMN "internalName" TEXT;

-- Case-insensitive uniqueness among live rows only — mirrors Device_active_systemUuid_unique
-- (20260625150000). A plain @unique would span tombstones and block reusing a deprecated
-- label; a byte-level unique would allow concurrent case-variant races past the app pre-check.
-- Prisma can't express expression/partial indexes, so this raw index owns the constraint.
CREATE UNIQUE INDEX "Device_active_internalName_ci_unique"
  ON "Device"(LOWER("internalName"))
  WHERE "deletedAt" IS NULL;

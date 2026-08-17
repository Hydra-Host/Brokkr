-- Zone.uuidSuffix: last 5 hex chars of id, @unique so per-zone device names are
-- globally unique. Zone.internalName: admin-only free-form label. Both nullable
-- so adding them to a populated table needs no default.
ALTER TABLE "Zone" ADD COLUMN "uuidSuffix" TEXT;
ALTER TABLE "Zone" ADD COLUMN "internalName" TEXT;

-- Backfill uuidSuffix only for rows whose last-5 is already unique across the
-- table (soft-deleted rows included — their suffix stays reserved). Any
-- pre-existing collider rows are left NULL so CREATE UNIQUE INDEX cannot abort
-- (Postgres treats multiple NULLs as distinct under a unique index).
UPDATE "Zone" z
SET "uuidSuffix" = RIGHT(z."id"::text, 5)
WHERE NOT EXISTS (
  SELECT 1 FROM "Zone" o
  WHERE o."id" <> z."id"
    AND RIGHT(o."id"::text, 5) = RIGHT(z."id"::text, 5)
);

-- Index name matches Prisma's field-level @unique convention so migrate diff reports no drift.
CREATE UNIQUE INDEX "Zone_uuidSuffix_key" ON "Zone"("uuidSuffix");

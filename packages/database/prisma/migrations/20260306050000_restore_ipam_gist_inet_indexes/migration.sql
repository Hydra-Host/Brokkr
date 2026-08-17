-- Restore GiST indexes for IPAM containment lookups.
-- These are partial indexes on active (non-deleted) rows, mirroring prior behavior.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Prefix_active_gist_idx"
  ON "Prefix"
  USING GIST ("prefix" inet_ops)
  WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IpAddress_active_gist_idx"
  ON "IpAddress"
  USING GIST ("address" inet_ops)
  WHERE "deletedAt" IS NULL;

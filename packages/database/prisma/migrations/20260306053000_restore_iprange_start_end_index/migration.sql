-- Restore the IpRange bound-comparison index removed during migration consolidation.
-- This supports overlap detection predicates that compare against both start and end.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IpRange_start_end_idx"
  ON "IpRange"("start", "end");

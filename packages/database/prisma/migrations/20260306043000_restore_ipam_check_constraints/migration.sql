-- Restore IPAM CHECK constraints that were present before migration squashing.
-- These constraints prevent invalid VLAN IDs and inverted IP range bounds.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Vlan_vid_range_check'
  ) THEN
    ALTER TABLE "Vlan"
    ADD CONSTRAINT "Vlan_vid_range_check"
    CHECK ("vid" BETWEEN 2 AND 4094);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'IpRange_bounds_check'
  ) THEN
    ALTER TABLE "IpRange"
    ADD CONSTRAINT "IpRange_bounds_check"
    CHECK ("start" <= "end");
  END IF;
END
$$;

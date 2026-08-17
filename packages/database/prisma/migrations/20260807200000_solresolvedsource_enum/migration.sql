CREATE TYPE "SolResolvedSource" AS ENUM ('probed', 'modem_hint', 'vendor_table', 'none');

-- Guarded cast: any value outside the enum domain becomes NULL instead of
-- aborting the migration at deploy time. Consumers treat NULL provenance as
-- "no resolved answer" and fall back to the heuristic columns.
ALTER TABLE "DeviceSolConfig"
  ALTER COLUMN "resolvedSource" TYPE "SolResolvedSource"
  USING (
    CASE
      WHEN "resolvedSource" IN ('probed', 'modem_hint', 'vendor_table', 'none')
        THEN "resolvedSource"::"SolResolvedSource"
      ELSE NULL
    END
  );

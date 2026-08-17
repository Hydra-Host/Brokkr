-- Null out zero sentinels before enforcing positive-only API semantics.
UPDATE "Circuit" SET "commitRate" = NULL WHERE "commitRate" = 0;
UPDATE "CircuitTermination" SET "portSpeed" = NULL WHERE "portSpeed" = 0;
UPDATE "CircuitTermination" SET "upstreamSpeed" = NULL WHERE "upstreamSpeed" = 0;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "Circuit" GROUP BY "cid" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration blocked: duplicate Circuit.cid values found. Identify and resolve all duplicates before re-running this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX "Circuit_cid_key" ON "Circuit"("cid");

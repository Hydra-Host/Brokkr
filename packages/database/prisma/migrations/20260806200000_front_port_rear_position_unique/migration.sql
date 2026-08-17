DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "FrontPort" GROUP BY "rearPortId", "rearPortPosition" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration blocked: duplicate FrontPort (rearPortId, rearPortPosition) values found. Resolve duplicates before re-running this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX "FrontPort_rearPortId_rearPortPosition_key" ON "FrontPort"("rearPortId", "rearPortPosition");

-- Live interfaces on one device sharing a MAC give netplan duplicate `ethernets` entries that rename
-- the NIC twice at boot. Same partial-index pattern as the active (deviceId, name) uniqueness.

-- Abort with the offending rows named, so the operator can fix them before re-running: the bare
-- CREATE UNIQUE INDEX would fail on the first collision without saying which interfaces collide.
DO $$
DECLARE
  report text;
BEGIN
  SELECT string_agg(format('device %s mac %s: %s', "deviceId", mac, names), '; ' ORDER BY "deviceId", mac)
  INTO report
  FROM (
    SELECT "deviceId", lower("macAddress") AS mac, string_agg(name, ', ' ORDER BY name) AS names
    FROM "Interface"
    WHERE "deletedAt" IS NULL AND "macAddress" IS NOT NULL
    GROUP BY "deviceId", lower("macAddress")
    HAVING count(*) > 1
  ) duplicates;

  IF report IS NOT NULL THEN
    RAISE EXCEPTION
      'Interface MAC unique index aborted: live interfaces on one device share a MAC — %', report;
  END IF;
END $$;

CREATE UNIQUE INDEX "Interface_active_deviceId_macAddress_unique"
  ON "Interface" USING btree ("deviceId", lower("macAddress"))
  WHERE "deletedAt" IS NULL AND "macAddress" IS NOT NULL;

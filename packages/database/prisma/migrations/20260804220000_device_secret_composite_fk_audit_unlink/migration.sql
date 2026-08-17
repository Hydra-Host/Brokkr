-- Device-secret custody hardening, in parity with the brokkr-app port (brokkr-app!1638).

-- Guard: fail loudly (listing rows) if any existing secret's zoneId disagrees with its
-- device's zone — the composite FK below cannot land on inconsistent data.
DO $$
DECLARE
  bad_rows TEXT;
BEGIN
  SELECT string_agg(format('%s (secret zone %s, device zone %s)', s.id, s."zoneId", COALESCE(d."zoneId", 'NULL')), ', ')
  INTO bad_rows
  FROM "DeviceSecret" s
  JOIN "Device" d ON d.id = s."deviceId"
  WHERE d."zoneId" IS DISTINCT FROM s."zoneId";

  IF bad_rows IS NOT NULL THEN
    RAISE EXCEPTION 'DeviceSecret rows whose zoneId does not match their device''s zone: %', bad_rows;
  END IF;
END
$$;

-- Unique pair backing the composite FK.
CREATE UNIQUE INDEX "Device_id_zoneId_key" ON "Device"("id", "zoneId");

-- A secret's (deviceId, zoneId) must match the device row. ON UPDATE RESTRICT blocks
-- rezoning a device that still has DeviceSecret rows — delete them first, invalidation is not enough.
ALTER TABLE "DeviceSecret" DROP CONSTRAINT "DeviceSecret_deviceId_fkey";
ALTER TABLE "DeviceSecret" DROP CONSTRAINT "DeviceSecret_zoneId_fkey";
ALTER TABLE "DeviceSecret" ADD CONSTRAINT "DeviceSecret_deviceId_zoneId_fkey"
  FOREIGN KEY ("deviceId", "zoneId") REFERENCES "Device"("id", "zoneId")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- Audit history survives device hard-deletion.
ALTER TABLE "DeviceSecretAuditEvent" DROP CONSTRAINT "DeviceSecretAuditEvent_deviceId_fkey";

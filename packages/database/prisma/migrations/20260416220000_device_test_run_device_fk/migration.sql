-- Split `DeviceTestRun.deviceId` into two typed relations so test runs can
-- be navigated from either side of the legacy/new device split:
--
--   * `deviceMetadataId` (Int?,  FK -> `DeviceMetadata.id`) ← renamed from
--                                                              `deviceId`,
--                                                              now nullable
--   * `deviceId`         (String, FK -> `Device.id`)         ← new, NOT NULL
--
-- The new UUID pointer is the source of truth going forward. The legacy
-- NetBox-int pointer is preserved for back-compat reads of historical rows
-- but is now optional, so devices created without a NetBox mirror can
-- still record test runs. A follow-up migration drops it once those reads
-- are gone.

-- 1. Rename the existing NetBox-integer pointer to its honest name.
ALTER TABLE "DeviceTestRun" RENAME COLUMN "deviceId" TO "deviceMetadataId";
ALTER TABLE "DeviceTestRun" RENAME CONSTRAINT "DeviceTestRun_deviceId_fkey" TO "DeviceTestRun_deviceMetadataId_fkey";
ALTER INDEX "DeviceTestRun_deviceId_idx" RENAME TO "DeviceTestRun_deviceMetadataId_idx";

-- 2. Relax the legacy NetBox-int pointer so new devices that lack a
--    NetBox mirror can still record test runs.
ALTER TABLE "DeviceTestRun" ALTER COLUMN "deviceMetadataId" DROP NOT NULL;

-- 3. Add the new UUID pointer alongside it.
ALTER TABLE "DeviceTestRun" ADD COLUMN "deviceId" TEXT;

-- 4. Backfill by joining through `Device.netboxId` which was populated from
--    `DeviceMetadata.id` during the preceding `netbox_port` migration.
UPDATE "DeviceTestRun" dtr
SET "deviceId" = d."id"
FROM "Device" d
WHERE d."netboxId" = dtr."deviceMetadataId";

-- 5. Integrity check — every existing row must resolve before we lock in
--    the NOT NULL constraint on the new column. Fails loudly if any test
--    run references a NetBox id that doesn't have a matching new Device
--    (which would indicate the UUID-preserving backfill ran with partial
--    data).
DO $$
DECLARE
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO orphan_count FROM "DeviceTestRun" WHERE "deviceId" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'DeviceTestRun backfill incomplete: % rows have no matching Device via netboxId. Fix the upstream netbox_port backfill before retrying.',
      orphan_count;
  END IF;
END $$;

-- 6. Lock the new column down and wire the FK + index.
ALTER TABLE "DeviceTestRun" ALTER COLUMN "deviceId" SET NOT NULL;
CREATE INDEX "DeviceTestRun_deviceId_idx" ON "DeviceTestRun"("deviceId");
ALTER TABLE "DeviceTestRun"
  ADD CONSTRAINT "DeviceTestRun_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

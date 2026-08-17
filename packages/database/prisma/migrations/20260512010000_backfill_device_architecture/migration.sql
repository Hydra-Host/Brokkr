-- Backfills `Device.architecture` from `DeviceMetadata.arch` for rows that
-- never made it through discovery.
--
-- Discovery's ArchitectureHandler writes the raw `uname -m` value
-- (x86_64 / aarch64). For pre-discovery rows we copy the Debian-style value
-- DeviceMetadata holds (amd64 / arm64). The column ends up mixed-source but
-- `normalizeArchForArtifact` in @repo/utils accepts both spellings before
-- joining LayerArtifact.arch, so downstream callers don't care.
--
-- Join is `DeviceMetadata.id = Device.netboxId` because DeviceMetadata.id is
-- the legacy NetBox identifier (same value space as Device.netboxId).
--
-- Only backfills rows whose architecture is currently NULL — discovery-written
-- values stay intact.
UPDATE "Device" d
SET "architecture" = dm."arch"
FROM "DeviceMetadata" dm
WHERE dm."id" = d."netboxId"
  AND dm."arch" IS NOT NULL
  AND d."architecture" IS NULL;

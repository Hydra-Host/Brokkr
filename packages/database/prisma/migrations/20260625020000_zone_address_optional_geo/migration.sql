-- Zone addresses can be entered manually (no Radar geocoding key), so the
-- geocoded display/coordinate fields are no longer required. Region auto-assignment
-- reads latitude/longitude best-effort and skips a coordinate-less zone.
ALTER TABLE "ZoneAddress" ALTER COLUMN "country" DROP NOT NULL;
ALTER TABLE "ZoneAddress" ALTER COLUMN "latitude" DROP NOT NULL;
ALTER TABLE "ZoneAddress" ALTER COLUMN "longitude" DROP NOT NULL;

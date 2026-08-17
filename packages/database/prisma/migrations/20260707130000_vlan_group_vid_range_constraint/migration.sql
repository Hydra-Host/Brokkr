-- Align VlanGroup.minVid/maxVid with the valid VLAN VID range (2-4094) and
-- guarantee a sane span. VID 1 is the reserved default VLAN, so the group floor
-- is 2 (matches VLAN_VID_MIN and the existing Vlan_vid_range_check on Vlan.vid).
--
-- Existing rows were created with the old minVid default of 1; clamp any
-- out-of-range or inverted values before adding the CHECK so it applies cleanly.
UPDATE "VlanGroup" SET "minVid" = GREATEST(2, LEAST("minVid", 4094));
UPDATE "VlanGroup" SET "maxVid" = GREATEST(2, LEAST("maxVid", 4094));
-- reversed bounds are a column mix-up; swap them to preserve the intended span
UPDATE "VlanGroup"
  SET "minVid" = LEAST("minVid", "maxVid"),
      "maxVid" = GREATEST("minVid", "maxVid")
  WHERE "maxVid" < "minVid";

ALTER TABLE "VlanGroup" ALTER COLUMN "minVid" SET DEFAULT 2;

ALTER TABLE "VlanGroup"
  ADD CONSTRAINT "VlanGroup_vid_range_check"
  CHECK ("minVid" BETWEEN 2 AND 4094 AND "maxVid" BETWEEN 2 AND 4094 AND "minVid" <= "maxVid");

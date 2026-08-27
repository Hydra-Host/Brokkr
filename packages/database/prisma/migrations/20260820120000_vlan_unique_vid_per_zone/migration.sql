-- A VLAN id is only unique on the fabric it lives on, so key the active-row
-- constraint on (zone, vid) alone — not organization or VRF. Zone-less rows
-- are unconstrained: the partial index excludes NULL zoneId so those VLANs
-- have no uniqueness protection.
--
-- VLAN names carry no uniqueness at all now; drop that index outright.
-- The previous org+VRF unique-vid index is replaced below.

DROP INDEX "Vlan_active_unique_name";

DROP INDEX "Vlan_active_unique_vid";

CREATE UNIQUE INDEX "Vlan_active_unique_vid"
  ON "Vlan"("zoneId", "vid")
  WHERE "deletedAt" IS NULL AND "zoneId" IS NOT NULL;

-- AddConstraint: a DHCP-serving prefix must satisfy the FULL derivation-eligibility invariant —
-- zone-scoped (the config atom is published per zone), non-NAT role, and IPv4 (derivation is
-- IPv4-only). A prefix violating any of these derives to 'disabled' and silently never serves.
-- The API keeps a friendly pre-check in updateDhcpConfig, but that read-before-write can race a
-- concurrent updatePrefix that clears the zone or flips the role; this constraint enforces the
-- invariant atomically at the DB level under the row lock the write already holds (fail-closed —
-- it also defends direct SQL and any future writer that skips the guard). NULL role stays eligible
-- (only NAT is excluded), matching the API rule — hence IS DISTINCT FROM, not <>.
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dhcp_requires_zone_check"
  CHECK (
    "dhcpMode" IS NULL
    OR "dhcpMode" = 'OFF'
    OR ("zoneId" IS NOT NULL AND "role" IS DISTINCT FROM 'NAT' AND family("prefix") = 4)
  );

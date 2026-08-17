-- Adds the fields the netplan generator needs to render without calling NetBox.
-- All three columns mirror NetBox custom_fields the Jinja template reads.

-- Device.netplanOverride — operator-supplied raw netplan YAML; passthrough.
ALTER TABLE "Device" ADD COLUMN "netplanOverride" TEXT;

-- Prefix.enableVlanTag — controls VLAN tagging independent of device role.
ALTER TABLE "Prefix" ADD COLUMN "enableVlanTag" BOOLEAN NOT NULL DEFAULT false;

-- Prefix.prefixRoleId — FK to IpamPrefixVlanRole. The legacy enum
-- Prefix.role stays in place for non-netplan callers; new code reads
-- through this relation so we can carry NetBox role slugs verbatim.
ALTER TABLE "Prefix" ADD COLUMN "prefixRoleId" TEXT;

ALTER TABLE "Prefix"
  ADD CONSTRAINT "Prefix_prefixRoleId_fkey"
  FOREIGN KEY ("prefixRoleId") REFERENCES "IpamPrefixVlanRole"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Prefix_prefixRoleId_idx" ON "Prefix"("prefixRoleId");

-- IpAddress.routingPrefix — CIDR this IP routes traffic toward; combined
-- with the l3-route-not-needed tag on sibling IPs to add static routes.
ALTER TABLE "IpAddress" ADD COLUMN "routingPrefix" cidr;

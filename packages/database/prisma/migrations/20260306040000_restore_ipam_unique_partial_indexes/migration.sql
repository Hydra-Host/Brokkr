-- Restore critical partial unique indexes for IPAM soft-delete semantics.
-- These enforce uniqueness only for active (non-deleted) rows.

-- CreateIndex
CREATE UNIQUE INDEX "Vrf_active_name_organization_unique"
  ON "Vrf"("organizationId", lower("name"))
  WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Vrf_active_rd_organization_unique"
  ON "Vrf"("organizationId", "rd")
  WHERE "deletedAt" IS NULL AND "rd" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Prefix_active_unique"
  ON "Prefix"(
    "organizationId",
    COALESCE("vrfId", '00000000-0000-0000-0000-000000000000'),
    "prefix"
  )
  WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "IpAddress_active_unique"
  ON "IpAddress"(
    "organizationId",
    COALESCE("vrfId", '00000000-0000-0000-0000-000000000000'),
    "address"
  )
  WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Vlan_active_unique_vid"
  ON "Vlan"(
    "organizationId",
    COALESCE("vrfId", '00000000-0000-0000-0000-000000000000'),
    "vid"
  )
  WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Vlan_active_unique_name"
  ON "Vlan"(
    "organizationId",
    COALESCE("vrfId", '00000000-0000-0000-0000-000000000000'),
    lower("name")
  )
  WHERE "deletedAt" IS NULL;

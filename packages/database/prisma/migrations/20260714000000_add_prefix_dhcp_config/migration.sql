-- CreateEnum
CREATE TYPE "DhcpMode" AS ENUM ('AUTHORITATIVE', 'PROXY', 'OFF');

-- CreateEnum
CREATE TYPE "IpxeBuildTarget" AS ENUM ('IPXE', 'SNP', 'SNPONLY');

-- AlterTable: add DHCP columns to Prefix
ALTER TABLE "Prefix" ADD COLUMN "dhcpMode" "DhcpMode",
ADD COLUMN "dhcpLeaseTtlSeconds" INTEGER,
ADD COLUMN "dhcpOptions" JSONB,
ADD COLUMN "dhcpNextServer" TEXT,
ADD COLUMN "dhcpDnsServers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "ipxeBuildTarget" "IpxeBuildTarget";

-- AlterTable: add per-device PXE boot firmware override
ALTER TABLE "Device" ADD COLUMN "ipxeBuildTarget" "IpxeBuildTarget";

-- AddConstraint: enforce minimum lease TTL at the DB level (API already validates >= 120)
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dhcpLeaseTtlSeconds_check" CHECK ("dhcpLeaseTtlSeconds" IS NULL OR "dhcpLeaseTtlSeconds" >= 120);

-- CreateIndex
-- Partial index: only DHCP-enabled prefixes (a small fraction of all rows) are
-- indexed, so the planner keeps using it for the `dhcpMode IS NOT NULL` filter in
-- DhcpDerivationService instead of falling back to a seq-scan once the majority-NULL
-- rows dominate a full index. Prisma can't express a WHERE on @@index, so this index
-- lives in raw migration SQL only (intentionally absent from the Prisma schema).
CREATE INDEX "Prefix_dhcpMode_idx" ON "Prefix"("dhcpMode") WHERE "dhcpMode" IS NOT NULL;

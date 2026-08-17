-- AlterTable: drop hub-side DHCP next-server and DNS overrides (bridge self-derives both).
-- Plain DROP COLUMN (Prisma convention): the columns are created by 20260714000000_add_prefix_dhcp*,
-- so they always exist here; omitting IF EXISTS lets a missing column fail loud (surfacing drift)
-- rather than silently no-op.
ALTER TABLE "Prefix" DROP COLUMN "dhcpNextServer";
ALTER TABLE "Prefix" DROP COLUMN "dhcpDnsServers";

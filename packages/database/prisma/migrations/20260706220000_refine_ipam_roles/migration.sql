-- Refine IpamRole to the 6 supported roles.
-- Add ALLOCATION, COMMON, LOOPBACK; drop PRODUCTION, STORAGE, CUSTOMER, IPMI; keep MANAGEMENT, NAT, PRIMARY.
-- Postgres cannot DROP values from an enum in place, so recreate the type. Both columns that use it
-- (Prefix.role, Vlan.role) are nullable with no default. PRODUCTION is the former name of PRIMARY, so
-- its rows remap to PRIMARY (already present in the enum — added by add_nat_primary_ipam_roles, which
-- runs before this migration); STORAGE/CUSTOMER/IPMI have no successor, so those rows null out. All this
-- runs before the cast — the surviving values (MANAGEMENT, NAT, PRIMARY) exist in the new type.

UPDATE "Prefix" SET "role" = 'PRIMARY' WHERE "role" = 'PRODUCTION';
UPDATE "Vlan"   SET "role" = 'PRIMARY' WHERE "role" = 'PRODUCTION';
UPDATE "Prefix" SET "role" = NULL WHERE "role" IN ('STORAGE', 'CUSTOMER', 'IPMI');
UPDATE "Vlan"   SET "role" = NULL WHERE "role" IN ('STORAGE', 'CUSTOMER', 'IPMI');

ALTER TYPE "IpamRole" RENAME TO "IpamRole_old";
CREATE TYPE "IpamRole" AS ENUM ('ALLOCATION', 'COMMON', 'LOOPBACK', 'MANAGEMENT', 'NAT', 'PRIMARY');
ALTER TABLE "Prefix" ALTER COLUMN "role" TYPE "IpamRole" USING ("role"::text::"IpamRole");
ALTER TABLE "Vlan"   ALTER COLUMN "role" TYPE "IpamRole" USING ("role"::text::"IpamRole");
DROP TYPE "IpamRole_old";

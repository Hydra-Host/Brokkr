-- AlterEnum
-- Adds NAT and PRIMARY to the IpamRole prefix-role enum. IF NOT EXISTS keeps the migration
-- idempotent (safe to re-apply). Both are appended, matching the schema enum order.
ALTER TYPE "IpamRole" ADD VALUE IF NOT EXISTS 'NAT';
ALTER TYPE "IpamRole" ADD VALUE IF NOT EXISTS 'PRIMARY';

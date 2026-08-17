-- Drop the unused Kea DHCP subnet id column. The Kea integration was never
-- ported (no reader/writer code), so this column is dead. Deprecation cleanup.
ALTER TABLE "Prefix" DROP COLUMN "keaSubnetId";

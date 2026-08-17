-- Exception pin for the netplan render family. Null (the default for every
-- existing row) means "derive from role + zone", so this is behaviour-neutral
-- on deploy.
CREATE TYPE "NetplanPopulation" AS ENUM ('FLAT', 'VPC', 'VPC_ROCE', 'BRIDGE_DEFAULT', 'BRIDGE_BONDED', 'BRIDGE_SANS_VRF');

ALTER TABLE "Device" ADD COLUMN "netplanPopulation" "NetplanPopulation";

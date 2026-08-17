-- Adds Zone.eastWestNetworkType, replacing NetBox location
-- `custom_fields.east_west_network_type` that the deploy netplan template
-- reads to decide east-west interface inclusion (RoCE).

CREATE TYPE "ZoneEastWestNetworkType" AS ENUM ('ROCE', 'ETHERNET');

ALTER TABLE "Zone" ADD COLUMN "eastWestNetworkType" "ZoneEastWestNetworkType";

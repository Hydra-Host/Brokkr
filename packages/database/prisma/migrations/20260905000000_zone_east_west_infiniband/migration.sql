-- Standalone by necessity: Postgres refuses to use a new enum value in the transaction that adds
-- it, so any migration writing INFINIBAND rows must come after this one.
ALTER TYPE "ZoneEastWestNetworkType" ADD VALUE IF NOT EXISTS 'INFINIBAND' AFTER 'ETHERNET';

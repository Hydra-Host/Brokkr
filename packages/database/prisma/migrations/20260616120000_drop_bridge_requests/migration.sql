-- Bridge requests (the admin workflow to provision/add bridges) are removed.
-- Drops the table and its status enum type. The Bridge device model and the
-- read-only bridges API are intentionally retained.
DROP TABLE IF EXISTS "BridgeRequest";
DROP TYPE IF EXISTS "BridgeRequestStatus";

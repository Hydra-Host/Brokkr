-- Drop the dead `monitored` boolean column from Server and Device.
-- Companion of monitorPsk (dropped in the prior migration). Its consumer was
-- removed on 2026-04-15 (commit 9807d4352) and it was re-introduced by later
-- schema work without a consumer. No data cleanup needed (non-secret, undeployed).
ALTER TABLE "Server" DROP COLUMN IF EXISTS "monitored";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "monitored";

-- Reshape BridgeHeartbeat from saga-based heartbeat payload to per-instance
-- Redis registration data. The old table was never written to (heartbeat saga
-- was never dispatched after the bridge/device health check decoupling).
-- Safe to drop and recreate with no data loss.

-- Drop old indexes
DROP INDEX IF EXISTS "BridgeHeartbeat_tenantId_siteId_locationId_receivedAt_idx";
DROP INDEX IF EXISTS "BridgeHeartbeat_tenantId_siteId_locationId_startTime_idx";
DROP INDEX IF EXISTS "BridgeHeartbeat_receivedAt_idx";

-- Drop and recreate table
DROP TABLE "BridgeHeartbeat";

CREATE TABLE "BridgeHeartbeat" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "isLeader" BOOLEAN NOT NULL,
    "netbirdIp" TEXT NOT NULL,
    "brokkrWorkerVersion" TEXT NOT NULL,
    "brokkrLiveVersion" TEXT NOT NULL,
    "osImageVersion" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BridgeHeartbeat_pkey" PRIMARY KEY ("id")
);

-- Foreign key to Zone
ALTER TABLE "BridgeHeartbeat" ADD CONSTRAINT "BridgeHeartbeat_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "BridgeHeartbeat_zoneId_receivedAt_idx" ON "BridgeHeartbeat"("zoneId", "receivedAt" DESC);
CREATE INDEX "BridgeHeartbeat_instanceId_receivedAt_idx" ON "BridgeHeartbeat"("instanceId", "receivedAt" DESC);
CREATE INDEX "BridgeHeartbeat_receivedAt_idx" ON "BridgeHeartbeat"("receivedAt");

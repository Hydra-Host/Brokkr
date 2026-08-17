-- CreateTable
CREATE TABLE "BridgeHeartbeat" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "bridgeVersion" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BridgeHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceHealthCheck" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "heartbeatId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "primaryReachable" BOOLEAN,
    "bmcIcmpReachable" BOOLEAN,
    "bmcIpmiReachable" BOOLEAN,
    "bmcRedfishReachable" BOOLEAN,
    "bmcCredsValid" BOOLEAN,
    "poweredOn" BOOLEAN,
    "brokkrLiveRunning" BOOLEAN,
    "testedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneStatus" (
    "id" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT true,
    "lastOfflineAt" TIMESTAMP(3),
    "lastOnlineAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "ticketId" TEXT,
    "alertSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BridgeHeartbeat_jobId_key" ON "BridgeHeartbeat"("jobId");

-- CreateIndex
CREATE INDEX "BridgeHeartbeat_zone_receivedAt_idx" ON "BridgeHeartbeat"("zone", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "BridgeHeartbeat_zone_startTime_idx" ON "BridgeHeartbeat"("zone", "startTime");

-- CreateIndex
CREATE INDEX "BridgeHeartbeat_receivedAt_idx" ON "BridgeHeartbeat"("receivedAt");

-- CreateIndex
CREATE INDEX "DeviceHealthCheck_deviceId_testedAt_idx" ON "DeviceHealthCheck"("deviceId", "testedAt" DESC);

-- CreateIndex
CREATE INDEX "DeviceHealthCheck_heartbeatId_idx" ON "DeviceHealthCheck"("heartbeatId");

-- CreateIndex
CREATE INDEX "DeviceHealthCheck_jobId_idx" ON "DeviceHealthCheck"("jobId");

-- CreateIndex
CREATE INDEX "DeviceHealthCheck_deviceId_primaryReachable_idx" ON "DeviceHealthCheck"("deviceId", "primaryReachable");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceHealthCheck_heartbeatId_deviceId_key" ON "DeviceHealthCheck"("heartbeatId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneStatus_zone_key" ON "ZoneStatus"("zone");

-- CreateIndex
CREATE INDEX "ZoneStatus_zone_isOnline_idx" ON "ZoneStatus"("zone", "isOnline");

-- CreateIndex
CREATE INDEX "ZoneStatus_lastHeartbeatAt_idx" ON "ZoneStatus"("lastHeartbeatAt");

-- AddForeignKey
ALTER TABLE "DeviceHealthCheck" ADD CONSTRAINT "DeviceHealthCheck_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceHealthCheck" ADD CONSTRAINT "DeviceHealthCheck_heartbeatId_fkey" FOREIGN KEY ("heartbeatId") REFERENCES "BridgeHeartbeat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

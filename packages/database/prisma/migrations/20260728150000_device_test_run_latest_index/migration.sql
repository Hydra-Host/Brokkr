CREATE INDEX "DeviceTestRun_type_status_deviceId_endTime_idx"
ON "DeviceTestRun"("type", "status", "deviceId", "endTime" DESC);

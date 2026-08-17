-- CreateTable
CREATE TABLE "sanitization_reports" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sanitization_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sanitization_reports_deviceId_jobId_key" ON "sanitization_reports"("deviceId", "jobId");

-- CreateIndex
CREATE INDEX "sanitization_reports_jobId_idx" ON "sanitization_reports"("jobId");

-- CreateIndex
CREATE INDEX "sanitization_reports_actionType_idx" ON "sanitization_reports"("actionType");

-- AddForeignKey
ALTER TABLE "sanitization_reports" ADD CONSTRAINT "sanitization_reports_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "DeviceTestStatus" AS ENUM ('Completed', 'Running');

-- CreateEnum
CREATE TYPE "DeviceTestType" AS ENUM ('GpuBurnIn', 'NcclPerformance');

-- CreateTable
CREATE TABLE "DeviceTestRun" (
    "id" TEXT NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "type" "DeviceTestType" NOT NULL,
    "status" "DeviceTestStatus" NOT NULL DEFAULT 'Running',
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "testPassed" BOOLEAN,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceTestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceTestRun_deviceId_idx" ON "DeviceTestRun"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceTestRun_type_idx" ON "DeviceTestRun"("type");

-- CreateIndex
CREATE INDEX "DeviceTestRun_status_idx" ON "DeviceTestRun"("status");

-- AddForeignKey
ALTER TABLE "DeviceTestRun" ADD CONSTRAINT "DeviceTestRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DeviceMetadata"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

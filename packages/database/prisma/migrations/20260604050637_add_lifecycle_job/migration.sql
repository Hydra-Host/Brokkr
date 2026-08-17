-- CreateEnum
CREATE TYPE "LifecycleJobPhase" AS ENUM ('REQUESTED', 'AUTHORIZING', 'SCHEDULED', 'DISPATCHED', 'RUNNING', 'AWAITING_PHONE_HOME', 'COMPLETED', 'FAILED', 'ABORTED');

-- CreateTable
CREATE TABLE "LifecycleJob" (
    "id" TEXT NOT NULL,
    "jobType" "JobType" NOT NULL,
    "phase" "LifecycleJobPhase" NOT NULL DEFAULT 'REQUESTED',
    "payload" JSONB NOT NULL,
    "deviceId" TEXT,
    "deploymentId" TEXT,
    "organizationId" TEXT,
    "source" "RequestSource" NOT NULL,
    "performedBy" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "phoneHomeDeadline" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifecycleJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sagaName" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LifecycleJob_phase_idx" ON "LifecycleJob"("phase");

-- CreateIndex
CREATE INDEX "LifecycleJob_deviceId_createdAt_idx" ON "LifecycleJob"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "LifecycleJob_deploymentId_idx" ON "LifecycleJob"("deploymentId");

-- CreateIndex
CREATE INDEX "LifecycleJobEvent_jobId_recordedAt_idx" ON "LifecycleJobEvent"("jobId", "recordedAt");

-- CreateIndex
CREATE INDEX "LifecycleJobEvent_jobId_sagaName_idx" ON "LifecycleJobEvent"("jobId", "sagaName");

-- AddForeignKey
ALTER TABLE "LifecycleJob" ADD CONSTRAINT "LifecycleJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleJob" ADD CONSTRAINT "LifecycleJob_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleJobEvent" ADD CONSTRAINT "LifecycleJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "LifecycleJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

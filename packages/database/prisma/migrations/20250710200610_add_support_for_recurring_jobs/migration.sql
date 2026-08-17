-- CreateEnum
CREATE TYPE "ScheduledJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB,
    "scheduledAt" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "status" "ScheduledJobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "queue" VARCHAR(100) NOT NULL DEFAULT 'default',
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "cronExpression" VARCHAR(255),
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMPTZ,
    "lockExpiresAt" TIMESTAMPTZ,
    "startedAt" TIMESTAMPTZ,
    "completedAt" TIMESTAMPTZ,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ,
    "retryDelay" INTEGER NOT NULL DEFAULT 60,
    "exponentialBackoff" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_scheduled_jobs_scheduled_status" ON "ScheduledJob"("scheduledAt", "status");

-- CreateIndex
CREATE INDEX "idx_scheduled_jobs_queue_priority" ON "ScheduledJob"("queue", "priority", "scheduledAt");

-- CreateIndex
CREATE INDEX "idx_scheduled_jobs_locked_by" ON "ScheduledJob"("lockedBy");

-- CreateIndex
CREATE INDEX "idx_scheduled_jobs_lock_expires" ON "ScheduledJob"("lockExpiresAt");

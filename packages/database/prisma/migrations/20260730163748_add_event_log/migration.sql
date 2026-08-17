-- CreateEnum
CREATE TYPE "EventOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'DENIED');

-- CreateEnum
CREATE TYPE "EventTier" AS ENUM ('EVIDENCE', 'ACTIVITY');

-- CreateEnum
CREATE TYPE "EventDurability" AS ENUM ('ATOMIC', 'POST_COMMIT', 'BEST_EFFORT');

-- AlterEnum
ALTER TYPE "RequestSource" ADD VALUE 'SYSTEM';

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" "EventTier" NOT NULL,
    "durability" "EventDurability" NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "actorType" "RequestSource" NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "apiKeyId" TEXT,
    "apiKeyLabel" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "outcome" "EventOutcome" NOT NULL,
    "errorCode" TEXT,
    "requestId" TEXT,
    "method" TEXT,
    "path" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLogAccessBucket" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "hourBucket" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLogAccessBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventLog_org_createdAt_id_desc_idx" ON "EventLog"("organizationId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "EventLog_org_createdAt_id_asc_idx" ON "EventLog"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "EventLog_organizationId_actorId_createdAt_id_idx" ON "EventLog"("organizationId", "actorId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "EventLog_organizationId_actionKey_createdAt_id_idx" ON "EventLog"("organizationId", "actionKey", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "EventLog_organizationId_resource_targetId_createdAt_id_idx" ON "EventLog"("organizationId", "resource", "targetId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EventLogAccessBucket_organizationId_actorKey_hourBucket_key" ON "EventLogAccessBucket"("organizationId", "actorKey", "hourBucket");

-- The unique index above is the access throttle, but it only throttles if every write truncates
-- hourBucket to the hour. TIMESTAMP(3) would otherwise accept millisecond-precision values and
-- silently admit one row per distinct instant. Enforce the invariant in the database, not just the caller.
ALTER TABLE "EventLogAccessBucket"
  ADD CONSTRAINT "EventLogAccessBucket_hourBucket_aligned"
  CHECK ("hourBucket" = date_trunc('hour', "hourBucket"));

-- AlterEnum
ALTER TYPE "RequestSource" ADD VALUE 'DEVICE';

-- CreateEnum
CREATE TYPE "DeviceTokenContext" AS ENUM ('BROKKR_LIVE', 'DEPLOYMENT_OS');

-- CreateEnum
CREATE TYPE "DeviceTokenStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeviceTokenRevocationReason" AS ENUM ('DEPLOYMENT_ENDED', 'REPROVISION', 'MANUAL', 'ROTATION', 'SUSPECTED_LEAK');

-- CreateEnum
CREATE TYPE "DeviceTokenAuditEventType" AS ENUM ('ISSUED', 'REVOKED', 'ROTATED', 'USED_AFTER_REVOKE', 'USED_AFTER_EXPIRY');

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deviceId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "context" "DeviceTokenContext" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "status" "DeviceTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "DeviceTokenRevocationReason",
    "revokedNote" TEXT,
    "issuedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceTokenAuditEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tokenId" UUID NOT NULL,
    "event" "DeviceTokenAuditEventType" NOT NULL,
    "actor" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceTokenAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_tokenHash_key" ON "DeviceToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceToken_deviceId_context_status_idx" ON "DeviceToken"("deviceId", "context", "status");

-- CreateIndex
CREATE INDEX "DeviceToken_deploymentId_idx" ON "DeviceToken"("deploymentId");

-- CreateIndex
CREATE INDEX "DeviceToken_status_expiresAt_idx" ON "DeviceToken"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX device_token_one_active_per_context ON "DeviceToken" ("deviceId", "context", COALESCE("deploymentId", '00000000-0000-0000-0000-000000000000')) WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "DeviceTokenAuditEvent_tokenId_createdAt_idx" ON "DeviceTokenAuditEvent"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceTokenAuditEvent_event_createdAt_idx" ON "DeviceTokenAuditEvent"("event", "createdAt");

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceTokenAuditEvent" ADD CONSTRAINT "DeviceTokenAuditEvent_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "DeviceToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

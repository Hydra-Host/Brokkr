-- CreateEnum
CREATE TYPE "DeviceSecretAuditEventType" AS ENUM ('WRITE', 'UPDATE', 'REVEAL_REQUESTED', 'REVEAL_DELIVERED', 'DISPATCH', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "DeviceSecretActorType" AS ENUM ('USER', 'BRIDGE', 'SYSTEM');

-- CreateTable
CREATE TABLE "DeviceSecretAuditEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deviceId" TEXT NOT NULL,
    "event" "DeviceSecretAuditEventType" NOT NULL,
    "purpose" "DeviceSecretPurpose",
    "kind" "DeviceSecretKind",
    "version" INTEGER,
    "actorType" "DeviceSecretActorType" NOT NULL,
    "actor" TEXT,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSecretAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceSecretAuditEvent_deviceId_createdAt_idx" ON "DeviceSecretAuditEvent"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceSecretAuditEvent_event_createdAt_idx" ON "DeviceSecretAuditEvent"("event", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceSecretAuditEvent_requestId_idx" ON "DeviceSecretAuditEvent"("requestId");

-- AddForeignKey
ALTER TABLE "DeviceSecretAuditEvent" ADD CONSTRAINT "DeviceSecretAuditEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

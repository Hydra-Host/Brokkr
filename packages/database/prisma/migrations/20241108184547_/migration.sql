-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "readonly";

-- CreateTable
CREATE TABLE "readonly"."NetboxDeviceStatusChanges" (
    "id" INTEGER NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "requestId" INTEGER NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "currentStatus" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stripeProductId" TEXT,
    "stripeCustomerId" TEXT,
    "stripePriceId" TEXT,
    "organizationUserId" TEXT,
    "isInternalUser" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NetboxDeviceStatusChanges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NetboxDeviceStatusChanges_requestId_key" ON "readonly"."NetboxDeviceStatusChanges"("requestId");

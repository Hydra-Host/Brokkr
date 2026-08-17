-- CreateTable
CREATE TABLE "DeviceAuditLog" (
    "deviceId" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "metadata" TEXT NOT NULL,
    

    CONSTRAINT "DeviceAuditLog_pkey" PRIMARY KEY ("id")
);

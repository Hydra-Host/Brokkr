-- CreateTable
CREATE TABLE "ZoneMaintenance" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "message" TEXT,
    "expectedEndAt" TIMESTAMP(3),
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabledBy" TEXT NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "disabledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ZoneMaintenance_zoneId_disabledAt_idx" ON "ZoneMaintenance"("zoneId", "disabledAt");

-- AddForeignKey
ALTER TABLE "ZoneMaintenance" ADD CONSTRAINT "ZoneMaintenance_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

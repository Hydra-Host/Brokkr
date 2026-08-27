-- AlterTable
ALTER TABLE "BridgeFacts" ADD COLUMN "zoneId" TEXT;

-- CreateIndex
CREATE INDEX "BridgeFacts_zoneId_idx" ON "BridgeFacts"("zoneId");

-- AddForeignKey
ALTER TABLE "BridgeFacts" ADD CONSTRAINT "BridgeFacts_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

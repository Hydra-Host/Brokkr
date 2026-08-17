-- AlterTable
ALTER TABLE "IpAddress" ADD COLUMN     "natInsideId" TEXT;

-- CreateIndex
CREATE INDEX "IpAddress_natInsideId_idx" ON "IpAddress"("natInsideId");

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_natInsideId_fkey" FOREIGN KEY ("natInsideId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

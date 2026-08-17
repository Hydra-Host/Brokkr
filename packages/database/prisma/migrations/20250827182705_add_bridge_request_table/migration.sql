-- CreateTable
CREATE TABLE "BridgeRequest" (
    "id" TEXT NOT NULL,
    "zoneId" INTEGER NOT NULL,
    "dateApproved" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "dateUpdated" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "prefixes" JSONB NOT NULL,
    "approvedBy" TEXT,

    CONSTRAINT "BridgeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BridgeRequest_zoneId_idx" ON "BridgeRequest"("zoneId");

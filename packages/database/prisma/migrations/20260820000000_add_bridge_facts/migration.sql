-- BridgeFacts: materialized read-only bridge bootstrap/health facts,
-- one row per (zonePath, nodeName), written on content change only.
-- CreateTable
CREATE TABLE "BridgeFacts" (
    "id" TEXT NOT NULL,
    "zonePath" TEXT NOT NULL,
    "nodeName" TEXT NOT NULL,
    "nodeId" TEXT,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "factsJson" JSONB NOT NULL,
    "factsHash" TEXT NOT NULL,
    "packageVersion" TEXT,
    "nomadVersion" TEXT,
    "certNomadNotAfter" TIMESTAMP(3),
    "certRsyslogNotAfter" TIMESTAMP(3),
    "certSshHostNotAfter" TIMESTAMP(3),
    "staleSecrets" BOOLEAN NOT NULL DEFAULT false,
    "authorizedKeysCount" INTEGER,
    "bootstrapComplete" BOOLEAN,
    "hostnameMismatch" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BridgeFacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BridgeFacts_collectedAt_idx" ON "BridgeFacts"("collectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeFacts_zonePath_nodeName_key" ON "BridgeFacts"("zonePath", "nodeName");

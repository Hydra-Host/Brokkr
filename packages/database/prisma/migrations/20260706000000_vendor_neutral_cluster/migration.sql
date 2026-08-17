-- Vendor-neutral clustering: decouple Cluster from the Netris-specific Vpc so
-- multiple SDN plugins can share one core clustering concept. The Netris Vpc /
-- checkpoint / nat-rule state moves into the netris plugin's own schema
-- (plugin_netris), so those columns/tables are dropped from core here.

-- Drop the Netris-specific per-deployment checkpoint (moves to plugin_netris).
ALTER TABLE "VpcOperationCheckpoint" DROP CONSTRAINT IF EXISTS "VpcOperationCheckpoint_deploymentId_fkey";
DROP TABLE IF EXISTS "VpcOperationCheckpoint";

-- Drop the Netris-specific NAT rule id from Deployment (moves to plugin_netris).
ALTER TABLE "Deployment" DROP COLUMN IF EXISTS "netrisNatRuleId";

-- Make Cluster vendor-neutral: drop the Vpc link, add provider discriminator +
-- opaque provider ref + explicit organization ownership.
ALTER TABLE "Cluster" DROP CONSTRAINT IF EXISTS "Cluster_vpcId_fkey";
DROP INDEX IF EXISTS "Cluster_vpcId_idx";
ALTER TABLE "Cluster" DROP COLUMN IF EXISTS "vpcId";

ALTER TABLE "Cluster" ADD COLUMN "provider" TEXT NOT NULL;
ALTER TABLE "Cluster" ADD COLUMN "providerClusterId" TEXT;
ALTER TABLE "Cluster" ADD COLUMN "organizationId" TEXT NOT NULL;

CREATE INDEX "Cluster_organizationId_idx" ON "Cluster"("organizationId");
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop the Netris Vpc table (moves to plugin_netris).
ALTER TABLE "Vpc" DROP CONSTRAINT IF EXISTS "Vpc_organizationId_fkey";
DROP TABLE IF EXISTS "Vpc";

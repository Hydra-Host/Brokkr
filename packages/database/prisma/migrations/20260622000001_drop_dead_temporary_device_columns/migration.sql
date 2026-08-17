/*
  Drop the dead "Temporary fields" columns from "Device".

  These were carried from the NetBox-shaped import and are now written by
  nothing and read by nothing in business logic:
    - clusterId / clusterName  -> superseded by the Cluster / ClusterDeployment
      models; the only reader was the inventory presenter's always-null
      `cluster` field, removed alongside this migration.
    - ipamConfig / virtualNetworkConfig -> IPAM lives in Prefix/IpAddress/Vrf.
    - instanceId               -> unused NetBox pointer.
    - netrisDeviceId           -> unused Netris pointer.

  Retained (NOT temporary, actively used, no replacement): lastJobId
  (saga correlation) and ipmiBootDeviceOverride (operator boot override).
*/

-- AlterTable
ALTER TABLE "Device"
  DROP COLUMN "clusterId",
  DROP COLUMN "clusterName",
  DROP COLUMN "instanceId",
  DROP COLUMN "ipamConfig",
  DROP COLUMN "netrisDeviceId",
  DROP COLUMN "virtualNetworkConfig";

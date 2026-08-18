-- Squashed pre-release baseline: schema DDL plus the objects Prisma cannot express, proven
-- pg_dump-equivalent to replaying the 360 pre-squash migrations (see MR !676; history is in git).
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AdminLifecycleRequestType" AS ENUM ('DEPROVISION', 'REPROVISION', 'PROVISION');

-- CreateEnum
CREATE TYPE "AdminLifecycleRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED');

-- CreateEnum
CREATE TYPE "BgpSessionStatus" AS ENUM ('ACTIVE', 'PLANNED', 'OFFLINE', 'DECOMMISSIONING');

-- CreateEnum
CREATE TYPE "BridgePowerStatus" AS ENUM ('On', 'Off');

-- CreateEnum
CREATE TYPE "CableType" AS ENUM ('CAT5E', 'CAT6', 'CAT6A', 'MMF_OM3', 'MMF_OM4', 'SMF_OS1', 'SMF_OS2', 'POWER', 'SERIAL', 'USB', 'COAX', 'DAC', 'AOC', 'OTHER');

-- CreateEnum
CREATE TYPE "CableStatus" AS ENUM ('CONNECTED', 'PLANNED', 'DECOMMISSIONING');

-- CreateEnum
CREATE TYPE "CableSide" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "CableTerminationType" AS ENUM ('INTERFACE', 'CONSOLE_PORT', 'CONSOLE_SERVER_PORT', 'POWER_PORT', 'POWER_OUTLET', 'FRONT_PORT', 'REAR_PORT');

-- CreateEnum
CREATE TYPE "CableLengthUnit" AS ENUM ('METERS', 'CENTIMETERS', 'FEET', 'INCHES');

-- CreateEnum
CREATE TYPE "Airflow" AS ENUM ('FrontToRear', 'RearToFront', 'LeftToRight', 'RightToLeft', 'SideToRear', 'Passive', 'Mixed');

-- CreateEnum
CREATE TYPE "CduPowerStatus" AS ENUM ('On', 'Off');

-- CreateEnum
CREATE TYPE "CircuitStatus" AS ENUM ('ACTIVE', 'PLANNED', 'OFFLINE', 'DEPROVISIONING', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "CircuitTerminationSide" AS ENUM ('A', 'Z');

-- CreateEnum
CREATE TYPE "ConfigTemplateKind" AS ENUM ('DEVICE_INFRASTRUCTURE');

-- CreateEnum
CREATE TYPE "ConfigTemplatePurpose" AS ENUM ('NETPLAN');

-- CreateEnum
CREATE TYPE "ConsolePortType" AS ENUM ('DE9', 'RJ45', 'USB_A', 'USB_C', 'USB_MINI', 'USB_MICRO', 'OTHER');

-- CreateEnum
CREATE TYPE "DeploymentType" AS ENUM ('SELF_SERVICE', 'OFF_BROKKR');

-- CreateEnum
CREATE TYPE "RequestSource" AS ENUM ('UI', 'API', 'DEVICE', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DeploymentLifecycleActionType" AS ENUM ('Provision', 'Reprovision', 'Reboot', 'PowerOn', 'PowerOff', 'Deprovision');

-- CreateEnum
CREATE TYPE "DeviceDiagnosticsType" AS ENUM ('Driver', 'Gpu', 'Nvlink', 'Lspci', 'Services', 'Kernel', 'System', 'Infiniband', 'Storage', 'Thermal', 'Cuda', 'AllDiagnostics', 'Health', 'Fabric', 'Ecc');

-- CreateEnum
CREATE TYPE "DeviceSecretPurpose" AS ENUM ('BMC', 'CONSOLE');

-- CreateEnum
CREATE TYPE "DeviceSecretKind" AS ENUM ('USER', 'KEY', 'TOKEN', 'CERT');

-- CreateEnum
CREATE TYPE "DeviceSecretAuditEventType" AS ENUM ('WRITE', 'UPDATE', 'REVEAL_REQUESTED', 'REVEAL_DELIVERED', 'DISPATCH', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "DeviceSecretActorType" AS ENUM ('USER', 'BRIDGE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SolResolvedSource" AS ENUM ('probed', 'modem_hint', 'vendor_table', 'none');

-- CreateEnum
CREATE TYPE "DeviceTestStatus" AS ENUM ('Completed', 'Running');

-- CreateEnum
CREATE TYPE "DeviceTestType" AS ENUM ('GpuBurnIn', 'NcclPerformance');

-- CreateEnum
CREATE TYPE "DeviceTokenContext" AS ENUM ('BROKKR_LIVE', 'DEPLOYMENT_OS');

-- CreateEnum
CREATE TYPE "DeviceTokenStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeviceTokenRevocationReason" AS ENUM ('DEPLOYMENT_ENDED', 'REPROVISION', 'MANUAL', 'ROTATION', 'SUSPECTED_LEAK');

-- CreateEnum
CREATE TYPE "DeviceTokenAuditEventType" AS ENUM ('ISSUED', 'REVOKED', 'ROTATED', 'USED_AFTER_REVOKE', 'USED_AFTER_EXPIRY');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PLANNED', 'STAGED', 'ACTIVE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "NetplanPopulation" AS ENUM ('FLAT', 'VPC', 'VPC_ROCE', 'BRIDGE_DEFAULT', 'BRIDGE_BONDED', 'BRIDGE_SANS_VRF');

-- CreateEnum
CREATE TYPE "DeviceNetworkType" AS ENUM ('NAT', 'Public');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('Hypervisor', 'Baremetal');

-- CreateEnum
CREATE TYPE "DeviceRole" AS ENUM ('Hypervisor', 'Baremetal', 'Cluster', 'VM', 'Decommissioned', 'DiscoveredHost', 'OffMarketplaceHost', 'NetworkSwitch', 'Server', 'Bridge', 'Switch', 'Router', 'PDU', 'CDU', 'RackBrush', 'PatchPanel');

-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DiscoveryIssuePhase" AS ENUM ('INGRESS', 'SCHEMA', 'HANDLER', 'COMPOSER', 'COMMIT');

-- CreateEnum
CREATE TYPE "DiscoveryIssueSeverity" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "DnsDomainType" AS ENUM ('FORWARD', 'REVERSE');

-- CreateEnum
CREATE TYPE "DnsRecordType" AS ENUM ('A', 'AAAA', 'PTR');

-- CreateEnum
CREATE TYPE "DnsRecordSource" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "EventOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'DENIED');

-- CreateEnum
CREATE TYPE "EventTier" AS ENUM ('EVIDENCE', 'ACTIVITY');

-- CreateEnum
CREATE TYPE "EventDurability" AS ENUM ('ATOMIC', 'POST_COMMIT', 'BEST_EFFORT');

-- CreateEnum
CREATE TYPE "FirmwareType" AS ENUM ('BIOS', 'BMC', 'CPLD', 'GPU_DRIVER', 'NIC_FW', 'BMC_FW_BUILD');

-- CreateEnum
CREATE TYPE "GpuVendor" AS ENUM ('NVIDIA', 'AMD', 'INTEL');

-- CreateEnum
CREATE TYPE "GpuCcMode" AS ENUM ('OFF', 'ON', 'DEVTOOLS');

-- CreateEnum
CREATE TYPE "InterfaceType" AS ENUM ('ETHERNET_1G', 'ETHERNET_10G', 'ETHERNET_25G', 'ETHERNET_40G', 'ETHERNET_50G', 'ETHERNET_100G', 'ETHERNET_200G', 'ETHERNET_400G', 'ETHERNET_800G', 'INFINIBAND_FDR', 'INFINIBAND_EDR', 'INFINIBAND_HDR', 'INFINIBAND_NDR', 'INFINIBAND_XDR', 'IPMI_BMC', 'BOND', 'VIRTUAL');

-- CreateEnum
CREATE TYPE "InterfaceLinkType" AS ENUM ('INFINIBAND', 'ETHERNET');

-- CreateEnum
CREATE TYPE "InterfaceMode" AS ENUM ('ACCESS', 'TAGGED');

-- CreateEnum
CREATE TYPE "InterruptibleClaimStatus" AS ENUM ('Pending', 'Complete');

-- CreateEnum
CREATE TYPE "IpamRole" AS ENUM ('ALLOCATION', 'COMMON', 'LOOPBACK', 'MANAGEMENT', 'NAT', 'PRIMARY');

-- CreateEnum
CREATE TYPE "PrefixStatus" AS ENUM ('CONTAINER', 'ACTIVE', 'RESERVED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "IpStatus" AS ENUM ('ACTIVE', 'RESERVED', 'DEPRECATED', 'DHCP');

-- CreateEnum
CREATE TYPE "AssignedObjectType" AS ENUM ('Interface', 'VirtualMachine', 'Device');

-- CreateEnum
CREATE TYPE "VlanStatus" AS ENUM ('ACTIVE', 'RESERVED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "IpRangeStatus" AS ENUM ('ACTIVE', 'RESERVED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "DhcpMode" AS ENUM ('AUTHORITATIVE', 'PROXY', 'OFF');

-- CreateEnum
CREATE TYPE "IpxeBuildTarget" AS ENUM ('IPXE', 'SNP', 'SNPONLY');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('Provision', 'Reprovision', 'Reboot', 'PowerOn', 'PowerOff', 'Deprovision', 'Interrupted', 'Commission', 'Decommission');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('Pending', 'InProgress', 'Completed', 'Failed');

-- CreateEnum
CREATE TYPE "LayerSelectionType" AS ENUM ('SINGLE_SELECT', 'MULTI_SELECT');

-- CreateEnum
CREATE TYPE "LayerRelationType" AS ENUM ('REQUIRES', 'CONFLICTS');

-- CreateEnum
CREATE TYPE "LayerKind" AS ENUM ('BASE', 'LEGACY', 'COMPONENT', 'INTERNAL', 'LIVE');

-- CreateEnum
CREATE TYPE "LayerBuildStatus" AS ENUM ('IMPORTING', 'READY', 'FAILED', 'RETIRED');

-- CreateEnum
CREATE TYPE "LifecycleJobPhase" AS ENUM ('REQUESTED', 'AUTHORIZING', 'SCHEDULED', 'DEFERRED', 'DISPATCHED', 'RUNNING', 'AWAITING_PHONE_HOME', 'COMPLETED', 'FAILED', 'ABORTED');

-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('DDR3', 'DDR4', 'DDR5', 'LPDDR4', 'LPDDR5');

-- CreateEnum
CREATE TYPE "MemoryEccType" AS ENUM ('SINGLE_BIT_ECC', 'MULTI_BIT_ECC', 'NONE');

-- CreateEnum
CREATE TYPE "OrganizationMembershipRole" AS ENUM ('SuperAdmin', 'Admin', 'Member', 'Owner');

-- CreateEnum
CREATE TYPE "TenantType" AS ENUM ('SupplyCustomer', 'DemandCustomer');

-- CreateEnum
CREATE TYPE "OrganizationSiteContactType" AS ENUM ('Main', 'Technical');

-- CreateEnum
CREATE TYPE "PortType" AS ENUM ('RJ45', 'FC', 'LC', 'SC', 'ST', 'MPO', 'CS', 'SN', 'OTHER');

-- CreateEnum
CREATE TYPE "PduPowerStatus" AS ENUM ('On', 'Off');

-- CreateEnum
CREATE TYPE "PowerPortType" AS ENUM ('IEC_C14', 'IEC_C20', 'NEMA_515P', 'NEMA_L630P', 'OTHER');

-- CreateEnum
CREATE TYPE "PowerOutletType" AS ENUM ('IEC_C13', 'IEC_C19', 'NEMA_515R', 'NEMA_L630R', 'OTHER');

-- CreateEnum
CREATE TYPE "FeedLegPhase" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "RackStatus" AS ENUM ('ACTIVE', 'PLANNED', 'RESERVED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "RackRole" AS ENUM ('COMPUTE', 'NETWORK', 'STORAGE', 'MIXED', 'POWER');

-- CreateEnum
CREATE TYPE "RackFace" AS ENUM ('FRONT', 'REAR');

-- CreateEnum
CREATE TYPE "BillingFrequency" AS ENUM ('HOURLY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "RouterPowerStatus" AS ENUM ('On', 'Off');

-- CreateEnum
CREATE TYPE "ScheduledJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ServerLifecycleStatus" AS ENUM ('INVENTORY', 'PROVISIONING', 'PROVISIONED', 'OFFLINE', 'FAILED', 'DEPROVISIONING');

-- CreateEnum
CREATE TYPE "ServerPowerStatus" AS ENUM ('On', 'Off', 'PoweringOn', 'PoweringOff', 'Rebooting');

-- CreateEnum
CREATE TYPE "TeeCapability" AS ENUM ('UNVERIFIED', 'FALSE', 'PATCH', 'TRUE');

-- CreateEnum
CREATE TYPE "StorageDriveType" AS ENUM ('NVME', 'SSD', 'HDD');

-- CreateEnum
CREATE TYPE "SwitchPowerStatus" AS ENUM ('On', 'Off');

-- CreateEnum
CREATE TYPE "TagObjectType" AS ENUM ('DEVICE', 'INTERFACE', 'PREFIX', 'VLAN', 'VRF', 'IP_ADDRESS', 'ZONE', 'CLUSTER');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "WebhookEventType" AS ENUM ('DEVICE_LISTING_UPDATED', 'DEVICE_LISTING_CREATED', 'DEVICE_LISTING_DECOMMISSIONED', 'DEPLOYMENT_INTERRUPTED', 'DEPLOYMENT_INTERRUPTION_COMPLETED');

-- CreateEnum
CREATE TYPE "NetworkType" AS ENUM ('public', 'private', 'vpc');

-- CreateEnum
CREATE TYPE "BridgePackage" AS ENUM ('container', 'lite', 'pro');

-- CreateEnum
CREATE TYPE "PrefixType" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "PrefixRole" AS ENUM ('primary', 'management');

-- CreateEnum
CREATE TYPE "ZoneNetworkType" AS ENUM ('FLAT', 'VPC');

-- CreateEnum
CREATE TYPE "ZoneEastWestNetworkType" AS ENUM ('ROCE', 'ETHERNET');

-- CreateEnum
CREATE TYPE "ZoneAddressType" AS ENUM ('PRIMARY', 'SHIPPING');

-- CreateEnum
CREATE TYPE "ZoneContactType" AS ENUM ('Main', 'Technical');

-- CreateTable
CREATE TABLE "AdminLifecycleRequest" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" "AdminLifecycleRequestType" NOT NULL,
    "requestBody" JSONB NOT NULL,
    "status" "AdminLifecycleRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminLifecycleRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apikey" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "start" TEXT,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refillInterval" INTEGER,
    "refillAmount" INTEGER,
    "lastRefillAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rateLimitEnabled" BOOLEAN NOT NULL DEFAULT true,
    "rateLimitTimeWindow" INTEGER,
    "rateLimitMax" INTEGER,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "remaining" INTEGER,
    "lastRequest" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "permissions" TEXT,
    "metadata" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "apikey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asn" (
    "id" TEXT NOT NULL,
    "asn" INTEGER NOT NULL,
    "description" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VlanGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minVid" INTEGER NOT NULL DEFAULT 2,
    "maxVid" INTEGER NOT NULL DEFAULT 4094,
    "zoneId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VlanGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BgpPeerGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BgpPeerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrefixList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "family" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrefixList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrefixListRule" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "prefix" TEXT,
    "ge" INTEGER,
    "le" INTEGER,
    "sequence" INTEGER NOT NULL,
    "prefixListId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrefixListRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BgpSession" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "BgpSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "deviceId" TEXT,
    "localAsnId" TEXT,
    "remoteAsnId" TEXT,
    "localAddressId" TEXT,
    "remoteAddressId" TEXT,
    "peerGroupId" TEXT,
    "prefixListInId" TEXT,
    "prefixListOutId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BgpSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bridge" (
    "id" TEXT NOT NULL,
    "bridgeVersion" TEXT,
    "redisQueuePrefix" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "powerStatus" "BridgePowerStatus",
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bridge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cable" (
    "id" TEXT NOT NULL,
    "type" "CableType",
    "status" "CableStatus" NOT NULL DEFAULT 'CONNECTED',
    "label" TEXT,
    "color" TEXT,
    "length" DECIMAL(65,30),
    "lengthUnit" "CableLengthUnit",
    "description" TEXT,
    "cableDetails" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CableTermination" (
    "id" TEXT NOT NULL,
    "cableSide" "CableSide" NOT NULL,
    "terminationType" "CableTerminationType" NOT NULL,
    "terminationId" TEXT NOT NULL,
    "cableId" TEXT NOT NULL,

    CONSTRAINT "CableTermination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cdu" (
    "id" TEXT NOT NULL,
    "coolantType" TEXT,
    "ratedFlowRateLpm" DOUBLE PRECISION,
    "ratedThermalCapacityKw" INTEGER,
    "airflow" "Airflow" NOT NULL DEFAULT 'FrontToRear',
    "powerStatus" "CduPowerStatus",
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cdu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Changelog" (
    "id" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "pk" UUID NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "diff" JSONB NOT NULL,
    "organizationId" TEXT,
    "actorId" TEXT,
    "actorType" "RequestSource",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Changelog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderNetwork" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "comments" TEXT,
    "providerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderNetwork_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircuitType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Circuit" (
    "id" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "status" "CircuitStatus" NOT NULL DEFAULT 'ACTIVE',
    "installDate" TIMESTAMP(3),
    "terminationDate" TIMESTAMP(3),
    "commitRate" INTEGER,
    "description" TEXT,
    "comments" TEXT,
    "providerId" TEXT NOT NULL,
    "circuitTypeId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Circuit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircuitTermination" (
    "id" TEXT NOT NULL,
    "termSide" "CircuitTerminationSide" NOT NULL,
    "portSpeed" INTEGER,
    "upstreamSpeed" INTEGER,
    "xconnectId" TEXT,
    "description" TEXT,
    "circuitId" TEXT NOT NULL,
    "zoneId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitTermination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudInitTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CloudInitTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,
    "dateDeleted" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerClusterId" TEXT,
    "organizationId" TEXT NOT NULL,
    "zoneId" TEXT,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterDeployment" (
    "id" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clusterId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,

    CONSTRAINT "ClusterDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "templateCode" TEXT NOT NULL,
    "environmentParams" JSONB,
    "kind" "ConfigTemplateKind" NOT NULL DEFAULT 'DEVICE_INFRASTRUCTURE',
    "purpose" "ConfigTemplatePurpose",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsolePort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ConsolePortType",
    "speed" INTEGER,
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsolePort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsoleServerPort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ConsolePortType",
    "speed" INTEGER,
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsoleServerPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cpu" (
    "id" TEXT NOT NULL,
    "socketIndex" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "vendor" TEXT,
    "architecture" TEXT,
    "coreCount" INTEGER,
    "threadCount" INTEGER,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cpu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DcimRackRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DcimRackRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '',
    "customIpxeScript" BOOLEAN NOT NULL DEFAULT false,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "type" "DeploymentType" NOT NULL,
    "serverId" TEXT NOT NULL,
    "reservationId" TEXT,
    "scheduledInterruptionTime" TIMESTAMP(3),
    "isInterruptible" BOOLEAN NOT NULL DEFAULT false,
    "interruptibleNoticePeriod" INTEGER,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "cloudInitStorageBlock" TEXT,
    "cloudInitNetworkBlock" TEXT,
    "cloudInitLateCommands" TEXT,
    "diskEncryptionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "gpuDriversEnabled" BOOLEAN NOT NULL DEFAULT false,
    "publicIpAddressId" TEXT,
    "privateIpAddressId" TEXT,
    "deployerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "baseLayerId" TEXT,
    "rescueLayerId" TEXT,
    "deploymentProjectId" TEXT,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLifecycleAction" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "actionType" "DeploymentLifecycleActionType" NOT NULL,
    "source" "RequestSource" NOT NULL,
    "performedBy" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentLifecycleAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentSshKeys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sshKeyId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,

    CONSTRAINT "DeploymentSshKeys_pkey" PRIMARY KEY ("deploymentId","sshKeyId")
);

-- CreateTable
CREATE TABLE "DeploymentProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "DeploymentProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceDiagnostics" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "type" "DeviceDiagnosticsType" NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceDiagnostics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceDocument" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileType" TEXT,
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceModel" (
    "id" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "slug" TEXT,
    "formFactor" TEXT,
    "description" TEXT,
    "isFullDepth" BOOLEAN NOT NULL DEFAULT true,
    "heightU" INTEGER,
    "maxPowerW" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSecretAuditEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deviceId" TEXT,
    "zoneId" TEXT,
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

-- CreateTable
CREATE TABLE "DeviceSecret" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "purpose" "DeviceSecretPurpose" NOT NULL,
    "kind" "DeviceSecretKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "ephPub" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "zoneId" TEXT NOT NULL,
    "zoneKeyId" TEXT NOT NULL,
    "keyGen" INTEGER NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "DeviceSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSolConfig" (
    "deviceId" TEXT NOT NULL,
    "solCapable" BOOLEAN,
    "solEnabled" BOOLEAN,
    "hardwareChannel" INTEGER,
    "baudRate" INTEGER,
    "port" INTEGER,
    "encryptionCapable" BOOLEAN,
    "optimalPort" TEXT,
    "bmcChannelMapping" TEXT,
    "resolvedPort" TEXT,
    "resolvedBaud" INTEGER,
    "resolvedSource" "SolResolvedSource",
    "resolvedConfirmed" BOOLEAN,
    "availablePorts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceSolConfig_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "DeviceTestRun" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceMetadataId" INTEGER,
    "type" "DeviceTestType" NOT NULL,
    "status" "DeviceTestStatus" NOT NULL DEFAULT 'Running',
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "testPassed" BOOLEAN,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceTestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "context" "DeviceTokenContext" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "status" "DeviceTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "rotationGeneration" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "DeviceTokenRevocationReason",
    "revokedNote" TEXT,
    "issuedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceTokenAuditEvent" (
    "id" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "event" "DeviceTokenAuditEventType" NOT NULL,
    "actor" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceTokenAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nickname" TEXT,
    "internalName" TEXT,
    "systemSerial" TEXT,
    "chassisSerial" TEXT,
    "serial" TEXT,
    "baseboardSerial" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PLANNED',
    "role" "DeviceRole",
    "deviceType" "DeviceType",
    "networkType" "DeviceNetworkType",
    "netplanOverride" TEXT,
    "netplanPopulation" "NetplanPopulation",
    "systemUuid" TEXT,
    "productSku" TEXT,
    "assetTag" TEXT,
    "secureBootEnabled" BOOLEAN,
    "architecture" TEXT,
    "uefiBoot" BOOLEAN,
    "iommuEnabled" BOOLEAN,
    "sriovEnabled" BOOLEAN,
    "zoneId" TEXT,
    "supplierId" TEXT,
    "skuId" TEXT,
    "deviceModelId" TEXT,
    "organizationId" TEXT,
    "configTemplateId" TEXT,
    "lastJobId" TEXT,
    "ipmiBootDeviceOverride" TEXT,
    "ipxeBuildTarget" "IpxeBuildTarget",
    "bootFilename" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceMaintenance" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "message" TEXT,
    "expectedEndAt" TIMESTAMP(3),
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabledBy" TEXT NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "disabledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierSKU" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,

    CONSTRAINT "SupplierSKU_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'STARTED',
    "jobId" TEXT NOT NULL,
    "zonePrefix" TEXT NOT NULL,
    "handlerVersion" TEXT NOT NULL,
    "bridgeCollectorVersion" TEXT,
    "collectorsExpected" INTEGER,
    "collectorsReceived" INTEGER,
    "collectorsApplied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collectorsSkipped" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "composersApplied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "s3Prefix" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRunIssue" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "phase" "DiscoveryIssuePhase" NOT NULL,
    "collector" TEXT,
    "code" TEXT NOT NULL,
    "severity" "DiscoveryIssueSeverity" NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryRunIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DnsDomain" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DnsDomainType" NOT NULL DEFAULT 'FORWARD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "zoneId" TEXT NOT NULL,

    CONSTRAINT "DnsDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DnsRecord" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DnsRecordType" NOT NULL,
    "value" TEXT NOT NULL,
    "source" "DnsRecordSource" NOT NULL DEFAULT 'MANUAL',
    "ttlOverride" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "domainId" TEXT NOT NULL,
    "deviceId" TEXT,
    "ipAddressId" TEXT,

    CONSTRAINT "DnsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" "EventTier" NOT NULL,
    "durability" "EventDurability" NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "actorType" "RequestSource" NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "apiKeyId" TEXT,
    "apiKeyLabel" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "outcome" "EventOutcome" NOT NULL,
    "errorCode" TEXT,
    "requestId" TEXT,
    "method" TEXT,
    "path" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLogAccessBucket" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "hourBucket" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLogAccessBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "internalName" TEXT,
    "operator" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Colocation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "internalName" TEXT,
    "notes" TEXT,
    "facilityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Colocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceFirmware" (
    "id" TEXT NOT NULL,
    "type" "FirmwareType" NOT NULL,
    "vendor" TEXT,
    "version" TEXT NOT NULL,
    "date" TEXT,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceFirmware_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gateway" (
    "id" TEXT NOT NULL,
    "routingPriority" INTEGER,
    "vrfId" TEXT,
    "gatewayIpId" TEXT NOT NULL,
    "prefixId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gpu" (
    "id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "vendor" "GpuVendor" NOT NULL DEFAULT 'NVIDIA',
    "uuid" TEXT,
    "vbiosVersion" TEXT,
    "serial" TEXT,
    "pciBusId" TEXT,
    "memoryTotalMb" INTEGER,
    "eccEnabled" BOOLEAN,
    "pcieLinkGen" INTEGER,
    "pcieLinkWidth" INTEGER,
    "powerLimitW" DECIMAL(65,30),
    "powerLimitMaxW" DECIMAL(65,30),
    "driverVersion" TEXT,
    "computeCapability" TEXT,
    "architecture" TEXT,
    "migMode" BOOLEAN,
    "migProfile" TEXT,
    "ccMode" "GpuCcMode",
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gpu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interface" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "InterfaceType",
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mtu" INTEGER,
    "macAddress" TEXT,
    "speed" INTEGER,
    "mgmtOnly" BOOLEAN NOT NULL DEFAULT false,
    "markConnected" BOOLEAN NOT NULL DEFAULT false,
    "mode" "InterfaceMode",
    "description" TEXT,
    "linkType" "InterfaceLinkType",
    "guid" TEXT,
    "portState" TEXT,
    "maxSpeedGbps" INTEGER,
    "pciDeviceId" TEXT,
    "lldpNeighborName" TEXT,
    "lldpNeighborPort" TEXT,
    "lldpNeighborDescr" TEXT,
    "lldpNeighborMgmtIp" TEXT,
    "driver" TEXT,
    "operstate" TEXT,
    "linkOperUp" BOOLEAN,
    "linkPhysicalUp" BOOLEAN,
    "deviceId" TEXT NOT NULL,
    "lagId" TEXT,
    "parentId" TEXT,
    "untaggedVlanId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Interface_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterruptibleClaim" (
    "id" TEXT NOT NULL,
    "deploymentName" TEXT NOT NULL,
    "status" "InterruptibleClaimStatus" NOT NULL,
    "interruptAt" TIMESTAMP(3) NOT NULL,
    "serverId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterruptibleClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpamPrefixVlanRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1000,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IpamPrefixVlanRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vrf" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rd" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Vrf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prefix" (
    "id" TEXT NOT NULL,
    "prefix" cidr NOT NULL,
    "status" "PrefixStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPool" BOOLEAN NOT NULL DEFAULT false,
    "role" "IpamRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "vrfId" TEXT,
    "zoneId" TEXT,
    "parentId" TEXT,
    "vlanId" TEXT,
    "gatewayIpId" TEXT,
    "vrrpVipId" TEXT,
    "associatedPrefixId" TEXT,
    "bondParameters" JSONB,
    "enableVlanTag" BOOLEAN NOT NULL DEFAULT false,
    "dhcpMode" "DhcpMode",
    "dhcpLeaseTtlSeconds" INTEGER,
    "dhcpOptions" JSONB,
    "ipxeBuildTarget" "IpxeBuildTarget" NOT NULL DEFAULT 'IPXE',
    "dhcpProxyAllowedMacs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dhcpProxyPeerAuthoritative" BOOLEAN NOT NULL DEFAULT false,
    "dhcpRelayAgentIp" INET,
    "dnsServeDns" BOOLEAN,
    "dnsUpstreamOverride" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locationPrefix" INTEGER,
    "prefixRoleId" TEXT,

    CONSTRAINT "Prefix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpAddress" (
    "id" TEXT NOT NULL,
    "address" INET NOT NULL,
    "status" "IpStatus" NOT NULL DEFAULT 'ACTIVE',
    "dnsName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "vrfId" TEXT,
    "assignedObjectType" "AssignedObjectType",
    "assignedObjectId" TEXT,
    "interfaceId" TEXT,
    "natInsideId" TEXT,
    "routingPrefix" cidr,

    CONSTRAINT "IpAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vid" INTEGER NOT NULL,
    "description" TEXT,
    "status" "VlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "role" "IpamRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "vrfId" TEXT,
    "zoneId" TEXT,
    "vlanGroupId" TEXT,

    CONSTRAINT "Vlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpRange" (
    "id" TEXT NOT NULL,
    "start" INET NOT NULL,
    "end" INET NOT NULL,
    "status" "IpRangeStatus" NOT NULL DEFAULT 'ACTIVE',
    "purpose" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "prefixId" TEXT NOT NULL,
    "vrfId" TEXT,
    "zoneId" TEXT,

    CONSTRAINT "IpRange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrefixVrrpBinding" (
    "id" TEXT NOT NULL,
    "prefixId" TEXT NOT NULL,
    "bridgeId" TEXT NOT NULL,
    "iface" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrefixVrrpBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "job" JSONB NOT NULL,
    "jobType" "JobType" NOT NULL,
    "deviceId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'Pending',
    "lastCompletedStep" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayerBuild" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "manifestUrl" TEXT NOT NULL,
    "status" "LayerBuildStatus" NOT NULL DEFAULT 'IMPORTING',
    "error" TEXT,
    "pipelineId" BIGINT,
    "generatedAt" TIMESTAMP(3),
    "promotedFrom" TEXT,
    "promotedAt" TIMESTAMP(3),
    "promotedByPipelineId" BIGINT,
    "importedById" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayerBuild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "defaultLayerBuildId" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayerGroup" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "selectionType" "LayerSelectionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Layer" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "family" TEXT,
    "kind" "LayerKind" NOT NULL DEFAULT 'COMPONENT',
    "layerGroupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Layer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayerArtifact" (
    "id" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "layerBuildId" TEXT NOT NULL,
    "osDistro" TEXT NOT NULL,
    "osCodename" TEXT NOT NULL,
    "osVersion" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "sha256" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "compression" TEXT NOT NULL DEFAULT 'zstd',
    "kernel" TEXT,
    "releaseVersion" TEXT,
    "sourceVersion" TEXT,
    "filename" TEXT,
    "builtAt" TIMESTAMP(3),
    "builtByPipelineId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayerArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayerRelation" (
    "artifactId" TEXT NOT NULL,
    "relatedLayerId" TEXT NOT NULL,
    "type" "LayerRelationType" NOT NULL,
    "groupId" TEXT,

    CONSTRAINT "LayerRelation_pkey" PRIMARY KEY ("artifactId","relatedLayerId")
);

-- CreateTable
CREATE TABLE "DeploymentLayer" (
    "deploymentId" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "layerArtifactId" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentLayer_pkey" PRIMARY KEY ("deploymentId","layerId")
);

-- CreateTable
CREATE TABLE "LifecycleJob" (
    "id" TEXT NOT NULL,
    "jobType" "JobType" NOT NULL,
    "phase" "LifecycleJobPhase" NOT NULL DEFAULT 'REQUESTED',
    "payload" JSONB NOT NULL,
    "deviceId" TEXT,
    "deploymentId" TEXT,
    "organizationId" TEXT,
    "source" "RequestSource" NOT NULL,
    "performedBy" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "phoneHomeDeadline" TIMESTAMP(3),
    "linkedJobId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifecycleJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sagaName" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Manufacturer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Manufacturer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryConfig" (
    "id" TEXT NOT NULL,
    "totalSizeMb" INTEGER NOT NULL,
    "populatedDimms" INTEGER NOT NULL,
    "totalSlots" INTEGER NOT NULL,
    "dimmSizeMb" INTEGER,
    "dimmType" "MemoryType",
    "dimmSpeed" TEXT,
    "configuredSpeed" TEXT,
    "eccType" "MemoryEccType",
    "configSummary" TEXT,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NvlinkEdge" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sourceGpuIndex" INTEGER NOT NULL,
    "targetGpuIndex" INTEGER NOT NULL,
    "lanes" INTEGER,
    "bandwidthGbps" DECIMAL(65,30),
    "linkStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NvlinkEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantType" "TenantType" NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "auth0OrganizationId" TEXT,
    "email" TEXT,
    "country" TEXT,
    "contactNotes" TEXT,
    "isInstanceOperator" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "OrganizationMembershipRole" NOT NULL,
    "assignedRoleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "isDefaultOrg" BOOLEAN,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assignedRoleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "inviterId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMembershipInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,

    CONSTRAINT "OrganizationMembershipInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "OrganizationApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSiteContact" (
    "id" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "dateUpdated" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contactType" "OrganizationSiteContactType" NOT NULL,
    "isShippingContact" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "OrganizationSiteContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatchPanel" (
    "id" TEXT NOT NULL,
    "panelType" TEXT,
    "portCount" INTEGER,
    "rackUnitHeight" INTEGER,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatchPanel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrontPort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PortType" NOT NULL,
    "rearPortPosition" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "rearPortId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FrontPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RearPort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PortType" NOT NULL,
    "positions" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RearPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PciDevice" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorName" TEXT,
    "productId" TEXT NOT NULL,
    "productName" TEXT,
    "className" TEXT,
    "subclassName" TEXT,
    "driver" TEXT,
    "subsystemVendorId" TEXT,
    "subsystemProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PciDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pdu" (
    "id" TEXT NOT NULL,
    "outletCount" INTEGER,
    "ratedAmperage" INTEGER,
    "voltageType" TEXT,
    "powerStatus" "PduPowerStatus",
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pdu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMemberRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT,
    "templateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "OrganizationMemberRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_brokkr_plugin_migrations" (
    "plugin_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_brokkr_plugin_migrations_pkey" PRIMARY KEY ("plugin_id","version")
);

-- CreateTable
CREATE TABLE "PowerPort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PowerPortType",
    "maximumDraw" INTEGER,
    "allocatedDraw" INTEGER,
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PowerPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PowerOutlet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PowerOutletType",
    "feedLegPhase" "FeedLegPhase",
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PowerOutlet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RackBrush" (
    "id" TEXT NOT NULL,
    "brushMaterial" TEXT,
    "rackUnitHeight" INTEGER,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RackBrush_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rack" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RackStatus" NOT NULL DEFAULT 'ACTIVE',
    "role" "RackRole",
    "heightU" INTEGER NOT NULL DEFAULT 42,
    "startingUnit" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "serial" TEXT,
    "assetTag" TEXT,
    "zoneId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceRackAssignment" (
    "id" TEXT NOT NULL,
    "position" DECIMAL(65,30) NOT NULL,
    "face" "RackFace" NOT NULL,
    "heightU" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "rackId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceRackAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "boundary" JSONB NOT NULL,
    "centroidLat" DOUBLE PRECISION NOT NULL,
    "centroidLng" DOUBLE PRECISION NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationInvite" (
    "id" TEXT NOT NULL,
    "inviteeEmail" TEXT,
    "inviterEmail" TEXT NOT NULL DEFAULT '',
    "inviteeOrganizationId" TEXT,
    "price" INTEGER NOT NULL DEFAULT 0,
    "billingFrequency" "BillingFrequency" NOT NULL DEFAULT 'MONTHLY',
    "manualBilling" BOOLEAN NOT NULL DEFAULT false,
    "interruptibleNoticePeriod" INTEGER,
    "notes" TEXT,
    "dateAccepted" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "dateExpires" TIMESTAMP(3) NOT NULL,
    "dateUpdated" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "reservationId" TEXT,

    CONSTRAINT "ReservationInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServersInReservationInvite" (
    "serverId" TEXT NOT NULL,
    "reservationInviteId" TEXT NOT NULL,

    CONSTRAINT "ServersInReservationInvite_pkey" PRIMARY KEY ("serverId","reservationInviteId")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "internalProvision" BOOLEAN DEFAULT false,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "notes" TEXT,
    "price" INTEGER,
    "billingFrequency" "BillingFrequency",
    "interruptibleNoticePeriod" INTEGER,
    "reserverId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServersInReservation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservationId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,

    CONSTRAINT "ServersInReservation_pkey" PRIMARY KEY ("reservationId","serverId")
);

-- CreateTable
CREATE TABLE "Router" (
    "id" TEXT NOT NULL,
    "routerType" TEXT,
    "bgpAsn" INTEGER,
    "powerStatus" "RouterPowerStatus",
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Router_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sanitization_reports" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sanitization_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB,
    "scheduledAt" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "status" "ScheduledJobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "queue" VARCHAR(100) NOT NULL DEFAULT 'default',
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "cronExpression" VARCHAR(255),
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMPTZ,
    "lockExpiresAt" TIMESTAMPTZ,
    "startedAt" TIMESTAMPTZ,
    "completedAt" TIMESTAMPTZ,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ,
    "retryDelay" INTEGER NOT NULL DEFAULT 60,
    "exponentialBackoff" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "lifecycleStatus" "ServerLifecycleStatus" NOT NULL DEFAULT 'INVENTORY',
    "powerStatus" "ServerPowerStatus",
    "ipxeBuildTarget" TEXT,
    "ipxeBuildVersion" TEXT,
    "purgeTtys" BOOLEAN,
    "storageLayouts" JSONB NOT NULL DEFAULT '{}',
    "netplanOverride" TEXT,
    "kernelCmdline" TEXT,
    "vpcCapable" BOOLEAN DEFAULT false,
    "teeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "teeCapable" "TeeCapability" NOT NULL DEFAULT 'UNVERIFIED',
    "ecoMode" BOOLEAN NOT NULL DEFAULT false,
    "hourlyPrice" DECIMAL(65,30),
    "floorHourlyPrice" DECIMAL(65,30),
    "isListed" BOOLEAN NOT NULL DEFAULT false,
    "isInterruptible" BOOLEAN NOT NULL DEFAULT false,
    "deviceId" TEXT NOT NULL,
    "configTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SshKeys" (
    "id" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "SshKeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageDrive" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StorageDriveType" NOT NULL,
    "model" TEXT,
    "serial" TEXT,
    "wwn" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "physicalBlockBytes" INTEGER,
    "busPath" TEXT,
    "storageController" TEXT,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageDrive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorefrontSettings" (
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoFileName" TEXT NOT NULL,
    "stylesFileName" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Switch" (
    "id" TEXT NOT NULL,
    "switchRole" TEXT,
    "fabric" TEXT,
    "portCount" INTEGER,
    "powerStatus" "SwitchPowerStatus",
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Switch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "color" TEXT,
    "description" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagAssignment" (
    "tagId" TEXT NOT NULL,
    "objectType" "TagObjectType" NOT NULL,
    "objectId" TEXT NOT NULL,

    CONSTRAINT "TagAssignment_pkey" PRIMARY KEY ("tagId","objectType","objectId")
);

-- CreateTable
CREATE TABLE "UefiBootEntry" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "bootOptionReference" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "uefiDevicePath" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bootOrderIndex" INTEGER,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UefiBootEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "role" TEXT NOT NULL DEFAULT 'user',
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "auth0Id" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "phoneNumber" TEXT,
    "phoneNumberVerified" BOOLEAN DEFAULT false,
    "twoFactorEnabled" BOOLEAN DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "impersonatedBy" TEXT,
    "activeOrganizationId" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "idToken" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secret" TEXT,
    "backupCodes" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TwoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEmailVerificationCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateExpires" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserEmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Whitelist" (
    "id" TEXT NOT NULL,
    "auth0Id" TEXT NOT NULL,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Whitelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "description" TEXT,
    "events" "WebhookEventType"[],
    "secret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventType" "WebhookEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "httpStatus" INTEGER,
    "responseBody" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "processingLockedBy" TEXT,
    "processingLockedAt" TIMESTAMP(3),
    "processingLockExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneRegistrationToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedZonePub" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "ZoneRegistrationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneEnrollment" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "zonePub" BYTEA NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedTokenId" TEXT,

    CONSTRAINT "ZoneEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BridgeHeartbeat" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "isLeader" BOOLEAN NOT NULL,
    "netbirdIp" TEXT NOT NULL,
    "brokkrWorkerVersion" TEXT NOT NULL,
    "brokkrLiveVersion" TEXT NOT NULL,
    "osImageVersion" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BridgeHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceHealthCheck" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "primaryReachable" BOOLEAN,
    "bmcIcmpReachable" BOOLEAN,
    "bmcIpmiReachable" BOOLEAN,
    "bmcRedfishReachable" BOOLEAN,
    "bmcCredsValid" BOOLEAN,
    "poweredOn" BOOLEAN,
    "brokkrLiveRunning" BOOLEAN,
    "testedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneRedisCredential" (
    "zoneId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "ZoneRedisCredential_pkey" PRIMARY KEY ("zoneId")
);

-- CreateTable
CREATE TABLE "ZoneRequest" (
    "id" TEXT NOT NULL,
    "dateApproved" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateDeleted" TIMESTAMP(3),
    "dateUpdated" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "bridgePackage" "BridgePackage" NOT NULL,
    "networkType" "NetworkType" NOT NULL,
    "prefixes" JSONB NOT NULL,
    "organizationId" TEXT NOT NULL,
    "zoneId" TEXT,

    CONSTRAINT "ZoneRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneStatus" (
    "id" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT true,
    "lastOfflineAt" TIMESTAMP(3),
    "lastOnlineAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "ticketId" TEXT,
    "alertSentAt" TIMESTAMP(3),
    "zoneId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uuidSuffix" TEXT,
    "internalName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "networkType" "ZoneNetworkType" NOT NULL DEFAULT 'FLAT',
    "eastWestNetworkType" "ZoneEastWestNetworkType",
    "ipxeBuildTarget" TEXT,
    "ipxeBuildVersion" TEXT,
    "proxyGroup" TEXT,
    "siteProxyIp" TEXT,
    "regionId" TEXT,
    "layerBuildId" TEXT,
    "dnsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dnsUpstreamResolvers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dnsTtlSeconds" INTEGER NOT NULL DEFAULT 60,
    "dnsCacheSize" INTEGER NOT NULL DEFAULT 1000,
    "dnsOwnedDomain" TEXT NOT NULL DEFAULT 'lan',
    "dnsUpstreamTimeoutMs" INTEGER NOT NULL DEFAULT 1000,
    "dnsPollMs" INTEGER NOT NULL DEFAULT 2000,
    "dnsTcpMaxConnections" INTEGER,
    "dnsTcpMaxQueriesPerConn" INTEGER,
    "dnsTcpIdleTimeoutMs" INTEGER,
    "dnsTcpMaxMessageBytes" INTEGER,
    "dnsMaxTtlSeconds" INTEGER,
    "dnsMaxCacheTtlSeconds" INTEGER,
    "dnsMinCacheTtlSeconds" INTEGER,
    "dnsNegTtlSeconds" INTEGER,
    "dhcpLeaderPollMs" INTEGER NOT NULL DEFAULT 2000,
    "dhcpPruneIntervalMs" INTEGER NOT NULL DEFAULT 60000,
    "dhcpDeclineBackoffSeconds" INTEGER NOT NULL DEFAULT 600,
    "vrrpGarpCount" INTEGER NOT NULL DEFAULT 5,
    "colocationId" TEXT,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "ZoneAddress" (
    "id" TEXT NOT NULL,
    "type" "ZoneAddressType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "formattedAddress" TEXT NOT NULL,
    "addressLineOne" TEXT NOT NULL,
    "addressLineTwo" TEXT,
    "city" TEXT NOT NULL,
    "stateOrProvince" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "countryCode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "timezone" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,

    CONSTRAINT "ZoneAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "title" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "contactType" "ZoneContactType",
    "isShippingContact" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "slackLink" TEXT,
    "ticketingPortalUrl" TEXT,
    "website" TEXT,
    "zoneId" TEXT,
    "organizationId" TEXT,
    "manufacturerId" TEXT,
    "facilityId" TEXT,
    "colocationId" TEXT,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactTag" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "group" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ContactToContactTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ContactToContactTag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "AdminLifecycleRequest_deploymentId_idx" ON "AdminLifecycleRequest"("deploymentId");

-- CreateIndex
CREATE INDEX "AdminLifecycleRequest_status_idx" ON "AdminLifecycleRequest"("status");

-- CreateIndex
CREATE INDEX "apikey_userId_idx" ON "apikey"("userId");

-- CreateIndex
CREATE INDEX "apikey_key_idx" ON "apikey"("key");

-- CreateIndex
CREATE INDEX "apikey_organizationId_idx" ON "apikey"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Asn_asn_key" ON "Asn"("asn");

-- CreateIndex
CREATE INDEX "Asn_organizationId_idx" ON "Asn"("organizationId");

-- CreateIndex
CREATE INDEX "VlanGroup_zoneId_idx" ON "VlanGroup"("zoneId");

-- CreateIndex
CREATE INDEX "BgpPeerGroup_organizationId_idx" ON "BgpPeerGroup"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BgpPeerGroup_organizationId_name_key" ON "BgpPeerGroup"("organizationId", "name");

-- CreateIndex
CREATE INDEX "PrefixList_organizationId_idx" ON "PrefixList"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PrefixListRule_prefixListId_sequence_key" ON "PrefixListRule"("prefixListId", "sequence");

-- CreateIndex
CREATE INDEX "BgpSession_deviceId_idx" ON "BgpSession"("deviceId");

-- CreateIndex
CREATE INDEX "BgpSession_peerGroupId_idx" ON "BgpSession"("peerGroupId");

-- CreateIndex
CREATE INDEX "BgpSession_organizationId_idx" ON "BgpSession"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BgpSession_organizationId_name_key" ON "BgpSession"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Bridge_deviceId_key" ON "Bridge"("deviceId");

-- CreateIndex
CREATE INDEX "CableTermination_cableId_idx" ON "CableTermination"("cableId");

-- CreateIndex
CREATE UNIQUE INDEX "CableTermination_cableId_cableSide_key" ON "CableTermination"("cableId", "cableSide");

-- CreateIndex
CREATE UNIQUE INDEX "CableTermination_terminationType_terminationId_key" ON "CableTermination"("terminationType", "terminationId");

-- CreateIndex
CREATE UNIQUE INDEX "Cdu_deviceId_key" ON "Cdu"("deviceId");

-- CreateIndex
CREATE INDEX "Changelog_tableName_idx" ON "Changelog"("tableName");

-- CreateIndex
CREATE INDEX "Changelog_pk_idx" ON "Changelog"("pk");

-- CreateIndex
CREATE INDEX "Changelog_createdAt_idx" ON "Changelog"("createdAt");

-- CreateIndex
CREATE INDEX "Changelog_organizationId_idx" ON "Changelog"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_slug_key" ON "Provider"("slug");

-- CreateIndex
CREATE INDEX "ProviderNetwork_providerId_idx" ON "ProviderNetwork"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderNetwork_providerId_name_key" ON "ProviderNetwork"("providerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CircuitType_slug_key" ON "CircuitType"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Circuit_cid_key" ON "Circuit"("cid");

-- CreateIndex
CREATE INDEX "Circuit_providerId_idx" ON "Circuit"("providerId");

-- CreateIndex
CREATE INDEX "Circuit_circuitTypeId_idx" ON "Circuit"("circuitTypeId");

-- CreateIndex
CREATE INDEX "Circuit_organizationId_idx" ON "Circuit"("organizationId");

-- CreateIndex
CREATE INDEX "Circuit_status_idx" ON "Circuit"("status");

-- CreateIndex
CREATE INDEX "CircuitTermination_circuitId_idx" ON "CircuitTermination"("circuitId");

-- CreateIndex
CREATE INDEX "CircuitTermination_zoneId_idx" ON "CircuitTermination"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "CircuitTermination_circuitId_termSide_key" ON "CircuitTermination"("circuitId", "termSide");

-- CreateIndex
CREATE UNIQUE INDEX "CloudInitTemplate_organizationId_contentHash_key" ON "CloudInitTemplate"("organizationId", "contentHash");

-- CreateIndex
CREATE INDEX "Cluster_organizationId_idx" ON "Cluster"("organizationId");

-- CreateIndex
CREATE INDEX "Cluster_zoneId_idx" ON "Cluster"("zoneId");

-- CreateIndex
CREATE INDEX "ClusterDeployment_clusterId_idx" ON "ClusterDeployment"("clusterId");

-- CreateIndex
CREATE INDEX "ClusterDeployment_deploymentId_idx" ON "ClusterDeployment"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterDeployment_clusterId_deploymentId_key" ON "ClusterDeployment"("clusterId", "deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigTemplate_name_key" ON "ConfigTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigTemplate_purpose_key" ON "ConfigTemplate"("purpose");

-- CreateIndex
CREATE INDEX "ConsolePort_deviceId_idx" ON "ConsolePort"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsolePort_deviceId_name_key" ON "ConsolePort"("deviceId", "name");

-- CreateIndex
CREATE INDEX "ConsoleServerPort_deviceId_idx" ON "ConsoleServerPort"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsoleServerPort_deviceId_name_key" ON "ConsoleServerPort"("deviceId", "name");

-- CreateIndex
CREATE INDEX "Cpu_deviceId_idx" ON "Cpu"("deviceId");

-- CreateIndex
CREATE INDEX "Cpu_model_idx" ON "Cpu"("model");

-- CreateIndex
CREATE UNIQUE INDEX "Cpu_deviceId_socketIndex_key" ON "Cpu"("deviceId", "socketIndex");

-- CreateIndex
CREATE UNIQUE INDEX "DcimRackRole_slug_key" ON "DcimRackRole"("slug");

-- CreateIndex
CREATE INDEX "Deployment_serverId_idx" ON "Deployment"("serverId");

-- CreateIndex
CREATE INDEX "Deployment_baseLayerId_idx" ON "Deployment"("baseLayerId");

-- CreateIndex
CREATE INDEX "Deployment_rescueLayerId_idx" ON "Deployment"("rescueLayerId");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_deploymentId_performedAt_idx" ON "DeploymentLifecycleAction"("deploymentId", "performedAt");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_deploymentId_actionType_idx" ON "DeploymentLifecycleAction"("deploymentId", "actionType");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_deploymentId_actionType_performed_idx" ON "DeploymentLifecycleAction"("deploymentId", "actionType", "performedAt");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_performedBy_performedAt_idx" ON "DeploymentLifecycleAction"("performedBy", "performedAt");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_actionType_performedAt_idx" ON "DeploymentLifecycleAction"("actionType", "performedAt");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_source_actionType_idx" ON "DeploymentLifecycleAction"("source", "actionType");

-- CreateIndex
CREATE INDEX "DeploymentLifecycleAction_performedAt_idx" ON "DeploymentLifecycleAction"("performedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentSshKeys_id_key" ON "DeploymentSshKeys"("id");

-- CreateIndex
CREATE INDEX "DeploymentProject_organizationId_isDefault_idx" ON "DeploymentProject"("organizationId", "isDefault");

-- CreateIndex
CREATE INDEX "DeviceDiagnostics_deploymentId_idx" ON "DeviceDiagnostics"("deploymentId");

-- CreateIndex
CREATE INDEX "DeviceDiagnostics_type_idx" ON "DeviceDiagnostics"("type");

-- CreateIndex
CREATE INDEX "DeviceDocument_deviceId_idx" ON "DeviceDocument"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_slug_key" ON "DeviceModel"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_manufacturer_model_key" ON "DeviceModel"("manufacturer", "model");

-- CreateIndex
CREATE INDEX "DeviceSecretAuditEvent_deviceId_createdAt_idx" ON "DeviceSecretAuditEvent"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceSecretAuditEvent_zoneId_createdAt_idx" ON "DeviceSecretAuditEvent"("zoneId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceSecretAuditEvent_event_createdAt_idx" ON "DeviceSecretAuditEvent"("event", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceSecretAuditEvent_requestId_idx" ON "DeviceSecretAuditEvent"("requestId");

-- CreateIndex
CREATE INDEX "DeviceSecret_deviceId_purpose_idx" ON "DeviceSecret"("deviceId", "purpose");

-- CreateIndex
CREATE INDEX "DeviceSecret_deviceId_purpose_kind_idx" ON "DeviceSecret"("deviceId", "purpose", "kind");

-- CreateIndex
CREATE INDEX "DeviceSecret_zoneId_idx" ON "DeviceSecret"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSecret_deviceId_purpose_version_key" ON "DeviceSecret"("deviceId", "purpose", "version");

-- CreateIndex
CREATE INDEX "DeviceTestRun_deviceId_idx" ON "DeviceTestRun"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceTestRun_deviceMetadataId_idx" ON "DeviceTestRun"("deviceMetadataId");

-- CreateIndex
CREATE INDEX "DeviceTestRun_type_idx" ON "DeviceTestRun"("type");

-- CreateIndex
CREATE INDEX "DeviceTestRun_status_idx" ON "DeviceTestRun"("status");

-- CreateIndex
CREATE INDEX "DeviceTestRun_type_status_deviceId_endTime_idx" ON "DeviceTestRun"("type", "status", "deviceId", "endTime" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_tokenHash_key" ON "DeviceToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceToken_deviceId_context_status_idx" ON "DeviceToken"("deviceId", "context", "status");

-- CreateIndex
CREATE INDEX "DeviceToken_deploymentId_idx" ON "DeviceToken"("deploymentId");

-- CreateIndex
CREATE INDEX "DeviceToken_status_expiresAt_idx" ON "DeviceToken"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "DeviceTokenAuditEvent_tokenId_createdAt_idx" ON "DeviceTokenAuditEvent"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceTokenAuditEvent_event_createdAt_idx" ON "DeviceTokenAuditEvent"("event", "createdAt");

-- CreateIndex
CREATE INDEX "Device_zoneId_idx" ON "Device"("zoneId");

-- CreateIndex
CREATE INDEX "Device_organizationId_idx" ON "Device"("organizationId");

-- CreateIndex
CREATE INDEX "Device_configTemplateId_idx" ON "Device"("configTemplateId");

-- CreateIndex
CREATE INDEX "Device_deletedAt_idx" ON "Device"("deletedAt");

-- CreateIndex
CREATE INDEX "Device_role_idx" ON "Device"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Device_id_zoneId_key" ON "Device"("id", "zoneId");

-- CreateIndex
CREATE INDEX "DeviceMaintenance_deviceId_disabledAt_idx" ON "DeviceMaintenance"("deviceId", "disabledAt");

-- CreateIndex
CREATE INDEX "DiscoveryRun_deviceId_startedAt_idx" ON "DiscoveryRun"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "DiscoveryRun_status_idx" ON "DiscoveryRun"("status");

-- CreateIndex
CREATE INDEX "DiscoveryRun_jobId_idx" ON "DiscoveryRun"("jobId");

-- CreateIndex
CREATE INDEX "DiscoveryRunIssue_runId_idx" ON "DiscoveryRunIssue"("runId");

-- CreateIndex
CREATE INDEX "DiscoveryRunIssue_collector_code_idx" ON "DiscoveryRunIssue"("collector", "code");

-- CreateIndex
CREATE INDEX "DiscoveryRunIssue_severity_createdAt_idx" ON "DiscoveryRunIssue"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "DnsDomain_zoneId_idx" ON "DnsDomain"("zoneId");

-- CreateIndex
CREATE INDEX "DnsRecord_domainId_idx" ON "DnsRecord"("domainId");

-- CreateIndex
CREATE INDEX "DnsRecord_deviceId_idx" ON "DnsRecord"("deviceId");

-- CreateIndex
CREATE INDEX "DnsRecord_ipAddressId_idx" ON "DnsRecord"("ipAddressId");

-- CreateIndex
CREATE INDEX "EventLog_org_createdAt_id_desc_idx" ON "EventLog"("organizationId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "EventLog_org_createdAt_id_asc_idx" ON "EventLog"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "EventLog_organizationId_actorId_createdAt_id_idx" ON "EventLog"("organizationId", "actorId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "EventLog_organizationId_actionKey_createdAt_id_idx" ON "EventLog"("organizationId", "actionKey", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "EventLog_organizationId_resource_targetId_createdAt_id_idx" ON "EventLog"("organizationId", "resource", "targetId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EventLogAccessBucket_organizationId_actorKey_hourBucket_key" ON "EventLogAccessBucket"("organizationId", "actorKey", "hourBucket");

-- CreateIndex
CREATE INDEX "Colocation_facilityId_idx" ON "Colocation"("facilityId");

-- CreateIndex
CREATE INDEX "DeviceFirmware_deviceId_idx" ON "DeviceFirmware"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceFirmware_type_version_idx" ON "DeviceFirmware"("type", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceFirmware_deviceId_type_key" ON "DeviceFirmware"("deviceId", "type");

-- CreateIndex
CREATE INDEX "Gateway_vrfId_idx" ON "Gateway"("vrfId");

-- CreateIndex
CREATE INDEX "Gateway_gatewayIpId_idx" ON "Gateway"("gatewayIpId");

-- CreateIndex
CREATE INDEX "Gateway_prefixId_idx" ON "Gateway"("prefixId");

-- CreateIndex
CREATE INDEX "Gpu_deviceId_idx" ON "Gpu"("deviceId");

-- CreateIndex
CREATE INDEX "Gpu_model_idx" ON "Gpu"("model");

-- CreateIndex
CREATE INDEX "Gpu_serial_idx" ON "Gpu"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "Gpu_deviceId_index_key" ON "Gpu"("deviceId", "index");

-- CreateIndex
CREATE INDEX "Interface_deviceId_idx" ON "Interface"("deviceId");

-- CreateIndex
CREATE INDEX "Interface_lagId_idx" ON "Interface"("lagId");

-- CreateIndex
CREATE INDEX "Interface_parentId_idx" ON "Interface"("parentId");

-- CreateIndex
CREATE INDEX "InterruptibleClaim_serverId_idx" ON "InterruptibleClaim"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "IpamPrefixVlanRole_slug_key" ON "IpamPrefixVlanRole"("slug");

-- CreateIndex
CREATE INDEX "Vrf_organizationId_name_idx" ON "Vrf"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Vrf_organizationId_rd_idx" ON "Vrf"("organizationId", "rd");

-- CreateIndex
CREATE INDEX "Vrf_organizationId_idx" ON "Vrf"("organizationId");

-- CreateIndex
CREATE INDEX "Prefix_vrfId_prefix_idx" ON "Prefix"("vrfId", "prefix");

-- CreateIndex
CREATE INDEX "Prefix_organizationId_idx" ON "Prefix"("organizationId");

-- CreateIndex
CREATE INDEX "Prefix_vrfId_idx" ON "Prefix"("vrfId");

-- CreateIndex
CREATE INDEX "Prefix_parentId_idx" ON "Prefix"("parentId");

-- CreateIndex
CREATE INDEX "Prefix_vlanId_idx" ON "Prefix"("vlanId");

-- CreateIndex
CREATE INDEX "Prefix_gatewayIpId_idx" ON "Prefix"("gatewayIpId");

-- CreateIndex
CREATE INDEX "Prefix_vrrpVipId_idx" ON "Prefix"("vrrpVipId");

-- CreateIndex
CREATE INDEX "Prefix_zoneId_idx" ON "Prefix"("zoneId");

-- CreateIndex
CREATE INDEX "Prefix_status_idx" ON "Prefix"("status");

-- CreateIndex
CREATE INDEX "Prefix_isPool_idx" ON "Prefix"("isPool");

-- CreateIndex
CREATE INDEX "Prefix_associatedPrefixId_idx" ON "Prefix"("associatedPrefixId");

-- CreateIndex
CREATE INDEX "Prefix_prefixRoleId_idx" ON "Prefix"("prefixRoleId");

-- CreateIndex
CREATE INDEX "IpAddress_vrfId_address_idx" ON "IpAddress"("vrfId", "address");

-- CreateIndex
CREATE INDEX "IpAddress_organizationId_idx" ON "IpAddress"("organizationId");

-- CreateIndex
CREATE INDEX "IpAddress_vrfId_idx" ON "IpAddress"("vrfId");

-- CreateIndex
CREATE INDEX "IpAddress_status_idx" ON "IpAddress"("status");

-- CreateIndex
CREATE INDEX "IpAddress_dnsName_idx" ON "IpAddress"("dnsName");

-- CreateIndex
CREATE INDEX "IpAddress_assignedObjectType_assignedObjectId_idx" ON "IpAddress"("assignedObjectType", "assignedObjectId");

-- CreateIndex
CREATE INDEX "IpAddress_interfaceId_idx" ON "IpAddress"("interfaceId");

-- CreateIndex
CREATE INDEX "IpAddress_natInsideId_idx" ON "IpAddress"("natInsideId");

-- CreateIndex
CREATE INDEX "Vlan_organizationId_idx" ON "Vlan"("organizationId");

-- CreateIndex
CREATE INDEX "Vlan_vrfId_idx" ON "Vlan"("vrfId");

-- CreateIndex
CREATE INDEX "Vlan_zoneId_idx" ON "Vlan"("zoneId");

-- CreateIndex
CREATE INDEX "Vlan_vlanGroupId_idx" ON "Vlan"("vlanGroupId");

-- CreateIndex
CREATE INDEX "Vlan_status_idx" ON "Vlan"("status");

-- CreateIndex
CREATE INDEX "Vlan_organizationId_vrfId_vid_idx" ON "Vlan"("organizationId", "vrfId", "vid");

-- CreateIndex
CREATE INDEX "IpRange_organizationId_idx" ON "IpRange"("organizationId");

-- CreateIndex
CREATE INDEX "IpRange_prefixId_idx" ON "IpRange"("prefixId");

-- CreateIndex
CREATE INDEX "IpRange_vrfId_idx" ON "IpRange"("vrfId");

-- CreateIndex
CREATE INDEX "IpRange_zoneId_idx" ON "IpRange"("zoneId");

-- CreateIndex
CREATE INDEX "IpRange_status_idx" ON "IpRange"("status");

-- CreateIndex
CREATE INDEX "IpRange_start_end_idx" ON "IpRange"("start", "end");

-- CreateIndex
CREATE INDEX "PrefixVrrpBinding_bridgeId_idx" ON "PrefixVrrpBinding"("bridgeId");

-- CreateIndex
CREATE UNIQUE INDEX "PrefixVrrpBinding_prefixId_bridgeId_key" ON "PrefixVrrpBinding"("prefixId", "bridgeId");

-- CreateIndex
CREATE INDEX "LayerBuild_status_idx" ON "LayerBuild"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LayerBuild_version_env_key" ON "LayerBuild"("version", "env");

-- CreateIndex
CREATE UNIQUE INDEX "LayerGroup_slug_key" ON "LayerGroup"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Layer_slug_key" ON "Layer"("slug");

-- CreateIndex
CREATE INDEX "LayerArtifact_layerBuildId_osDistro_osCodename_arch_idx" ON "LayerArtifact"("layerBuildId", "osDistro", "osCodename", "arch");

-- CreateIndex
CREATE INDEX "LayerArtifact_layerId_idx" ON "LayerArtifact"("layerId");

-- CreateIndex
CREATE UNIQUE INDEX "LayerArtifact_layerBuildId_sha256_key" ON "LayerArtifact"("layerBuildId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "LayerArtifact_build_slot_key" ON "LayerArtifact"("layerBuildId", "layerId", "osDistro", "osCodename", "arch", "variant");

-- CreateIndex
CREATE INDEX "LayerRelation_relatedLayerId_idx" ON "LayerRelation"("relatedLayerId");

-- CreateIndex
CREATE INDEX "DeploymentLayer_layerArtifactId_idx" ON "DeploymentLayer"("layerArtifactId");

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleJob_linkedJobId_key" ON "LifecycleJob"("linkedJobId");

-- CreateIndex
CREATE INDEX "LifecycleJob_phase_idx" ON "LifecycleJob"("phase");

-- CreateIndex
CREATE INDEX "LifecycleJob_deviceId_createdAt_idx" ON "LifecycleJob"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "LifecycleJob_deploymentId_idx" ON "LifecycleJob"("deploymentId");

-- CreateIndex
CREATE INDEX "LifecycleJobEvent_jobId_recordedAt_idx" ON "LifecycleJobEvent"("jobId", "recordedAt");

-- CreateIndex
CREATE INDEX "LifecycleJobEvent_jobId_sagaName_idx" ON "LifecycleJobEvent"("jobId", "sagaName");

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleJobEvent_dedupe_key" ON "LifecycleJobEvent"("jobId", "sagaName", "stepName", "eventType", "status", "attempt", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Manufacturer_name_key" ON "Manufacturer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Manufacturer_slug_key" ON "Manufacturer"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryConfig_deviceId_key" ON "MemoryConfig"("deviceId");

-- CreateIndex
CREATE INDEX "NvlinkEdge_deviceId_idx" ON "NvlinkEdge"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "NvlinkEdge_deviceId_sourceGpuIndex_targetGpuIndex_key" ON "NvlinkEdge"("deviceId", "sourceGpuIndex", "targetGpuIndex");

-- CreateIndex
CREATE INDEX "Member_userId_idx" ON "Member"("userId");

-- CreateIndex
CREATE INDEX "Member_organizationId_idx" ON "Member"("organizationId");

-- CreateIndex
CREATE INDEX "Member_assignedRoleId_idx" ON "Member"("assignedRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_userId_organizationId_key" ON "Member"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "Invitation_assignedRoleId_idx" ON "Invitation"("assignedRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembershipInvitation_email_organizationId_key" ON "OrganizationMembershipInvitation"("email", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationApiKey_value_key" ON "OrganizationApiKey"("value");

-- CreateIndex
CREATE INDEX "OrganizationApiKey_organizationId_idx" ON "OrganizationApiKey"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationSiteContact_organizationId_idx" ON "OrganizationSiteContact"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PatchPanel_deviceId_key" ON "PatchPanel"("deviceId");

-- CreateIndex
CREATE INDEX "FrontPort_deviceId_idx" ON "FrontPort"("deviceId");

-- CreateIndex
CREATE INDEX "FrontPort_rearPortId_idx" ON "FrontPort"("rearPortId");

-- CreateIndex
CREATE UNIQUE INDEX "FrontPort_deviceId_name_key" ON "FrontPort"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "FrontPort_rearPortId_rearPortPosition_key" ON "FrontPort"("rearPortId", "rearPortPosition");

-- CreateIndex
CREATE INDEX "RearPort_deviceId_idx" ON "RearPort"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "RearPort_deviceId_name_key" ON "RearPort"("deviceId", "name");

-- CreateIndex
CREATE INDEX "PciDevice_deviceId_idx" ON "PciDevice"("deviceId");

-- CreateIndex
CREATE INDEX "PciDevice_vendorId_productId_idx" ON "PciDevice"("vendorId", "productId");

-- CreateIndex
CREATE INDEX "PciDevice_className_idx" ON "PciDevice"("className");

-- CreateIndex
CREATE UNIQUE INDEX "PciDevice_deviceId_address_key" ON "PciDevice"("deviceId", "address");

-- CreateIndex
CREATE UNIQUE INDEX "Pdu_deviceId_key" ON "Pdu"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_resource_action_key" ON "Permission"("resource", "action");

-- CreateIndex
CREATE INDEX "OrganizationMemberRole_organizationId_idx" ON "OrganizationMemberRole"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMemberRole_slug_organizationId_key" ON "OrganizationMemberRole"("slug", "organizationId");

-- CreateIndex
CREATE INDEX "RolePermission_roleId_idx" ON "RolePermission"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "PowerPort_deviceId_idx" ON "PowerPort"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PowerPort_deviceId_name_key" ON "PowerPort"("deviceId", "name");

-- CreateIndex
CREATE INDEX "PowerOutlet_deviceId_idx" ON "PowerOutlet"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PowerOutlet_deviceId_name_key" ON "PowerOutlet"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RackBrush_deviceId_key" ON "RackBrush"("deviceId");

-- CreateIndex
CREATE INDEX "Rack_zoneId_idx" ON "Rack"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "Rack_zoneId_name_key" ON "Rack"("zoneId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceRackAssignment_deviceId_key" ON "DeviceRackAssignment"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceRackAssignment_rackId_idx" ON "DeviceRackAssignment"("rackId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceRackAssignment_rackId_position_face_key" ON "DeviceRackAssignment"("rackId", "position", "face");

-- CreateIndex
CREATE UNIQUE INDEX "Region_name_key" ON "Region"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Region_slug_key" ON "Region"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationInvite_reservationId_key" ON "ReservationInvite"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "ServersInReservation_id_key" ON "ServersInReservation"("id");

-- CreateIndex
CREATE UNIQUE INDEX "Router_deviceId_key" ON "Router"("deviceId");

-- CreateIndex
CREATE INDEX "sanitization_reports_jobId_idx" ON "sanitization_reports"("jobId");

-- CreateIndex
CREATE INDEX "sanitization_reports_actionType_idx" ON "sanitization_reports"("actionType");

-- CreateIndex
CREATE UNIQUE INDEX "sanitization_reports_deviceId_jobId_key" ON "sanitization_reports"("deviceId", "jobId");

-- CreateIndex
CREATE INDEX "idx_scheduled_jobs_scheduled_status" ON "ScheduledJob"("scheduledAt", "status");

-- CreateIndex
CREATE INDEX "idx_scheduled_jobs_queue_priority" ON "ScheduledJob"("queue", "priority", "scheduledAt");

-- CreateIndex
CREATE INDEX "idx_scheduled_jobs_locked_by" ON "ScheduledJob"("lockedBy");

-- CreateIndex
CREATE INDEX "idx_scheduled_jobs_lock_expires" ON "ScheduledJob"("lockExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Server_deviceId_key" ON "Server"("deviceId");

-- CreateIndex
CREATE INDEX "Server_configTemplateId_idx" ON "Server"("configTemplateId");

-- CreateIndex
CREATE INDEX "StorageDrive_deviceId_idx" ON "StorageDrive"("deviceId");

-- CreateIndex
CREATE INDEX "StorageDrive_serial_idx" ON "StorageDrive"("serial");

-- CreateIndex
CREATE INDEX "StorageDrive_type_idx" ON "StorageDrive"("type");

-- CreateIndex
CREATE UNIQUE INDEX "StorageDrive_deviceId_name_key" ON "StorageDrive"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontSettings_organizationId_key" ON "StorefrontSettings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontSettings_slug_key" ON "StorefrontSettings"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Switch_deviceId_key" ON "Switch"("deviceId");

-- CreateIndex
CREATE INDEX "Tag_organizationId_idx" ON "Tag"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_name_key" ON "Tag"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_slug_key" ON "Tag"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "TagAssignment_objectType_objectId_idx" ON "TagAssignment"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "UefiBootEntry_deviceId_idx" ON "UefiBootEntry"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "UefiBootEntry_deviceId_bootOptionReference_key" ON "UefiBootEntry"("deviceId", "bootOptionReference");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_auth0Id_key" ON "User"("auth0Id");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Account_accountId_idx" ON "Account"("accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactor_userId_key" ON "TwoFactor"("userId");

-- CreateIndex
CREATE INDEX "TwoFactor_userId_idx" ON "TwoFactor"("userId");

-- CreateIndex
CREATE INDEX "TwoFactor_secret_idx" ON "TwoFactor"("secret");

-- CreateIndex
CREATE UNIQUE INDEX "Whitelist_auth0Id_key" ON "Whitelist"("auth0Id");

-- CreateIndex
CREATE INDEX "Webhook_organizationId_idx" ON "Webhook"("organizationId");

-- CreateIndex
CREATE INDEX "Webhook_isActive_idx" ON "Webhook"("isActive");

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_idx" ON "WebhookDelivery"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");

-- CreateIndex
CREATE INDEX "WebhookDelivery_nextRetryAt_idx" ON "WebhookDelivery"("nextRetryAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_createdAt_idx" ON "WebhookDelivery"("createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_processingLockedBy_idx" ON "WebhookDelivery"("processingLockedBy");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_webhookId_idempotencyKey_key" ON "WebhookDelivery"("webhookId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneRegistrationToken_tokenHash_key" ON "ZoneRegistrationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ZoneRegistrationToken_zoneId_idx" ON "ZoneRegistrationToken"("zoneId");

-- CreateIndex
CREATE INDEX "ZoneRegistrationToken_expiresAt_idx" ON "ZoneRegistrationToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneEnrollment_zoneId_key" ON "ZoneEnrollment"("zoneId");

-- CreateIndex
CREATE INDEX "BridgeHeartbeat_zoneId_receivedAt_idx" ON "BridgeHeartbeat"("zoneId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "BridgeHeartbeat_instanceId_receivedAt_idx" ON "BridgeHeartbeat"("instanceId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "BridgeHeartbeat_receivedAt_idx" ON "BridgeHeartbeat"("receivedAt");

-- CreateIndex
CREATE INDEX "DeviceHealthCheck_deviceId_testedAt_idx" ON "DeviceHealthCheck"("deviceId", "testedAt" DESC);

-- CreateIndex
CREATE INDEX "DeviceHealthCheck_testedAt_idx" ON "DeviceHealthCheck"("testedAt");

-- CreateIndex
CREATE INDEX "DeviceHealthCheck_deviceId_primaryReachable_idx" ON "DeviceHealthCheck"("deviceId", "primaryReachable");

-- CreateIndex
CREATE INDEX "ZoneRequest_organizationId_idx" ON "ZoneRequest"("organizationId");

-- CreateIndex
CREATE INDEX "ZoneRequest_zoneId_idx" ON "ZoneRequest"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneStatus_zoneId_key" ON "ZoneStatus"("zoneId");

-- CreateIndex
CREATE INDEX "ZoneStatus_zoneId_isOnline_idx" ON "ZoneStatus"("zoneId", "isOnline");

-- CreateIndex
CREATE INDEX "ZoneStatus_lastHeartbeatAt_idx" ON "ZoneStatus"("lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_uuidSuffix_key" ON "Zone"("uuidSuffix");

-- CreateIndex
CREATE INDEX "Zone_organizationId_idx" ON "Zone"("organizationId");

-- CreateIndex
CREATE INDEX "Zone_colocationId_idx" ON "Zone"("colocationId");

-- CreateIndex
CREATE INDEX "ZoneMaintenance_zoneId_disabledAt_idx" ON "ZoneMaintenance"("zoneId", "disabledAt");

-- CreateIndex
CREATE INDEX "ZoneAddress_zoneId_idx" ON "ZoneAddress"("zoneId");

-- CreateIndex
CREATE INDEX "Contact_zoneId_idx" ON "Contact"("zoneId");

-- CreateIndex
CREATE INDEX "Contact_organizationId_idx" ON "Contact"("organizationId");

-- CreateIndex
CREATE INDEX "Contact_manufacturerId_idx" ON "Contact"("manufacturerId");

-- CreateIndex
CREATE INDEX "Contact_facilityId_idx" ON "Contact"("facilityId");

-- CreateIndex
CREATE INDEX "Contact_colocationId_idx" ON "Contact"("colocationId");

-- CreateIndex
CREATE INDEX "_ContactToContactTag_B_index" ON "_ContactToContactTag"("B");

-- AddForeignKey
ALTER TABLE "AdminLifecycleRequest" ADD CONSTRAINT "AdminLifecycleRequest_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminLifecycleRequest" ADD CONSTRAINT "AdminLifecycleRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminLifecycleRequest" ADD CONSTRAINT "AdminLifecycleRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asn" ADD CONSTRAINT "Asn_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VlanGroup" ADD CONSTRAINT "VlanGroup_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpPeerGroup" ADD CONSTRAINT "BgpPeerGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrefixList" ADD CONSTRAINT "PrefixList_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrefixListRule" ADD CONSTRAINT "PrefixListRule_prefixListId_fkey" FOREIGN KEY ("prefixListId") REFERENCES "PrefixList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_localAsnId_fkey" FOREIGN KEY ("localAsnId") REFERENCES "Asn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_remoteAsnId_fkey" FOREIGN KEY ("remoteAsnId") REFERENCES "Asn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_localAddressId_fkey" FOREIGN KEY ("localAddressId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_remoteAddressId_fkey" FOREIGN KEY ("remoteAddressId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_peerGroupId_fkey" FOREIGN KEY ("peerGroupId") REFERENCES "BgpPeerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_prefixListInId_fkey" FOREIGN KEY ("prefixListInId") REFERENCES "PrefixList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_prefixListOutId_fkey" FOREIGN KEY ("prefixListOutId") REFERENCES "PrefixList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpSession" ADD CONSTRAINT "BgpSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bridge" ADD CONSTRAINT "Bridge_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CableTermination" ADD CONSTRAINT "CableTermination_cableId_fkey" FOREIGN KEY ("cableId") REFERENCES "Cable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cdu" ADD CONSTRAINT "Cdu_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderNetwork" ADD CONSTRAINT "ProviderNetwork_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Circuit" ADD CONSTRAINT "Circuit_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Circuit" ADD CONSTRAINT "Circuit_circuitTypeId_fkey" FOREIGN KEY ("circuitTypeId") REFERENCES "CircuitType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Circuit" ADD CONSTRAINT "Circuit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircuitTermination" ADD CONSTRAINT "CircuitTermination_circuitId_fkey" FOREIGN KEY ("circuitId") REFERENCES "Circuit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircuitTermination" ADD CONSTRAINT "CircuitTermination_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudInitTemplate" ADD CONSTRAINT "CloudInitTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudInitTemplate" ADD CONSTRAINT "CloudInitTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterDeployment" ADD CONSTRAINT "ClusterDeployment_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterDeployment" ADD CONSTRAINT "ClusterDeployment_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsolePort" ADD CONSTRAINT "ConsolePort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsoleServerPort" ADD CONSTRAINT "ConsoleServerPort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cpu" ADD CONSTRAINT "Cpu_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_publicIpAddressId_fkey" FOREIGN KEY ("publicIpAddressId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_privateIpAddressId_fkey" FOREIGN KEY ("privateIpAddressId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deployerId_fkey" FOREIGN KEY ("deployerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_baseLayerId_fkey" FOREIGN KEY ("baseLayerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_rescueLayerId_fkey" FOREIGN KEY ("rescueLayerId") REFERENCES "Layer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deploymentProjectId_fkey" FOREIGN KEY ("deploymentProjectId") REFERENCES "DeploymentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLifecycleAction" ADD CONSTRAINT "DeploymentLifecycleAction_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLifecycleAction" ADD CONSTRAINT "DeploymentLifecycleAction_performedBy_fkey" FOREIGN KEY ("performedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentSshKeys" ADD CONSTRAINT "DeploymentSshKeys_sshKeyId_fkey" FOREIGN KEY ("sshKeyId") REFERENCES "SshKeys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentSshKeys" ADD CONSTRAINT "DeploymentSshKeys_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentProject" ADD CONSTRAINT "DeploymentProject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceDiagnostics" ADD CONSTRAINT "DeviceDiagnostics_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceDocument" ADD CONSTRAINT "DeviceDocument_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceDocument" ADD CONSTRAINT "DeviceDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSecret" ADD CONSTRAINT "DeviceSecret_deviceId_zoneId_fkey" FOREIGN KEY ("deviceId", "zoneId") REFERENCES "Device"("id", "zoneId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeviceSecret" ADD CONSTRAINT "DeviceSecret_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSolConfig" ADD CONSTRAINT "DeviceSolConfig_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceTestRun" ADD CONSTRAINT "DeviceTestRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceTokenAuditEvent" ADD CONSTRAINT "DeviceTokenAuditEvent_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "DeviceToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "SupplierSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_configTemplateId_fkey" FOREIGN KEY ("configTemplateId") REFERENCES "ConfigTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMaintenance" ADD CONSTRAINT "DeviceMaintenance_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRunIssue" ADD CONSTRAINT "DiscoveryRunIssue_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsDomain" ADD CONSTRAINT "DnsDomain_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRecord" ADD CONSTRAINT "DnsRecord_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "DnsDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRecord" ADD CONSTRAINT "DnsRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRecord" ADD CONSTRAINT "DnsRecord_ipAddressId_fkey" FOREIGN KEY ("ipAddressId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Colocation" ADD CONSTRAINT "Colocation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceFirmware" ADD CONSTRAINT "DeviceFirmware_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_gatewayIpId_fkey" FOREIGN KEY ("gatewayIpId") REFERENCES "IpAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_prefixId_fkey" FOREIGN KEY ("prefixId") REFERENCES "Prefix"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gpu" ADD CONSTRAINT "Gpu_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interface" ADD CONSTRAINT "Interface_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interface" ADD CONSTRAINT "Interface_lagId_fkey" FOREIGN KEY ("lagId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interface" ADD CONSTRAINT "Interface_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interface" ADD CONSTRAINT "Interface_untaggedVlanId_fkey" FOREIGN KEY ("untaggedVlanId") REFERENCES "Vlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vrf" ADD CONSTRAINT "Vrf_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Prefix"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_vlanId_fkey" FOREIGN KEY ("vlanId") REFERENCES "Vlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_gatewayIpId_fkey" FOREIGN KEY ("gatewayIpId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_vrrpVipId_fkey" FOREIGN KEY ("vrrpVipId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_associatedPrefixId_fkey" FOREIGN KEY ("associatedPrefixId") REFERENCES "Prefix"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_prefixRoleId_fkey" FOREIGN KEY ("prefixRoleId") REFERENCES "IpamPrefixVlanRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_natInsideId_fkey" FOREIGN KEY ("natInsideId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_vlanGroupId_fkey" FOREIGN KEY ("vlanGroupId") REFERENCES "VlanGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_prefixId_fkey" FOREIGN KEY ("prefixId") REFERENCES "Prefix"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_vrfId_fkey" FOREIGN KEY ("vrfId") REFERENCES "Vrf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrefixVrrpBinding" ADD CONSTRAINT "PrefixVrrpBinding_prefixId_fkey" FOREIGN KEY ("prefixId") REFERENCES "Prefix"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrefixVrrpBinding" ADD CONSTRAINT "PrefixVrrpBinding_bridgeId_fkey" FOREIGN KEY ("bridgeId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayerBuild" ADD CONSTRAINT "LayerBuild_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_defaultLayerBuildId_fkey" FOREIGN KEY ("defaultLayerBuildId") REFERENCES "LayerBuild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Layer" ADD CONSTRAINT "Layer_layerGroupId_fkey" FOREIGN KEY ("layerGroupId") REFERENCES "LayerGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayerArtifact" ADD CONSTRAINT "LayerArtifact_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "Layer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayerArtifact" ADD CONSTRAINT "LayerArtifact_layerBuildId_fkey" FOREIGN KEY ("layerBuildId") REFERENCES "LayerBuild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayerRelation" ADD CONSTRAINT "LayerRelation_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "LayerArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayerRelation" ADD CONSTRAINT "LayerRelation_relatedLayerId_fkey" FOREIGN KEY ("relatedLayerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLayer" ADD CONSTRAINT "DeploymentLayer_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLayer" ADD CONSTRAINT "DeploymentLayer_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "Layer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLayer" ADD CONSTRAINT "DeploymentLayer_layerArtifactId_fkey" FOREIGN KEY ("layerArtifactId") REFERENCES "LayerArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleJob" ADD CONSTRAINT "LifecycleJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleJob" ADD CONSTRAINT "LifecycleJob_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleJobEvent" ADD CONSTRAINT "LifecycleJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "LifecycleJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryConfig" ADD CONSTRAINT "MemoryConfig_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvlinkEdge" ADD CONSTRAINT "NvlinkEdge_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_assignedRoleId_fkey" FOREIGN KEY ("assignedRoleId") REFERENCES "OrganizationMemberRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_assignedRoleId_fkey" FOREIGN KEY ("assignedRoleId") REFERENCES "OrganizationMemberRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembershipInvitation" ADD CONSTRAINT "OrganizationMembershipInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembershipInvitation" ADD CONSTRAINT "OrganizationMembershipInvitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationApiKey" ADD CONSTRAINT "OrganizationApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationApiKey" ADD CONSTRAINT "OrganizationApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSiteContact" ADD CONSTRAINT "OrganizationSiteContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchPanel" ADD CONSTRAINT "PatchPanel_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrontPort" ADD CONSTRAINT "FrontPort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrontPort" ADD CONSTRAINT "FrontPort_rearPortId_fkey" FOREIGN KEY ("rearPortId") REFERENCES "RearPort"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RearPort" ADD CONSTRAINT "RearPort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PciDevice" ADD CONSTRAINT "PciDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pdu" ADD CONSTRAINT "Pdu_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMemberRole" ADD CONSTRAINT "OrganizationMemberRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMemberRole" ADD CONSTRAINT "OrganizationMemberRole_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrganizationMemberRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "OrganizationMemberRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PowerPort" ADD CONSTRAINT "PowerPort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PowerOutlet" ADD CONSTRAINT "PowerOutlet_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RackBrush" ADD CONSTRAINT "RackBrush_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRackAssignment" ADD CONSTRAINT "DeviceRackAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRackAssignment" ADD CONSTRAINT "DeviceRackAssignment_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "Rack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationInvite" ADD CONSTRAINT "ReservationInvite_inviteeOrganizationId_fkey" FOREIGN KEY ("inviteeOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationInvite" ADD CONSTRAINT "ReservationInvite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationInvite" ADD CONSTRAINT "ReservationInvite_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServersInReservationInvite" ADD CONSTRAINT "ServersInReservationInvite_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServersInReservationInvite" ADD CONSTRAINT "ServersInReservationInvite_reservationInviteId_fkey" FOREIGN KEY ("reservationInviteId") REFERENCES "ReservationInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_reserverId_fkey" FOREIGN KEY ("reserverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServersInReservation" ADD CONSTRAINT "ServersInReservation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServersInReservation" ADD CONSTRAINT "ServersInReservation_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Router" ADD CONSTRAINT "Router_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sanitization_reports" ADD CONSTRAINT "sanitization_reports_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_configTemplateId_fkey" FOREIGN KEY ("configTemplateId") REFERENCES "ConfigTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SshKeys" ADD CONSTRAINT "SshKeys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageDrive" ADD CONSTRAINT "StorageDrive_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorefrontSettings" ADD CONSTRAINT "StorefrontSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Switch" ADD CONSTRAINT "Switch_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagAssignment" ADD CONSTRAINT "TagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UefiBootEntry" ADD CONSTRAINT "UefiBootEntry_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_activeOrganizationId_fkey" FOREIGN KEY ("activeOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactor" ADD CONSTRAINT "TwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmailVerificationCode" ADD CONSTRAINT "UserEmailVerificationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRegistrationToken" ADD CONSTRAINT "ZoneRegistrationToken_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRegistrationToken" ADD CONSTRAINT "ZoneRegistrationToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneEnrollment" ADD CONSTRAINT "ZoneEnrollment_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeHeartbeat" ADD CONSTRAINT "BridgeHeartbeat_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceHealthCheck" ADD CONSTRAINT "DeviceHealthCheck_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRedisCredential" ADD CONSTRAINT "ZoneRedisCredential_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRequest" ADD CONSTRAINT "ZoneRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRequest" ADD CONSTRAINT "ZoneRequest_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneStatus" ADD CONSTRAINT "ZoneStatus_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_layerBuildId_fkey" FOREIGN KEY ("layerBuildId") REFERENCES "LayerBuild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_colocationId_fkey" FOREIGN KEY ("colocationId") REFERENCES "Colocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneMaintenance" ADD CONSTRAINT "ZoneMaintenance_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneAddress" ADD CONSTRAINT "ZoneAddress_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_colocationId_fkey" FOREIGN KEY ("colocationId") REFERENCES "Colocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContactToContactTag" ADD CONSTRAINT "_ContactToContactTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContactToContactTag" ADD CONSTRAINT "_ContactToContactTag_B_fkey" FOREIGN KEY ("B") REFERENCES "ContactTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Functions
CREATE OR REPLACE FUNCTION public.block_device_role_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.role IS NOT NULL
     AND NEW.role IS DISTINCT FROM OLD.role
     AND NOT (OLD.role::text = 'Server' AND NEW.role::text = 'DiscoveredHost') THEN
    RAISE EXCEPTION
      'Device.role is write-once: cannot change role of device % from % to % (only the Server->DiscoveredHost re-onboarding transition is permitted). Disable trigger device_role_write_once to override manually.',
      OLD.id, OLD.role, NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.changelog_trigger_func()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_old_data jsonb;
    v_new_data jsonb;
    v_diff jsonb;
    v_pk_value TEXT;
    v_diff_keys text[];
BEGIN
    IF (TG_OP = 'UPDATE') THEN
        v_old_data := row_to_json(OLD)::jsonb;
        v_new_data := row_to_json(NEW)::jsonb;
        v_diff := json_diff(v_new_data, v_old_data);

        -- Extract primary key (assuming 'id' field exists)
        v_pk_value := COALESCE((v_old_data->>'id'), 'unknown');

        IF(v_diff = '{}' OR v_diff IS NULL) THEN
            -- Nothing has been changed
            RETURN NULL;
        END IF;

        -- Check if only updatedAt changed
        v_diff_keys := ARRAY(SELECT jsonb_object_keys(v_diff));

        IF array_length(v_diff_keys, 1) = 1 AND v_diff_keys[1] = 'updatedAt' THEN
            -- Only updatedAt changed, skip logging
            RETURN NULL;
        END IF;

        -- Log the change
        INSERT INTO "Changelog" ("id", "tableName", "pk", "before", "after", "diff", "createdAt")
        VALUES (
            gen_random_uuid(),
            TG_TABLE_NAME::TEXT,
            v_pk_value::UUID,
            v_old_data,
            v_new_data,
            v_diff,
            CURRENT_TIMESTAMP
        );
        RETURN NEW;

    ELSIF (TG_OP = 'DELETE') THEN
        v_old_data := row_to_json(OLD)::jsonb;
        v_pk_value := COALESCE((v_old_data->>'id'), 'unknown');

        INSERT INTO "Changelog" ("id", "tableName", "pk", "before", "after", "diff", "createdAt")
        VALUES (
            gen_random_uuid(),
            TG_TABLE_NAME::TEXT,
            v_pk_value::UUID,
            v_old_data,
            '{}'::jsonb,  -- Empty after for deletes
            v_old_data,   -- Full old data as diff for deletes
            CURRENT_TIMESTAMP
        );
        RETURN OLD;

    ELSIF (TG_OP = 'INSERT') THEN
        v_new_data := row_to_json(NEW)::jsonb;
        v_pk_value := COALESCE((v_new_data->>'id'), 'unknown');

        INSERT INTO "Changelog" ("id", "tableName", "pk", "before", "after", "diff", "createdAt")
        VALUES (
            gen_random_uuid(),
            TG_TABLE_NAME::TEXT,
            v_pk_value::UUID,
            '{}'::jsonb,  -- Empty before for inserts
            v_new_data,
            v_new_data,   -- Full new data as diff for inserts
            CURRENT_TIMESTAMP
        );
        RETURN NEW;

    ELSE
        RAISE WARNING '[CHANGELOG_TRIGGER_FUNC] - Other action occurred: %, at %', TG_OP, now();
        RETURN NULL;
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.json_diff(l jsonb, r jsonb)
 RETURNS jsonb
 LANGUAGE sql
AS $function$
    SELECT jsonb_object_agg(a.key, a.value) 
    FROM (
        SELECT key, value FROM jsonb_each(l) 
    ) a 
    LEFT OUTER JOIN (
        SELECT key, value FROM jsonb_each(r) 
    ) b ON a.key = b.key
    WHERE a.value != b.value OR b.key IS NULL;
$function$
;

-- Partial, expression, and gist indexes Prisma cannot express
CREATE UNIQUE INDEX "BgpPeerGroup_global_name_key" ON public."BgpPeerGroup" USING btree (name) WHERE ("organizationId" IS NULL);
CREATE UNIQUE INDEX "BgpSession_global_name_key" ON public."BgpSession" USING btree (name) WHERE ("organizationId" IS NULL);
CREATE UNIQUE INDEX "Cluster_active_org_provider_without_zone_unique" ON public."Cluster" USING btree ("organizationId", provider) WHERE (("dateDeleted" IS NULL) AND ("zoneId" IS NULL));
CREATE UNIQUE INDEX "Cluster_active_org_zone_provider_unique" ON public."Cluster" USING btree ("organizationId", "zoneId", provider) WHERE (("dateDeleted" IS NULL) AND ("zoneId" IS NOT NULL));
CREATE UNIQUE INDEX "Colocation_facilityId_name_key" ON public."Colocation" USING btree ("facilityId", lower(name)) WHERE (("deletedAt" IS NULL) AND ("facilityId" IS NOT NULL));
CREATE UNIQUE INDEX "Colocation_name_without_facility_key" ON public."Colocation" USING btree (lower(name)) WHERE (("deletedAt" IS NULL) AND ("facilityId" IS NULL));
CREATE UNIQUE INDEX "ContactTag_label_key" ON public."ContactTag" USING btree (lower(label));
CREATE UNIQUE INDEX "Deployment_active_server_unique" ON public."Deployment" USING btree ("serverId") WHERE ("endDate" IS NULL);
CREATE UNIQUE INDEX "DeviceMaintenance_deviceId_active_unique" ON public."DeviceMaintenance" USING btree ("deviceId") WHERE ("disabledAt" IS NULL);
CREATE UNIQUE INDEX "Device_active_internalName_ci_unique" ON public."Device" USING btree (lower("internalName")) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Device_active_onboarding_name_unique" ON public."Device" USING btree ("organizationId", "zoneId", name) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Device_active_systemUuid_unique" ON public."Device" USING btree ("systemUuid") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "DnsDomain_active_zoneId_name_unique" ON public."DnsDomain" USING btree ("zoneId", name) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "DnsRecord_active_domainId_name_type_value_unique" ON public."DnsRecord" USING btree ("domainId", name, type, value) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Facility_name_key" ON public."Facility" USING btree (lower(name)) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Interface_active_deviceId_name_unique" ON public."Interface" USING btree ("deviceId", name) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "InterruptibleClaim_serverId_pending_unique" ON public."InterruptibleClaim" USING btree ("serverId") WHERE (status = 'Pending'::"InterruptibleClaimStatus");
CREATE INDEX "IpAddress_active_gist_idx" ON public."IpAddress" USING gist (address inet_ops) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "IpAddress_active_unique" ON public."IpAddress" USING btree ("organizationId", COALESCE("vrfId", '00000000-0000-0000-0000-000000000000'::text), address) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Organization_isInstanceOperator_key" ON public."Organization" USING btree ("isInstanceOperator") WHERE "isInstanceOperator";
CREATE UNIQUE INDEX "PrefixList_global_name_ci_key" ON public."PrefixList" USING btree (lower(name)) WHERE ("organizationId" IS NULL);
CREATE UNIQUE INDEX "PrefixList_organizationId_name_ci_key" ON public."PrefixList" USING btree ("organizationId", lower(name)) WHERE ("organizationId" IS NOT NULL);
CREATE INDEX "Prefix_active_gist_idx" ON public."Prefix" USING gist (prefix inet_ops) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Prefix_active_unique" ON public."Prefix" USING btree ("organizationId", COALESCE("vrfId", '00000000-0000-0000-0000-000000000000'::text), prefix) WHERE ("deletedAt" IS NULL);
CREATE INDEX "Prefix_dhcpMode_idx" ON public."Prefix" USING btree ("dhcpMode") WHERE ("dhcpMode" IS NOT NULL);
CREATE UNIQUE INDEX "Prefix_zone_dhcpRelayAgentIp_enabled_key" ON public."Prefix" USING btree ("zoneId", "dhcpRelayAgentIp") WHERE (("deletedAt" IS NULL) AND ("dhcpMode" IS NOT NULL) AND ("dhcpMode" <> 'OFF'::"DhcpMode") AND ("dhcpRelayAgentIp" IS NOT NULL));
CREATE UNIQUE INDEX "Tag_global_name_key" ON public."Tag" USING btree (name) WHERE ("organizationId" IS NULL);
CREATE UNIQUE INDEX "Tag_global_slug_key" ON public."Tag" USING btree (slug) WHERE ("organizationId" IS NULL);
CREATE UNIQUE INDEX "Vlan_active_unique_name" ON public."Vlan" USING btree ("organizationId", COALESCE("vrfId", '00000000-0000-0000-0000-000000000000'::text), lower(name)) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Vlan_active_unique_vid" ON public."Vlan" USING btree ("organizationId", COALESCE("vrfId", '00000000-0000-0000-0000-000000000000'::text), vid) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Vrf_active_name_organization_unique" ON public."Vrf" USING btree ("organizationId", lower(name)) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX "Vrf_active_rd_organization_unique" ON public."Vrf" USING btree ("organizationId", rd) WHERE (("deletedAt" IS NULL) AND (rd IS NOT NULL));
CREATE UNIQUE INDEX device_token_one_active_per_context ON public."DeviceToken" USING btree ("deviceId", context, COALESCE("deploymentId", '00000000-0000-0000-0000-000000000000'::text)) WHERE (status = 'ACTIVE'::"DeviceTokenStatus");
CREATE INDEX idx_changelog_diff_is_interruptible_false ON public."Changelog" USING btree (((diff ->> 'isInterruptible'::text))) WHERE (((diff ->> 'isInterruptible'::text))::boolean = false);
CREATE INDEX idx_changelog_diff_is_interruptible_true ON public."Changelog" USING btree (((diff ->> 'isInterruptible'::text))) WHERE (((diff ->> 'isInterruptible'::text))::boolean = true);
CREATE INDEX idx_changelog_diff_is_listed_false ON public."Changelog" USING btree (((diff ->> 'isListed'::text))) WHERE (((diff ->> 'isListed'::text))::boolean = false);
CREATE INDEX idx_changelog_diff_is_listed_true ON public."Changelog" USING btree (((diff ->> 'isListed'::text))) WHERE (((diff ->> 'isListed'::text))::boolean = true);
CREATE UNIQUE INDEX unique_default_project_per_org ON public."DeploymentProject" USING btree ("organizationId") WHERE (("isDefault" = true) AND ("deletedAt" IS NULL));

-- Triggers
CREATE TRIGGER changelog_trigger AFTER INSERT OR DELETE OR UPDATE ON public."Device" FOR EACH ROW EXECUTE FUNCTION changelog_trigger_func();
CREATE TRIGGER changelog_trigger AFTER INSERT OR DELETE OR UPDATE ON public."Server" FOR EACH ROW EXECUTE FUNCTION changelog_trigger_func();
CREATE TRIGGER device_role_write_once BEFORE UPDATE ON public."Device" FOR EACH ROW EXECUTE FUNCTION block_device_role_change();

-- CHECK constraints Prisma cannot express
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_exactly_one_parent" CHECK ((num_nonnulls("zoneId", "organizationId", "manufacturerId", "facilityId", "colocationId") = 1));
ALTER TABLE "Device" ADD CONSTRAINT "Device_bootFilename_len" CHECK ((("bootFilename" IS NULL) OR (char_length("bootFilename") <= 127)));
ALTER TABLE "DeviceSecretAuditEvent" ADD CONSTRAINT "DeviceSecretAuditEvent_device_or_zone_scope" CHECK ((("deviceId" IS NOT NULL) OR ("zoneId" IS NOT NULL)));
ALTER TABLE "EventLogAccessBucket" ADD CONSTRAINT "EventLogAccessBucket_hourBucket_aligned" CHECK (("hourBucket" = date_trunc('hour'::text, "hourBucket")));
ALTER TABLE "IpRange" ADD CONSTRAINT "IpRange_bounds_check" CHECK ((start <= "end"));
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_active_relay_requires_agent_ip_check" CHECK (((status IS DISTINCT FROM 'ACTIVE'::"PrefixStatus") OR ("dhcpMode" IS NULL) OR ("dhcpMode" = 'OFF'::"DhcpMode") OR ("associatedPrefixId" IS NULL) OR ("dhcpRelayAgentIp" IS NOT NULL)));
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dhcpLeaseTtlSeconds_check" CHECK ((("dhcpLeaseTtlSeconds" IS NULL) OR ("dhcpLeaseTtlSeconds" >= 120)));
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dhcpRelayAgentIp_ipv4_check" CHECK ((("dhcpRelayAgentIp" IS NULL) OR (family("dhcpRelayAgentIp") = 4)));
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dhcpRelayAgentIp_unicast_check" CHECK ((("dhcpRelayAgentIp" IS NULL) OR (("dhcpRelayAgentIp" <> '0.0.0.0'::inet) AND (NOT ("dhcpRelayAgentIp" <<= '127.0.0.0/8'::inet)) AND (NOT ("dhcpRelayAgentIp" <<= '169.254.0.0/16'::inet)) AND (NOT ("dhcpRelayAgentIp" <<= '224.0.0.0/3'::inet)))));
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dhcp_requires_zone_check" CHECK ((("dhcpMode" IS NULL) OR ("dhcpMode" = 'OFF'::"DhcpMode") OR (("zoneId" IS NOT NULL) AND (role IS DISTINCT FROM 'NAT'::"IpamRole") AND (family((prefix)::inet) = 4))));
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_dns_override_requires_zone_check" CHECK (((("dnsServeDns" IS NULL) AND ("dnsUpstreamOverride" = ARRAY[]::text[])) OR ("zoneId" IS NOT NULL)));
ALTER TABLE "PrefixListRule" ADD CONSTRAINT "PrefixListRule_action_check" CHECK ((action = ANY (ARRAY['permit'::text, 'deny'::text])));
ALTER TABLE "User" ADD CONSTRAINT "User_role_supported_check" CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text])));
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_vid_range_check" CHECK (((vid >= 2) AND (vid <= 4094)));
ALTER TABLE "VlanGroup" ADD CONSTRAINT "VlanGroup_vid_range_check" CHECK ("minVid" BETWEEN 2 AND 4094 AND "maxVid" BETWEEN 2 AND 4094 AND "minVid" <= "maxVid");
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsCacheSize_non_negative" CHECK (("dnsCacheSize" >= 0));
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsOwnedDomain_format" CHECK ((("dnsOwnedDomain" ~ '^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*$'::text) AND (length("dnsOwnedDomain") <= 253)));
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTcpIdleTimeoutMs_positive" CHECK ((("dnsTcpIdleTimeoutMs" IS NULL) OR ("dnsTcpIdleTimeoutMs" >= 1)));
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTcpMaxConnections_positive" CHECK ((("dnsTcpMaxConnections" IS NULL) OR ("dnsTcpMaxConnections" >= 1)));
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTcpMaxMessageBytes_positive" CHECK ((("dnsTcpMaxMessageBytes" IS NULL) OR ("dnsTcpMaxMessageBytes" >= 1)));
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTcpMaxQueriesPerConn_positive" CHECK ((("dnsTcpMaxQueriesPerConn" IS NULL) OR ("dnsTcpMaxQueriesPerConn" >= 1)));
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dnsTtlSeconds_non_negative" CHECK (("dnsTtlSeconds" >= 0));
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_dns_cache_ttl_ordering" CHECK ((("dnsMinCacheTtlSeconds" IS NULL) OR ("dnsMaxCacheTtlSeconds" IS NULL) OR ("dnsMinCacheTtlSeconds" <= "dnsMaxCacheTtlSeconds")));

-- Scalar-list columns are non-null by hand (Prisma emits lists nullable)
ALTER TABLE "DeviceSolConfig" ALTER COLUMN "availablePorts" SET NOT NULL;
ALTER TABLE "Prefix" ALTER COLUMN "dhcpProxyAllowedMacs" SET NOT NULL;
ALTER TABLE "Prefix" ALTER COLUMN "dnsUpstreamOverride" SET NOT NULL;
ALTER TABLE "Zone" ALTER COLUMN "dnsUpstreamResolvers" SET NOT NULL;

-- Bootstrap rows carried from migration history (rbac catalog, contact tags, platform settings)
INSERT INTO public."ContactTag" VALUES ('2df5f1b2-04e9-405b-b6ac-96f112e781ce', 'Main', 'General', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('3d4d9a13-1d7f-4fb8-9ffc-d95436f8b1de', 'Technical', 'General', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('becc2cf2-f47c-44f3-b764-bd6c6844c6c4', 'Financial', 'General', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('b8bae5dc-baa1-4d8c-b92c-a674353fbe16', 'Shipping', 'General', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('6343e25d-9488-4229-8e7d-4c55ad17a931', 'OEM – Account Manager', 'OEM', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('8da23d29-0f0c-4ad1-bd82-92ddd0c3b4c4', 'OEM – Support', 'OEM', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('6b2176ef-8c96-4350-8a39-eeafc6d87112', 'Internet Upstream', 'Connectivity', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('6f7362ef-364b-4b5a-9cc1-55b045b33aea', 'Local WAN', 'Connectivity', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('67704d5e-b9b8-43a5-bac0-5ae093c6210c', 'Integrator', 'Site', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('238592e7-b513-4317-8c41-cc736bffe58f', 'Procurement', 'Site', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."ContactTag" VALUES ('4ed189b7-0d9c-4162-9101-9b71773673f9', 'Facility Operator', 'Site', NULL, '2026-08-15 23:45:08.722', '2026-08-15 23:45:08.722');
INSERT INTO public."OrganizationMemberRole" VALUES ('9b0fb1ca-2382-423a-bcf0-6b7fa5201aa7', 'Owner', 'owner', 'Full control over the organization', true, NULL, NULL, '2026-08-15 23:45:08.654', '2026-08-15 23:45:08.654', NULL);
INSERT INTO public."OrganizationMemberRole" VALUES ('126d49ba-756f-4571-a806-ccee0eb5a44c', 'Admin', 'admin', 'Full administrative control', true, NULL, NULL, '2026-08-15 23:45:08.654', '2026-08-15 23:45:08.654', NULL);
INSERT INTO public."OrganizationMemberRole" VALUES ('51d60709-1d3c-4311-a424-1d43ce9c459c', 'Member', 'member', 'Read access to most resources, can create deployments and projects', true, NULL, NULL, '2026-08-15 23:45:08.654', '2026-08-15 23:45:08.654', NULL);
INSERT INTO public."Permission" VALUES ('d78a25c5-4f77-4c1f-ad50-8f16be492ab5', 'event-log', 'access', 'View the organization event log', '2026-08-15 23:45:08.79');
INSERT INTO public."PlatformSettings" VALUES ('singleton', NULL, NULL, '2026-08-15 23:45:08.637');
INSERT INTO public."RolePermission" VALUES ('99d75617-a0d0-4348-aee8-31d19a0bc66c', '9b0fb1ca-2382-423a-bcf0-6b7fa5201aa7', 'd78a25c5-4f77-4c1f-ad50-8f16be492ab5');
INSERT INTO public."RolePermission" VALUES ('48186bf4-3c18-4fe3-ae13-c5e10557fecf', '126d49ba-756f-4571-a806-ccee0eb5a44c', 'd78a25c5-4f77-4c1f-ad50-8f16be492ab5');

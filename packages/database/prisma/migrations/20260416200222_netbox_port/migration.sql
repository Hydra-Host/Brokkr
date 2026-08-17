/*
  Warnings:

  - A unique constraint covering the columns `[netboxId]` on the table `IpAddress` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[netboxId]` on the table `IpRange` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[netboxId]` on the table `Prefix` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[netboxId]` on the table `Vlan` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[netboxId]` on the table `Vrf` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "BgpSessionStatus" AS ENUM ('ACTIVE', 'PLANNED', 'OFFLINE', 'DECOMMISSIONING');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'PLANNED', 'STAGED', 'OFFLINE', 'FAILED', 'DECOMMISSIONING', 'MAINTENANCE', 'INVENTORY', 'PROVISIONING', 'PROVISIONED');

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
CREATE TYPE "CircuitStatus" AS ENUM ('ACTIVE', 'PLANNED', 'OFFLINE', 'DEPROVISIONING', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "CircuitTerminationSide" AS ENUM ('A', 'Z');

-- CreateEnum
CREATE TYPE "ConsolePortType" AS ENUM ('DE9', 'RJ45', 'USB_A', 'USB_C', 'USB_MINI', 'USB_MICRO', 'OTHER');

-- CreateEnum
CREATE TYPE "FirmwareType" AS ENUM ('BIOS', 'BMC', 'CPLD', 'GPU_DRIVER');

-- CreateEnum
CREATE TYPE "GpuVendor" AS ENUM ('NVIDIA', 'AMD', 'INTEL');

-- CreateEnum
CREATE TYPE "InterfaceType" AS ENUM ('ETHERNET_1G', 'ETHERNET_10G', 'ETHERNET_25G', 'ETHERNET_40G', 'ETHERNET_50G', 'ETHERNET_100G', 'ETHERNET_200G', 'ETHERNET_400G', 'ETHERNET_800G', 'INFINIBAND_FDR', 'INFINIBAND_EDR', 'INFINIBAND_HDR', 'INFINIBAND_NDR', 'INFINIBAND_XDR', 'IPMI_BMC', 'BOND', 'VIRTUAL');

-- CreateEnum
CREATE TYPE "InterfaceLinkType" AS ENUM ('INFINIBAND', 'ETHERNET');

-- CreateEnum
CREATE TYPE "InterfaceMode" AS ENUM ('ACCESS', 'TAGGED');

-- CreateEnum
CREATE TYPE "IpamRole" AS ENUM ('PRODUCTION', 'MANAGEMENT', 'STORAGE', 'CUSTOMER', 'IPMI');

-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('DDR3', 'DDR4', 'DDR5', 'LPDDR4', 'LPDDR5');

-- CreateEnum
CREATE TYPE "MemoryEccType" AS ENUM ('SINGLE_BIT_ECC', 'MULTI_BIT_ECC', 'NONE');

-- CreateEnum
CREATE TYPE "PortType" AS ENUM ('RJ45', 'FC', 'LC', 'SC', 'ST', 'MPO', 'CS', 'SN', 'OTHER');

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
CREATE TYPE "StorageDriveType" AS ENUM ('NVME', 'SSD', 'HDD');

-- CreateEnum
CREATE TYPE "TagObjectType" AS ENUM ('DEVICE', 'INTERFACE', 'PREFIX', 'VLAN', 'VRF', 'IP_ADDRESS', 'ZONE', 'CLUSTER');

-- AlterTable
ALTER TABLE "BridgeRequest" ADD COLUMN     "brokkrZoneId" TEXT;

-- AlterTable
ALTER TABLE "Cluster" ADD COLUMN     "zoneId" TEXT;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "privateIpAddressId" TEXT,
ADD COLUMN     "publicIpAddressId" TEXT;

-- AlterTable
ALTER TABLE "DeviceOnboardingProgress" ADD COLUMN     "zoneId" TEXT;

-- AlterTable
ALTER TABLE "IpAddress" ADD COLUMN     "interfaceId" TEXT,
ADD COLUMN     "netboxId" INTEGER;

-- AlterTable
ALTER TABLE "IpRange" ADD COLUMN     "netboxId" INTEGER;

-- AlterTable
ALTER TABLE "Prefix" ADD COLUMN     "netboxId" INTEGER,
ADD COLUMN     "role" "IpamRole",
ADD COLUMN     "zoneId" TEXT;

-- AlterTable
ALTER TABLE "Vlan" ADD COLUMN     "netboxId" INTEGER,
ADD COLUMN     "role" "IpamRole",
ADD COLUMN     "vlanGroupId" TEXT,
ADD COLUMN     "zoneId" TEXT;

-- AlterTable
ALTER TABLE "Vrf" ADD COLUMN     "netboxId" INTEGER;

-- AlterTable
ALTER TABLE "ZoneRequest" ADD COLUMN     "zoneId" TEXT;

-- AlterTable
ALTER TABLE "ZoneStatus" ADD COLUMN     "zoneId" TEXT;

-- CreateTable
CREATE TABLE "Asn" (
    "id" TEXT NOT NULL,
    "asn" INTEGER NOT NULL,
    "description" TEXT,
    "organizationId" TEXT,
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VlanGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minVid" INTEGER NOT NULL DEFAULT 1,
    "maxVid" INTEGER NOT NULL DEFAULT 4094,
    "zoneId" TEXT,
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BgpSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nickname" TEXT,
    "serial" TEXT,
    "status" "DeviceStatus",
    "powerStatus" TEXT DEFAULT 'Running',
    "role" "DeviceRole",
    "deviceType" "DeviceType",
    "cpuModel" TEXT,
    "cpuThreadCount" INTEGER,
    "cpuCoreCount" INTEGER,
    "cpuPhysicalCount" INTEGER,
    "memory" INTEGER,
    "nvmeSize" INTEGER,
    "nvmeCount" INTEGER,
    "ssdSize" INTEGER,
    "ssdCount" INTEGER,
    "hddSize" INTEGER,
    "hddCount" INTEGER,
    "gpuModel" TEXT,
    "gpuCount" INTEGER,
    "networkType" "DeviceNetworkType",
    "vpcCapable" BOOLEAN DEFAULT false,
    "primaryIp4" TEXT,
    "primaryIp6" TEXT,
    "ipmiIpAddress" TEXT,
    "macAddress" TEXT DEFAULT '',
    "mgmtMac" TEXT,
    "ecoMode" BOOLEAN NOT NULL DEFAULT false,
    "monitored" BOOLEAN NOT NULL DEFAULT false,
    "monitorPsk" TEXT,
    "teeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ipxeBuildTarget" TEXT,
    "ipxeBuildVersion" TEXT,
    "purgeTtys" BOOLEAN,
    "serialPorts" JSONB,
    "storageLayouts" JSONB NOT NULL DEFAULT '{}',
    "stripeProductId" TEXT,
    "defaultStripePriceId" TEXT,
    "hourlyPrice" DECIMAL(65,30),
    "floorHourlyPrice" DECIMAL(65,30),
    "floorStripePriceId" TEXT,
    "isListed" BOOLEAN NOT NULL DEFAULT false,
    "isInterruptible" BOOLEAN NOT NULL DEFAULT false,
    "zoneId" TEXT,
    "supplierId" TEXT,
    "skuId" TEXT,
    "deviceModelId" TEXT,
    "siteId" INTEGER,
    "siteName" TEXT,
    "regionName" TEXT DEFAULT '',
    "locationId" INTEGER,
    "locationName" TEXT,
    "clusterId" INTEGER,
    "clusterName" TEXT,
    "ipamConfig" JSONB,
    "virtualNetworkConfig" JSONB,
    "instanceId" TEXT,
    "lastJobId" TEXT,
    "ipmiBootDeviceOverride" TEXT,
    "netboxId" INTEGER,
    "netrisDeviceId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
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
    "netboxId" INTEGER,
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
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "comments" TEXT,
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitTermination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsolePort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ConsolePortType",
    "speed" INTEGER,
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsoleServerPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DcimRackRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DcimRackRole_pkey" PRIMARY KEY ("id")
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
    "formFactor" TEXT,
    "description" TEXT,
    "isFullDepth" BOOLEAN NOT NULL DEFAULT true,
    "heightU" INTEGER,
    "maxPowerW" INTEGER,
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceModel_pkey" PRIMARY KEY ("id")
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
    "netboxId" INTEGER,
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
    "deviceId" TEXT NOT NULL,
    "lagId" TEXT,
    "parentId" TEXT,
    "untaggedVlanId" TEXT,
    "netboxId" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Interface_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpamPrefixVlanRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1000,
    "description" TEXT,
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IpamPrefixVlanRole_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "FrontPort" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PortType" NOT NULL,
    "rearPortPosition" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "deviceId" TEXT NOT NULL,
    "rearPortId" TEXT NOT NULL,
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RearPort_pkey" PRIMARY KEY ("id")
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
    "netboxId" INTEGER,
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
    "netboxId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PowerOutlet_pkey" PRIMARY KEY ("id")
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
    "netboxId" INTEGER,
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
CREATE TABLE "StorageDrive" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StorageDriveType" NOT NULL,
    "model" TEXT,
    "serial" TEXT,
    "wwn" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageDrive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "organizationId" TEXT NOT NULL,
    "netboxId" INTEGER,
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

-- CreateIndex
CREATE UNIQUE INDEX "Asn_asn_key" ON "Asn"("asn");

-- CreateIndex
CREATE UNIQUE INDEX "Asn_netboxId_key" ON "Asn"("netboxId");

-- CreateIndex
CREATE INDEX "Asn_organizationId_idx" ON "Asn"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "VlanGroup_netboxId_key" ON "VlanGroup"("netboxId");

-- CreateIndex
CREATE INDEX "VlanGroup_zoneId_idx" ON "VlanGroup"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "BgpPeerGroup_netboxId_key" ON "BgpPeerGroup"("netboxId");

-- CreateIndex
CREATE INDEX "BgpPeerGroup_organizationId_idx" ON "BgpPeerGroup"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PrefixList_netboxId_key" ON "PrefixList"("netboxId");

-- CreateIndex
CREATE INDEX "PrefixList_organizationId_idx" ON "PrefixList"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PrefixListRule_netboxId_key" ON "PrefixListRule"("netboxId");

-- CreateIndex
CREATE INDEX "PrefixListRule_prefixListId_idx" ON "PrefixListRule"("prefixListId");

-- CreateIndex
CREATE UNIQUE INDEX "BgpSession_netboxId_key" ON "BgpSession"("netboxId");

-- CreateIndex
CREATE INDEX "BgpSession_deviceId_idx" ON "BgpSession"("deviceId");

-- CreateIndex
CREATE INDEX "BgpSession_peerGroupId_idx" ON "BgpSession"("peerGroupId");

-- CreateIndex
CREATE INDEX "BgpSession_organizationId_idx" ON "BgpSession"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_netboxId_key" ON "Device"("netboxId");

-- CreateIndex
CREATE INDEX "Device_zoneId_idx" ON "Device"("zoneId");

-- CreateIndex
CREATE INDEX "Device_netboxId_idx" ON "Device"("netboxId");

-- CreateIndex
CREATE UNIQUE INDEX "Cable_netboxId_key" ON "Cable"("netboxId");

-- CreateIndex
CREATE INDEX "CableTermination_terminationType_terminationId_idx" ON "CableTermination"("terminationType", "terminationId");

-- CreateIndex
CREATE INDEX "CableTermination_cableId_idx" ON "CableTermination"("cableId");

-- CreateIndex
CREATE UNIQUE INDEX "CableTermination_cableId_cableSide_key" ON "CableTermination"("cableId", "cableSide");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_slug_key" ON "Provider"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_netboxId_key" ON "Provider"("netboxId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderNetwork_netboxId_key" ON "ProviderNetwork"("netboxId");

-- CreateIndex
CREATE INDEX "ProviderNetwork_providerId_idx" ON "ProviderNetwork"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderNetwork_providerId_name_key" ON "ProviderNetwork"("providerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CircuitType_slug_key" ON "CircuitType"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CircuitType_netboxId_key" ON "CircuitType"("netboxId");

-- CreateIndex
CREATE UNIQUE INDEX "Circuit_netboxId_key" ON "Circuit"("netboxId");

-- CreateIndex
CREATE INDEX "Circuit_providerId_idx" ON "Circuit"("providerId");

-- CreateIndex
CREATE INDEX "Circuit_circuitTypeId_idx" ON "Circuit"("circuitTypeId");

-- CreateIndex
CREATE INDEX "Circuit_organizationId_idx" ON "Circuit"("organizationId");

-- CreateIndex
CREATE INDEX "Circuit_status_idx" ON "Circuit"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CircuitTermination_netboxId_key" ON "CircuitTermination"("netboxId");

-- CreateIndex
CREATE INDEX "CircuitTermination_circuitId_idx" ON "CircuitTermination"("circuitId");

-- CreateIndex
CREATE INDEX "CircuitTermination_zoneId_idx" ON "CircuitTermination"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "CircuitTermination_circuitId_termSide_key" ON "CircuitTermination"("circuitId", "termSide");

-- CreateIndex
CREATE UNIQUE INDEX "ConsolePort_netboxId_key" ON "ConsolePort"("netboxId");

-- CreateIndex
CREATE INDEX "ConsolePort_deviceId_idx" ON "ConsolePort"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsolePort_deviceId_name_key" ON "ConsolePort"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ConsoleServerPort_netboxId_key" ON "ConsoleServerPort"("netboxId");

-- CreateIndex
CREATE INDEX "ConsoleServerPort_deviceId_idx" ON "ConsoleServerPort"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsoleServerPort_deviceId_name_key" ON "ConsoleServerPort"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DcimRackRole_slug_key" ON "DcimRackRole"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "DcimRackRole_netboxId_key" ON "DcimRackRole"("netboxId");

-- CreateIndex
CREATE INDEX "DeviceDocument_deviceId_idx" ON "DeviceDocument"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_netboxId_key" ON "DeviceModel"("netboxId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_manufacturer_model_key" ON "DeviceModel"("manufacturer", "model");

-- CreateIndex
CREATE INDEX "DeviceFirmware_deviceId_idx" ON "DeviceFirmware"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceFirmware_type_version_idx" ON "DeviceFirmware"("type", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceFirmware_deviceId_type_key" ON "DeviceFirmware"("deviceId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Gateway_netboxId_key" ON "Gateway"("netboxId");

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
CREATE UNIQUE INDEX "Interface_netboxId_key" ON "Interface"("netboxId");

-- CreateIndex
CREATE INDEX "Interface_deviceId_idx" ON "Interface"("deviceId");

-- CreateIndex
CREATE INDEX "Interface_lagId_idx" ON "Interface"("lagId");

-- CreateIndex
CREATE INDEX "Interface_parentId_idx" ON "Interface"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Interface_deviceId_name_key" ON "Interface"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "IpamPrefixVlanRole_slug_key" ON "IpamPrefixVlanRole"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "IpamPrefixVlanRole_netboxId_key" ON "IpamPrefixVlanRole"("netboxId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryConfig_deviceId_key" ON "MemoryConfig"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "FrontPort_netboxId_key" ON "FrontPort"("netboxId");

-- CreateIndex
CREATE INDEX "FrontPort_deviceId_idx" ON "FrontPort"("deviceId");

-- CreateIndex
CREATE INDEX "FrontPort_rearPortId_idx" ON "FrontPort"("rearPortId");

-- CreateIndex
CREATE UNIQUE INDEX "FrontPort_deviceId_name_key" ON "FrontPort"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RearPort_netboxId_key" ON "RearPort"("netboxId");

-- CreateIndex
CREATE INDEX "RearPort_deviceId_idx" ON "RearPort"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "RearPort_deviceId_name_key" ON "RearPort"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PowerPort_netboxId_key" ON "PowerPort"("netboxId");

-- CreateIndex
CREATE INDEX "PowerPort_deviceId_idx" ON "PowerPort"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PowerPort_deviceId_name_key" ON "PowerPort"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PowerOutlet_netboxId_key" ON "PowerOutlet"("netboxId");

-- CreateIndex
CREATE INDEX "PowerOutlet_deviceId_idx" ON "PowerOutlet"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PowerOutlet_deviceId_name_key" ON "PowerOutlet"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Rack_netboxId_key" ON "Rack"("netboxId");

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
CREATE INDEX "StorageDrive_deviceId_idx" ON "StorageDrive"("deviceId");

-- CreateIndex
CREATE INDEX "StorageDrive_serial_idx" ON "StorageDrive"("serial");

-- CreateIndex
CREATE INDEX "StorageDrive_type_idx" ON "StorageDrive"("type");

-- CreateIndex
CREATE UNIQUE INDEX "StorageDrive_deviceId_name_key" ON "StorageDrive"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_netboxId_key" ON "Tag"("netboxId");

-- CreateIndex
CREATE INDEX "Tag_organizationId_idx" ON "Tag"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_name_key" ON "Tag"("organizationId", "name");

-- CreateIndex
CREATE INDEX "TagAssignment_objectType_objectId_idx" ON "TagAssignment"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "BridgeRequest_brokkrZoneId_idx" ON "BridgeRequest"("brokkrZoneId");

-- CreateIndex
CREATE INDEX "Cluster_zoneId_idx" ON "Cluster"("zoneId");

-- CreateIndex
CREATE INDEX "DeviceOnboardingProgress_zoneId_idx" ON "DeviceOnboardingProgress"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "IpAddress_netboxId_key" ON "IpAddress"("netboxId");

-- CreateIndex
CREATE INDEX "IpAddress_interfaceId_idx" ON "IpAddress"("interfaceId");

-- CreateIndex
CREATE UNIQUE INDEX "IpRange_netboxId_key" ON "IpRange"("netboxId");

-- CreateIndex
CREATE UNIQUE INDEX "Prefix_netboxId_key" ON "Prefix"("netboxId");

-- CreateIndex
CREATE INDEX "Prefix_zoneId_idx" ON "Prefix"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "Vlan_netboxId_key" ON "Vlan"("netboxId");

-- CreateIndex
CREATE INDEX "Vlan_zoneId_idx" ON "Vlan"("zoneId");

-- CreateIndex
CREATE INDEX "Vlan_vlanGroupId_idx" ON "Vlan"("vlanGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "Vrf_netboxId_key" ON "Vrf"("netboxId");

-- CreateIndex
CREATE INDEX "ZoneRequest_zoneId_idx" ON "ZoneRequest"("zoneId");

-- CreateIndex
CREATE INDEX "ZoneStatus_zoneId_idx" ON "ZoneStatus"("zoneId");

-- ---------------------------------------------------------------------
-- Backfill the new `Device` table from `LegacyDevice` + `DeviceMetadata`
-- so the existing `deviceId` values on downstream tables (Deployment,
-- Job, DevicesInReservation, etc.) still resolve once their FKs are
-- re-added below. UUIDs are preserved verbatim — `LegacyDevice.id`
-- becomes `Device.id`.
--
-- LEFT JOIN on DeviceMetadata: legacy devices without a metadata row
-- land in `Device` with NULLs in the hardware-spec columns rather than
-- being dropped. Name falls back to the legacy UUID if neither source
-- has a non-empty value (keeping the NOT NULL constraint satisfied).
--
-- ecoMode/teeEnabled carry NOT NULL DEFAULT false in the new schema;
-- coalesced to false when metadata is absent. `monitored` is hardcoded
-- false — no legacy analogue.
-- ---------------------------------------------------------------------
INSERT INTO "Device" (
  id,
  name,
  nickname,
  serial,
  status,
  "powerStatus",
  role,
  "deviceType",
  "cpuModel",
  "cpuThreadCount",
  "cpuCoreCount",
  "cpuPhysicalCount",
  memory,
  "nvmeSize",
  "nvmeCount",
  "ssdSize",
  "ssdCount",
  "hddSize",
  "hddCount",
  "gpuModel",
  "gpuCount",
  "networkType",
  "vpcCapable",
  "primaryIp4",
  "primaryIp6",
  "ipmiIpAddress",
  "macAddress",
  "mgmtMac",
  "ecoMode",
  "monitored",
  "teeEnabled",
  "ipxeBuildTarget",
  "ipxeBuildVersion",
  "purgeTtys",
  "serialPorts",
  "storageLayouts",
  "stripeProductId",
  "defaultStripePriceId",
  "hourlyPrice",
  "floorHourlyPrice",
  "floorStripePriceId",
  "isListed",
  "isInterruptible",
  "zoneId",
  "supplierId",
  "skuId",
  "siteId",
  "siteName",
  "regionName",
  "locationId",
  "locationName",
  "clusterId",
  "clusterName",
  "ipamConfig",
  "virtualNetworkConfig",
  "instanceId",
  "lastJobId",
  "ipmiBootDeviceOverride",
  "netboxId",
  "netrisDeviceId",
  "createdAt",
  "updatedAt"
)
SELECT
  d.id,
  COALESCE(NULLIF(d.name, ''), NULLIF(dm.name, ''), 'legacy-' || d.id),
  d.nickname,
  dm.serial,
  CASE LOWER(dm.status)
    WHEN 'active'          THEN 'ACTIVE'::"DeviceStatus"
    WHEN 'planned'         THEN 'PLANNED'::"DeviceStatus"
    WHEN 'staged'          THEN 'STAGED'::"DeviceStatus"
    WHEN 'offline'         THEN 'OFFLINE'::"DeviceStatus"
    WHEN 'failed'          THEN 'FAILED'::"DeviceStatus"
    WHEN 'decommissioning' THEN 'DECOMMISSIONING'::"DeviceStatus"
    WHEN 'maintenance'     THEN 'MAINTENANCE'::"DeviceStatus"
    WHEN 'inventory'       THEN 'INVENTORY'::"DeviceStatus"
    WHEN 'provisioning'    THEN 'PROVISIONING'::"DeviceStatus"
    WHEN 'provisioned'     THEN 'PROVISIONED'::"DeviceStatus"
    ELSE NULL
  END,
  dm."powerStatus",
  dm.role,
  d."deviceType",
  dm."cpuModel",
  dm."cpuThreadCount",
  dm."cpuCoreCount",
  dm."cpuPhysicalCount",
  dm.memory,
  dm."nvmeSize",
  dm."nvmeCount",
  dm."ssdSize",
  dm."ssdCount",
  dm."hddSize",
  dm."hddCount",
  dm."gpuModel",
  dm."gpuCount",
  dm."networkType",
  dm."vpcCapable",
  dm."primaryIp4",
  dm."primaryIp6",
  dm."ipmiIpAddress",
  COALESCE(dm."macAddress", ''),
  dm."mgmtMac",
  COALESCE(dm."ecoMode", FALSE),
  FALSE,
  COALESCE(dm."teeEnabled", FALSE),
  dm."ipxeBuildTarget",
  dm."ipxeBuildVersion",
  dm."purgeTtys",
  dm."serialPorts",
  COALESCE(d."storageLayouts", '{}'::jsonb),
  d."stripeProductId",
  d."defaultStripePriceId",
  d."hourlyPrice",
  d."floorHourlyPrice",
  d."floorStripePriceId",
  d."isListed",
  d."isInterruptible",
  d."zoneId",
  d."supplierId",
  d."skuId",
  dm."siteId",
  dm."siteName",
  COALESCE(dm."regionName", ''),
  dm."locationId",
  dm."locationName",
  dm."clusterId",
  dm."clusterName",
  dm."ipamConfig",
  dm."virtualNetworkConfig",
  dm."instanceId",
  dm."lastJobId",
  dm."ipmiBootDeviceOverride",
  dm.id,
  dm."netrisDeviceId",
  d."createdAt",
  NOW()
FROM "LegacyDevice" d
LEFT JOIN "DeviceMetadata" dm ON dm."legacyDeviceId" = d.id;

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
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeRequest" ADD CONSTRAINT "BridgeRequest_brokkrZoneId_fkey" FOREIGN KEY ("brokkrZoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "SupplierSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CableTermination" ADD CONSTRAINT "CableTermination_cableId_fkey" FOREIGN KEY ("cableId") REFERENCES "Cable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "ConsolePort" ADD CONSTRAINT "ConsolePort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsoleServerPort" ADD CONSTRAINT "ConsoleServerPort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_publicIpAddressId_fkey" FOREIGN KEY ("publicIpAddressId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_privateIpAddressId_fkey" FOREIGN KEY ("privateIpAddressId") REFERENCES "IpAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceDocument" ADD CONSTRAINT "DeviceDocument_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceDocument" ADD CONSTRAINT "DeviceDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceOperatingSystem" ADD CONSTRAINT "DeviceOperatingSystem_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePolicyConsent" ADD CONSTRAINT "DevicePolicyConsent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "InterruptibleClaim" ADD CONSTRAINT "InterruptibleClaim_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prefix" ADD CONSTRAINT "Prefix_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_vlanGroupId_fkey" FOREIGN KEY ("vlanGroupId") REFERENCES "VlanGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LenderDeviceAssociation" ADD CONSTRAINT "LenderDeviceAssociation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryConfig" ADD CONSTRAINT "MemoryConfig_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceOnboardingProgress" ADD CONSTRAINT "DeviceOnboardingProgress_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrontPort" ADD CONSTRAINT "FrontPort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrontPort" ADD CONSTRAINT "FrontPort_rearPortId_fkey" FOREIGN KEY ("rearPortId") REFERENCES "RearPort"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RearPort" ADD CONSTRAINT "RearPort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PowerPort" ADD CONSTRAINT "PowerPort_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PowerOutlet" ADD CONSTRAINT "PowerOutlet_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRackAssignment" ADD CONSTRAINT "DeviceRackAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRackAssignment" ADD CONSTRAINT "DeviceRackAssignment_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "Rack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicesInReservationInvite" ADD CONSTRAINT "DevicesInReservationInvite_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicesInReservation" ADD CONSTRAINT "DevicesInReservation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageDrive" ADD CONSTRAINT "StorageDrive_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagAssignment" ADD CONSTRAINT "TagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceHealthCheck" ADD CONSTRAINT "DeviceHealthCheck_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneRequest" ADD CONSTRAINT "ZoneRequest_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneStatus" ADD CONSTRAINT "ZoneStatus_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
